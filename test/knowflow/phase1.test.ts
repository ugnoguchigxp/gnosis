import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileQueueRepository } from '../../src/knowflow/queue/repository';
import { computeBackoffMs, decideFailureAction } from '../../src/knowflow/scheduler/policy';
import { runWorkerOnce } from '../../src/knowflow/worker/loop';

const createRepo = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'knowflow-phase1-'));
  const queueFile = join(dir, 'tasks.json');
  const repository = new FileQueueRepository(queueFile);
  return { repository, dir };
};

describe('Phase1: queue/scheduler/worker', () => {
  it('dedupes enqueue by dedupeKey for active tasks', async () => {
    const { repository, dir } = await createRepo();
    try {
      const first = await repository.enqueue({
        topic: 'TypeScript Compiler API',
        mode: 'directed',
        source: 'user',
      });

      const second = await repository.enqueue({
        topic: '  typescript   compiler api ',
        mode: 'directed',
        source: 'user',
      });

      expect(first.deduped).toBe(false);
      expect(second.deduped).toBe(true);
      expect(second.task.id).toBe(first.task.id);

      const all = await repository.list();
      expect(all).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prioritizes user tasks over cron tasks when locking', async () => {
    const { repository, dir } = await createRepo();
    try {
      await repository.enqueue({
        topic: 'cron topic',
        mode: 'expand',
        source: 'cron',
      });
      const userTask = await repository.enqueue({
        topic: 'user topic',
        mode: 'directed',
        source: 'user',
      });

      const locked = await repository.dequeueAndLock('worker-a', 1_000);
      expect(locked).not.toBeNull();
      expect(locked?.id).toBe(userTask.task.id);
      expect(locked?.status).toBe('running');
      expect(locked?.lockOwner).toBe('worker-a');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('defers failed tasks with exponential backoff', async () => {
    const { repository, dir } = await createRepo();
    try {
      await repository.enqueue({
        topic: 'retry topic',
        mode: 'explore',
        source: 'cron',
      });

      const now = 10_000;
      const result = await runWorkerOnce(
        repository,
        async () => ({ ok: false, error: 'temporary failure' }),
        {
          now: () => now,
          maxAttempts: 3,
          baseBackoffMs: 500,
        },
      );

      expect(result.processed).toBe(true);
      if (result.processed) {
        expect(result.status).toBe('deferred');
      }

      const [task] = await repository.list();
      expect(task?.attempts).toBe(1);
      expect(task?.status).toBe('deferred');
      expect(task?.errorReason).toBe('temporary failure');
      expect(task?.nextRunAt).toBe(now + 500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('marks task failed when maxAttempts is reached', async () => {
    const { repository, dir } = await createRepo();
    try {
      const enqueued = await repository.enqueue({
        topic: 'terminal failure',
        mode: 'directed',
        source: 'user',
      });

      const locked = await repository.dequeueAndLock('worker-x', 0);
      expect(locked?.id).toBe(enqueued.task.id);
      if (!locked) {
        throw new Error('Failed to lock task');
      }

      const action = decideFailureAction(locked, 'fatal', {
        now: 1_000,
        maxAttempts: 1,
      });
      expect(action.kind).toBe('fail');

      await repository.applyFailureAction(locked.id, action, 1_000);
      const [task] = await repository.list();
      expect(task?.status).toBe('failed');
      expect(task?.attempts).toBe(1);
      expect(task?.nextRunAt).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backoff has cap', () => {
    expect(computeBackoffMs(1, 1_000, 5_000)).toBe(1_000);
    expect(computeBackoffMs(2, 1_000, 5_000)).toBe(2_000);
    expect(computeBackoffMs(3, 1_000, 5_000)).toBe(4_000);
    expect(computeBackoffMs(4, 1_000, 5_000)).toBe(5_000);
    expect(computeBackoffMs(8, 1_000, 5_000)).toBe(5_000);
  });
});
