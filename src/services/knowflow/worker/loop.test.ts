import { describe, expect, it, mock, spyOn } from 'bun:test';
import { runWorkerOnce, runWorkerLoop } from './loop.js';
import type { TopicTask } from '../domain/task.js';
import type { QueueRepository } from '../queue/repository.js';

describe('worker loop', () => {
  const mockTask: TopicTask = {
    id: 'test-1',
    topic: 'test',
    mode: 'directed',
    source: 'user',
    priority: 10,
    status: 'pending',
    attempts: 0,
    dedupeKey: 'test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const mockRepo = (): QueueRepository => ({
    enqueue: mock(),
    list: mock(),
    dequeueAndLock: mock(),
    markDone: mock(),
    applyFailureAction: mock(),
    clearStaleTasks: mock(),
  });

  it('runWorkerOnce should handle successful task', async () => {
    const repo = mockRepo();
    repo.dequeueAndLock = mock().mockResolvedValue(mockTask);
    repo.markDone = mock().mockResolvedValue({ ...mockTask, status: 'done' });

    const handler = mock().mockResolvedValue({ ok: true, summary: 'done' });
    const result = await runWorkerOnce(repo, handler);

    expect(result.processed).toBe(true);
    if (result.processed) {
      expect(result.status).toBe('done');
    }
    expect(handler).toHaveBeenCalled();
    expect(repo.markDone).toHaveBeenCalled();
  });

  it('runWorkerOnce should handle timeout', async () => {
    const repo = mockRepo();
    repo.dequeueAndLock = mock().mockResolvedValue(mockTask);
    repo.applyFailureAction = mock().mockResolvedValue({ ...mockTask, status: 'deferred' });

    // Handler that takes too long
    const handler = async (task: any, signal: AbortSignal) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ok: true };
    };

    const result = await runWorkerOnce(repo, handler, { taskTimeoutMs: 10 });

    expect(result.processed).toBe(true);
    if (result.processed) {
      expect(result.status).toBe('deferred');
      expect(result.error).toContain('timed out');
    }
    expect(repo.applyFailureAction).toHaveBeenCalled();
  });

  it('runWorkerLoop should trigger circuit breaker on consecutive errors', async () => {
    const repo = mockRepo();
    repo.dequeueAndLock = mock().mockResolvedValue(mockTask);
    repo.applyFailureAction = mock().mockResolvedValue({ ...mockTask, status: 'deferred' });

    const logger = mock();
    const handler = mock().mockResolvedValue({ ok: false, error: 'fail' });

    // Run 6 times (maxConsecutiveErrors = 5)
    await runWorkerLoop(repo, handler, {
      maxIterations: 6,
      maxConsecutiveErrors: 5,
      intervalMs: 1,
      logger,
    });

    // Check if circuit breaker event was logged
    const calls = logger.mock.calls;
    const circuitBreakEvent = calls.find((c: any) => c[0].event === 'worker.loop.circuit_break');
    expect(circuitBreakEvent).toBeDefined();
    expect(circuitBreakEvent[0].consecutiveErrors).toBe(5);
  });
});
