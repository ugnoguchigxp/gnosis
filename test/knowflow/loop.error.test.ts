import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { TopicTask } from '../../src/services/knowflow/domain/task.js';
import type { QueueRepository } from '../../src/services/knowflow/queue/repository.js';
import { runWorkerOnce } from '../../src/services/knowflow/worker/loop.js';

describe('KnowFlow runWorkerOnce error handling', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mock
  let mockRepository: any;

  beforeEach(() => {
    mockRepository = {
      dequeueAndLock: mock(
        async () =>
          ({
            id: 'task-1',
            topic: 'test',
            mode: 'directed',
            source: 'user',
            attempts: 0,
          }) as unknown as TopicTask,
      ),
      markDone: mock(async () => {}),
      applyFailureAction: mock(async () => {}),
    };
  });

  it('captures stack trace when handler throws an error', async () => {
    const errorWithStack = new Error('critical failure');
    const mockHandler = mock(async () => {
      throw errorWithStack;
    });

    await runWorkerOnce(mockRepository as unknown as QueueRepository, mockHandler, {
      workerId: 'w1',
      logger: () => {}, // suppress logs
    });

    expect(mockRepository.applyFailureAction).toHaveBeenCalled();
    const [taskId, action] = mockRepository.applyFailureAction.mock.calls[0];

    expect(taskId).toBe('task-1');
    expect(action.errorReason).toContain('critical failure');
    // stack trace が含まれていることを確認
    expect(action.errorReason).toContain('at ');
    expect(action.errorReason).toContain('loop.error.test.ts');
  });

  it('handles result failure with error message', async () => {
    const mockHandler = mock(async () => ({
      ok: false,
      error: 'logic error',
    }));

    await runWorkerOnce(mockRepository as unknown as QueueRepository, mockHandler, {
      workerId: 'w1',
      logger: () => {},
    });

    expect(mockRepository.applyFailureAction).toHaveBeenCalled();
    const [, action] = mockRepository.applyFailureAction.mock.calls[0];
    expect(action.errorReason).toBe('logic error');
  });
});
