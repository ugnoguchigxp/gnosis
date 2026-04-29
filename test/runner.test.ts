import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { processQueue, runTask } from '../src/services/background/runner.js';

// Mock worker functions
const mockEmbedding = mock(async () => ({ processed: 0 }));
const mockSynthesis = mock(async () => ({
  processedMemories: 0,
  extractedEntities: 0,
  extractedRelations: 0,
  failedCount: 0,
}));
const mockRunWorkerOnce = mock(async (): Promise<unknown> => ({ processed: false }));
const mockRecordBackgroundTaskRun = mock(async () => {});
const mockRunKeywordSeederOnce = mock(async () => ({
  runId: '00000000-0000-4000-8000-000000000000',
  aliasUsed: 'gemma4',
  threshold: 6.5,
  sources: 0,
  evaluated: 0,
  enqueued: 0,
  skipped: 0,
  deduped: 0,
  sourceFailures: 0,
}));
const mockEnqueueFrontierCandidates = mock(async () => ({
  candidates: [{ entityId: 'rule/test', name: 'Test rule', type: 'rule', score: 0.9 }],
  enqueued: 1,
  deduped: 0,
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

mock.module('../src/utils/lock.js', () => ({
  withGlobalSemaphore: mock(
    async (_n: unknown, _m: unknown, fn: () => Promise<unknown>) => await fn(),
  ),
  withGlobalLock: mock(async (_n: unknown, fn: () => Promise<unknown>) => await fn()),
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
      frontier: {
        enabled: true,
        llmEnabled: true,
        maxTopics: 5,
        scanLimit: 300,
        maxPerCommunity: 2,
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
      runKeywordSeederOnce: mockRunKeywordSeederOnce,
      enqueueFrontierCandidates: mockEnqueueFrontierCandidates,
      recordBackgroundTaskRun: mockRecordBackgroundTaskRun,
    };

    mockEmbedding.mockClear();
    mockSynthesis.mockClear();
    mockRunWorkerOnce.mockClear();
    mockRecordBackgroundTaskRun.mockClear();
    mockRunKeywordSeederOnce.mockClear();
    mockEnqueueFrontierCandidates.mockClear();
  });

  afterAll(() => {
    mock.restore();
  });

  describe('runTask', () => {
    it('executes embedding_batch task', async () => {
      const outcome = await runTask('embedding_batch', { batchSize: 10 }, testDeps);
      expect(mockEmbedding).toHaveBeenCalledWith(10);
      expect(outcome.ok).toBe(true);
    });

    it('executes knowflow task via DI', async () => {
      mockRunWorkerOnce.mockResolvedValueOnce({
        processed: true,
        taskId: 'k1',
        status: 'done',
      });
      const outcome = await runTask('knowflow', {}, testDeps);
      expect(mockRunWorkerOnce).toHaveBeenCalled();
      expect(outcome.ok).toBe(true);
    });

    it('executes knowflow_keyword_seed task', async () => {
      const outcome = await runTask('knowflow_keyword_seed', {}, testDeps);
      expect(mockRunKeywordSeederOnce).toHaveBeenCalled();
      expect(outcome.ok).toBe(true);
    });

    it('executes knowflow_frontier_seed task', async () => {
      const outcome = await runTask('knowflow_frontier_seed', {}, testDeps);
      expect(mockEnqueueFrontierCandidates).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 5,
          scanLimit: 300,
          maxPerCommunity: 2,
          useLlm: true,
          requestedBy: 'background-frontier-seed',
        }),
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.processed).toBe(true);
    });

    it('throws error for unknown task', async () => {
      await expect(runTask('unknown', {}, testDeps)).rejects.toThrow('Unknown task type: unknown');
    });
  });

  describe('processQueue', () => {
    it('processes tasks until empty', async () => {
      const task = { id: '1', type: 'synthesis', payload: '{}' };
      mockScheduler.dequeueTask
        .mockReturnValueOnce(task) // First iteration
        .mockReturnValueOnce(null); // Second iteration (stop)

      // biome-ignore lint/suspicious/noExplicitAny: mock
      await processQueue(mockScheduler as any, testDeps as any);

      expect(mockScheduler.dequeueTask).toHaveBeenCalledTimes(2);
      expect(mockSynthesis).toHaveBeenCalled();
      expect(mockRecordBackgroundTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({ taskType: 'synthesis', ok: true }),
      );
    });

    it('handles task failure and sets retry with stack trace', async () => {
      const task = { id: '1', type: 'synthesis', payload: '{}' };
      mockScheduler.dequeueTask.mockReturnValueOnce(task).mockReturnValueOnce(null);
      mockSynthesis.mockRejectedValueOnce(new Error('Test error'));

      // biome-ignore lint/suspicious/noExplicitAny: mock
      await processQueue(mockScheduler as any, testDeps as any);

      expect(mockScheduler.updateTaskStatus).toHaveBeenCalledWith(
        '1',
        'failed',
        expect.stringMatching(/Test error/),
        expect.any(Number),
      );
      expect(mockRecordBackgroundTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({ taskType: 'synthesis', ok: false }),
      );
    });

    it('marks task failed when knowflow outcome is deferred', async () => {
      const task = { id: '1', type: 'knowflow', payload: '{}' };
      mockScheduler.dequeueTask.mockReturnValueOnce(task).mockReturnValueOnce(null);
      mockRunWorkerOnce.mockResolvedValueOnce({
        processed: true,
        taskId: 'k-deferred',
        status: 'deferred',
        error: 'retry later',
      });

      // biome-ignore lint/suspicious/noExplicitAny: mock
      await processQueue(mockScheduler as any, testDeps as any);

      expect(mockScheduler.updateTaskStatus).toHaveBeenCalledWith(
        '1',
        'failed',
        expect.stringMatching(/Task outcome failed/),
        expect.any(Number),
      );
    });
  });
});
