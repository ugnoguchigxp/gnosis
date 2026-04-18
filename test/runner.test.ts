import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { processQueue, runTask } from '../src/services/background/runner.js';

// Mock worker functions
const mockConsolidation = mock(async () => {});
const mockEmbedding = mock(async () => {});
const mockSynthesis = mock(async () => {});
const mockRunWorkerOnce = mock(async () => {});

mock.module('../src/services/background/tasks/consolidationTask.js', () => ({
  consolidationTask: mockConsolidation,
}));
mock.module('../src/services/background/tasks/embeddingBatchTask.js', () => ({
  embeddingBatchTask: mockEmbedding,
}));
mock.module('../src/services/background/tasks/synthesisTask.js', () => ({
  synthesisTask: mockSynthesis,
}));

// Mock adapters to avoid side effects and path errors
mock.module('../src/adapters/retriever/mcpRetriever.js', () => ({
  createLocalLlmRetriever: mock(() => ({})),
}));

mock.module('../src/config.js', () => ({
  config: {
    embeddingDimension: 384,
    llm: { maxBuffer: 1024 * 1024, defaultTimeoutMs: 5000 },
    backgroundWorker: {
      maxConcurrency: 1,
    },
    knowflow: {
      budget: { userBudget: 12, cronBudget: 6, cronRunBudget: 30 },
      worker: {
        maxQueriesPerTask: 3,
        cronRunWindowMs: 3600000,
      },
      llm: {
        timeoutMs: 5000,
      },
    },
    localLlmPath: '/tmp/local-llm',
  },
}));

describe('background runner', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mock
  let mockScheduler: any;
  // biome-ignore lint/suspicious/noExplicitAny: mock
  let mockDb: any;
  // biome-ignore lint/suspicious/noExplicitAny: mock
  let testDeps: any;

  beforeEach(() => {
    mockScheduler = {
      cleanupStaleTasks: mock(() => {}),
      getRunningTaskCount: mock(() => 0),
      dequeueTask: mock(() => null),
      updateTaskStatus: mock(() => {}),
      deleteTask: mock(() => {}),
    };
    mockDb = {
      // biome-ignore lint/suspicious/noExplicitAny: mock
      transaction: mock(async (callback: any) => callback({})),
    };
    testDeps = {
      database: mockDb,
      runWorkerOnce: mockRunWorkerOnce,
    };

    mockConsolidation.mockClear();
    mockEmbedding.mockClear();
    mockSynthesis.mockClear();
    mockRunWorkerOnce.mockClear();
  });

  describe('runTask', () => {
    it('executes consolidation task', async () => {
      await runTask('consolidation', {}, testDeps);
      expect(mockConsolidation).toHaveBeenCalled();
    });

    it('executes embedding_batch task', async () => {
      await runTask('embedding_batch', { batchSize: 10 }, testDeps);
      expect(mockEmbedding).toHaveBeenCalledWith(10);
    });

    it('executes knowflow task via DI', async () => {
      await runTask('knowflow', {}, testDeps);
      expect(mockRunWorkerOnce).toHaveBeenCalled();
    });

    it('throws error for unknown task', async () => {
      await expect(runTask('unknown', {}, testDeps)).rejects.toThrow('Unknown task type: unknown');
    });
  });

  describe('processQueue', () => {
    it('processes tasks until empty', async () => {
      const task = { id: '1', type: 'consolidation', payload: '{}' };
      mockScheduler.dequeueTask
        .mockReturnValueOnce(task) // First iteration
        .mockReturnValueOnce(null); // Second iteration (stop)

      // biome-ignore lint/suspicious/noExplicitAny: mock
      await processQueue(mockScheduler as any, testDeps as any);

      expect(mockScheduler.dequeueTask).toHaveBeenCalledTimes(2);
      expect(mockConsolidation).toHaveBeenCalled();
    });

    it('handles task failure and sets retry with stack trace', async () => {
      const task = { id: '1', type: 'consolidation', payload: '{}' };
      mockScheduler.dequeueTask.mockReturnValueOnce(task).mockReturnValueOnce(null);
      mockConsolidation.mockRejectedValueOnce(new Error('Test error'));

      // biome-ignore lint/suspicious/noExplicitAny: mock
      await processQueue(mockScheduler as any, testDeps as any);

      expect(mockScheduler.updateTaskStatus).toHaveBeenCalledWith(
        '1',
        'failed',
        expect.stringMatching(/Test error/),
        expect.any(Number),
      );
    });
  });
});
