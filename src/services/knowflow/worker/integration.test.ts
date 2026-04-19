import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { topicTasks } from '../../../db/schema.js';
import type { TopicTask } from '../domain/task.js';
import { PgJsonbQueueRepository } from '../queue/pgJsonbRepository.js';
import type { TaskExecutionResult } from './loop.js';
import { runWorkerOnce } from './loop.js';

describe.skip('worker integration', () => {
  const repository = new PgJsonbQueueRepository(db);

  beforeAll(async () => {
    // テストデータのクリーンアップ
    await db.delete(topicTasks);
  });

  afterAll(async () => {
    await db.delete(topicTasks);
  });

  it('full cycle: enqueue -> dequeue -> process -> done', async () => {
    const topic = 'integration-test-topic';
    const { task: enqueued } = await repository.enqueue({
      topic,
      mode: 'directed',
      source: 'user',
      priority: 10,
    });

    expect(enqueued.status).toBe('pending');

    // ワーカー実行 (handler は即座に成功を返す)
    const handler = async () => ({ ok: true as const, summary: 'success' });
    const result = await runWorkerOnce(repository, handler, { workerId: 'test-worker' });

    expect(result.processed).toBe(true);
    if (result.processed) {
      expect(result.status).toBe('done');
    }

    // DBの状態確認
    const rows = await db.select().from(topicTasks).where(eq(topicTasks.id, enqueued.id));
    expect(rows[0].status).toBe('done');
  });

  it('timeout handling: should defer and abort handler', async () => {
    const topic = 'timeout-test-topic';
    const { task: enqueued } = await repository.enqueue({
      topic,
      mode: 'directed',
      source: 'user',
      priority: 20,
    });

    let handlerAborted = false;
    const slowHandler = async (
      _task: TopicTask,
      signal?: AbortSignal,
    ): Promise<TaskExecutionResult> => {
      return new Promise<TaskExecutionResult>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ ok: true, summary: 'too late' });
        }, 1000);

        signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          handlerAborted = true;
          resolve({ ok: false, error: 'aborted' });
        });
      });
    };

    // 非常に短いタイムアウトで実行
    const result = await runWorkerOnce(repository, slowHandler, {
      workerId: 'timeout-worker',
      taskTimeoutMs: 10,
    });

    expect(result.processed).toBe(true);
    if (result.processed) {
      expect(result.status).toBe('deferred');
    }
    expect(handlerAborted).toBe(true);

    // DBの状態確認 (deferred になっていること)
    const rows = await db.select().from(topicTasks).where(eq(topicTasks.id, enqueued.id));
    expect(rows[0].status).toBe('deferred');
    expect(rows[0].nextRunAt).toBeGreaterThan(Date.now());
  });
});
