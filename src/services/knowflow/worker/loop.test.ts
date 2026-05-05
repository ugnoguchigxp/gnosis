import { describe, expect, it, mock } from 'bun:test';
import type { TopicTask } from '../domain/task.js';
import type { QueueRepository } from '../queue/repository.js';
import { defaultTaskHandler, runWorkerLoop, runWorkerOnce } from './loop.js';

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
    clearOrphanedRunningTasks: mock(),
  });

  const noSleep = async () => {};

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
    repo.applyFailureAction = mock().mockResolvedValue({ ...mockTask, status: 'failed' });

    let capturedSignal: AbortSignal | undefined;
    const handler = mock(async (_task: TopicTask, signal?: AbortSignal) => {
      capturedSignal = signal;
      return await new Promise<{ ok: true }>(() => {});
    });

    const result = await runWorkerOnce(repo, handler, {
      taskTimeoutMs: 10,
      createTaskTimeout: (timeoutMs, abortController) => ({
        promise: Promise.resolve().then(() => {
          abortController.abort();
          return {
            ok: false as const,
            error: `Task execution timed out after ${timeoutMs}ms`,
            retryable: false,
          };
        }),
        cancel: () => {},
      }),
    });

    expect(result.processed).toBe(true);
    if (result.processed) {
      expect(result.status).toBe('failed');
      expect(result.error).toContain('timed out');
    }
    expect(capturedSignal?.aborted).toBe(true);
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
      postTaskDelayMs: 1,
      logger,
      sleep: noSleep,
    });

    // Check if circuit breaker event was logged
    const calls = logger.mock.calls;
    const circuitBreakEvent = calls.find(
      (c) => (c[0] as { event: string }).event === 'worker.loop.circuit_break',
    );
    expect(circuitBreakEvent).toBeDefined();
    if (circuitBreakEvent) {
      expect(circuitBreakEvent[0].consecutiveErrors).toBe(5);
    }
  });

  it('runWorkerOnce returns processed=false when queue is empty', async () => {
    const repo = mockRepo();
    repo.dequeueAndLock = mock().mockResolvedValue(null);
    const logger = mock();

    const result = await runWorkerOnce(repo, undefined, { logger });

    expect(result.processed).toBe(false);
    const emptyEvents = (logger.mock.calls as { event: string }[][]).filter(
      (c) => c[0]?.event === 'task.dequeue.empty',
    );
    expect(emptyEvents.length).toBeGreaterThan(0);
  });

  it('runWorkerOnce handles handler that throws exception', async () => {
    const repo = mockRepo();
    repo.dequeueAndLock = mock().mockResolvedValue(mockTask);
    repo.applyFailureAction = mock().mockResolvedValue({ ...mockTask, status: 'deferred' });

    const handler = mock().mockRejectedValue(new Error('unexpected crash'));

    const result = await runWorkerOnce(repo, handler, { maxAttempts: 1 });

    expect(result.processed).toBe(true);
    if (result.processed) {
      expect(result.error).toContain('unexpected crash');
    }
    expect(repo.applyFailureAction).toHaveBeenCalled();
  });

  it('defaultTaskHandler returns ok=true with summary', async () => {
    const result = await defaultTaskHandler(mockTask);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain(mockTask.topic);
    }
  });

  it('runWorkerLoop resets consecutiveErrors on successful task', async () => {
    const repo = mockRepo();
    repo.dequeueAndLock = mock().mockResolvedValue(mockTask);
    repo.markDone = mock().mockResolvedValue({ ...mockTask, status: 'done' });
    repo.applyFailureAction = mock().mockResolvedValue({ ...mockTask, status: 'deferred' });

    const logger = mock();
    let callCount = 0;
    // First two fail, then succeed, then fail again - circuit breaker should not trigger
    const handler = mock().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 3) return { ok: true as const, summary: 'done' };
      return { ok: false as const, error: 'fail' };
    });

    await runWorkerLoop(repo, handler, {
      maxIterations: 5,
      maxConsecutiveErrors: 3,
      intervalMs: 1,
      postTaskDelayMs: 1,
      logger,
      sleep: noSleep,
    });

    const circuitBreakEvent = (logger.mock.calls as { event: string }[][]).find(
      (c) => c[0]?.event === 'worker.loop.circuit_break',
    );
    // With success at 3rd call, consecutive errors reset, so circuit breaker should not fire
    expect(circuitBreakEvent).toBeUndefined();
  });

  it('runWorkerLoop handles critical error from runWorkerOnce', async () => {
    const repo = mockRepo();
    repo.dequeueAndLock = mock().mockRejectedValue(new Error('db connection lost'));

    const logger = mock();

    await runWorkerLoop(repo, undefined, {
      maxIterations: 1,
      intervalMs: 1,
      postTaskDelayMs: 1,
      logger,
      sleep: noSleep,
    });

    const criticalEvents = (logger.mock.calls as { event: string }[][]).filter(
      (c) => c[0]?.event === 'worker.loop.critical_error',
    );
    expect(criticalEvents.length).toBeGreaterThan(0);
  });

  it('runWorkerLoop sleeps when no task is available', async () => {
    const repo = mockRepo();
    repo.dequeueAndLock = mock().mockResolvedValue(null);
    const logger = mock();

    await runWorkerLoop(repo, undefined, {
      maxIterations: 2,
      intervalMs: 1,
      postTaskDelayMs: 1,
      logger,
      sleep: noSleep,
    });

    const emptyEvents = (logger.mock.calls as { event: string }[][]).filter(
      (c) => c[0]?.event === 'task.dequeue.empty',
    );
    expect(emptyEvents.length).toBe(2);
  });
});
