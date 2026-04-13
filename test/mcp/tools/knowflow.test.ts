import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('../../../src/config.js', () => ({
  config: {
    embedCommand: 'mock-embed',
    embedTimeoutMs: 1000,
    embeddingDimension: 3,
    dedupeThreshold: 0.9,
    llmTimeoutMs: 90_000,
    claudeLogDir: '/tmp/claude',
    antigravityLogDir: '/tmp/antigravity',
    localLlmPath: '/tmp/local-llm',
    synthesisBatchSize: 10,
    memory: { retries: 1, retryWaitMultiplier: 0.01 },
    graph: { similarityThreshold: 0.8, maxPathHops: 5 },
    knowflow: {
      llm: {
        apiBaseUrl: 'http://localhost:44448',
        apiPath: '/v1/chat/completions',
        apiKeyEnv: 'LOCAL_LLM_API_KEY',
        model: 'test-model',
        temperature: 0,
        timeoutMs: 5000,
        maxRetries: 1,
        retryDelayMs: 0,
        enableCliFallback: true,
        cliCommand: 'echo',
        cliPromptMode: 'arg',
        cliPromptPlaceholder: '{{prompt}}',
      },
      worker: {
        taskTimeoutMs: 5000,
        pollIntervalMs: 1000,
        postTaskDelayMs: 0,
        maxConsecutiveErrors: 3,
        maxQueriesPerTask: 3,
        cronRunWindowMs: 3_600_000,
      },
      budget: { userBudget: 12, cronBudget: 6, cronRunBudget: 30 },
      healthCheck: { timeoutMs: 5000 },
    },
    guidance: {
      inboxDir: '/tmp/guidance-inbox',
      sessionId: 'test-guidance',
      maxFilesPerZip: 500,
      maxZipSizeBytes: 50_000_000,
      maxChunkChars: 2000,
      maxFileChars: 120_000,
      priorityHigh: 100,
      priorityMid: 80,
      priorityLow: 50,
      maxZips: 1000,
      alwaysLimit: 4,
      onDemandLimit: 5,
      maxPromptChars: 3000,
      minSimilarity: 0.72,
      enabled: true,
      project: undefined,
    },
    llm: { maxBuffer: 10 * 1024 * 1024, defaultTimeoutMs: 45_000 },
  },
}));

const mockEnqueue = mock();
const mockDequeueAndLock = mock();
const mockMarkDone = mock();
const mockApplyFailureAction = mock();
mock.module('../../../src/services/knowflow/queue/pgJsonbRepository.js', () => ({
  PgJsonbQueueRepository: class {
    enqueue = mockEnqueue;
    dequeueAndLock = mockDequeueAndLock;
    markDone = mockMarkDone;
    applyFailureAction = mockApplyFailureAction;
    list = mock();
    clearStaleTasks = mock();
  },
}));

const mockKnowledgeRepoInstance = { getByTopic: mock(), merge: mock() };
mock.module('../../../src/services/knowflow/knowledge/repository.js', () => ({
  PgKnowledgeRepository: class {
    getByTopic = mockKnowledgeRepoInstance.getByTopic;
    merge = mockKnowledgeRepoInstance.merge;
  },
}));

const mockCreateLocalLlmRetriever = mock();
mock.module('../../../src/adapters/retriever/mcpRetriever.js', () => ({
  createLocalLlmRetriever: mockCreateLocalLlmRetriever,
}));

const mockCreateMcpEvidenceProvider = mock();
const mockCreateKnowFlowTaskHandler = mock();
mock.module('../../../src/services/knowflow/worker/knowFlowHandler.js', () => ({
  createMcpEvidenceProvider: mockCreateMcpEvidenceProvider,
  createKnowFlowTaskHandler: mockCreateKnowFlowTaskHandler,
}));

import { knowflowTools } from '../../../src/mcp/tools/knowflow.js';

const getHandler = (name: string) => {
  const tool = knowflowTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool.handler;
};

const makeMockTask = () => ({
  id: 'task-xyz',
  topic: 'TypeScript',
  mode: 'directed' as const,
  source: 'user' as const,
  priority: 50,
  status: 'pending' as const,
  attempts: 0,
  dedupeKey: 'typescript',
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

describe('knowflow MCP tools', () => {
  beforeEach(() => {
    mockEnqueue.mockReset();
    mockDequeueAndLock.mockReset();
    mockMarkDone.mockReset();
    mockApplyFailureAction.mockReset();
    mockCreateLocalLlmRetriever.mockReset();
    mockCreateMcpEvidenceProvider.mockReset();
    mockCreateKnowFlowTaskHandler.mockReset();
    mockKnowledgeRepoInstance.getByTopic.mockReset();
    mockKnowledgeRepoInstance.merge.mockReset();
  });

  afterEach(() => {
    mockEnqueue.mockReset();
    mockDequeueAndLock.mockReset();
    mockMarkDone.mockReset();
    mockApplyFailureAction.mockReset();
    mockCreateLocalLlmRetriever.mockReset();
    mockCreateMcpEvidenceProvider.mockReset();
    mockCreateKnowFlowTaskHandler.mockReset();
  });

  describe('enqueue_knowledge_task', () => {
    it('enqueues a task and returns taskId and deduped status', async () => {
      mockEnqueue.mockResolvedValue({
        task: { id: 'task-abc', topic: 'TypeScript' },
        deduped: false,
      });

      const handler = getHandler('enqueue_knowledge_task');
      const result = await handler({ topic: 'TypeScript', mode: 'directed', priority: 70 });

      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      // biome-ignore lint/suspicious/noExplicitAny: mock
      const callArg = (mockEnqueue.mock.calls as any)[0][0];
      expect(callArg.topic).toBe('TypeScript');
      expect(callArg.mode).toBe('directed');
      expect(callArg.source).toBe('user');

      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('task-abc');
      expect(text).toContain('deduped: false');
    });

    it('reports deduped=true when task already exists', async () => {
      mockEnqueue.mockResolvedValue({
        task: { id: 'existing-task', topic: 'Python' },
        deduped: true,
      });

      const handler = getHandler('enqueue_knowledge_task');
      const result = await handler({ topic: 'Python' });

      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('deduped: true');
    });
  });

  describe('run_knowledge_worker', () => {
    it('returns task processed message when task is processed', async () => {
      const mockTask = makeMockTask();
      mockDequeueAndLock.mockResolvedValue(mockTask);
      mockMarkDone.mockResolvedValue({ ...mockTask, status: 'done' });

      const mockRetriever = { search: mock(), fetch: mock() };
      mockCreateLocalLlmRetriever.mockReturnValue(mockRetriever);
      const mockEvidenceProvider = mock();
      mockCreateMcpEvidenceProvider.mockReturnValue(mockEvidenceProvider);
      const mockTaskHandler = mock().mockResolvedValue({ ok: true, summary: 'done' });
      mockCreateKnowFlowTaskHandler.mockReturnValue(mockTaskHandler);

      const handler = getHandler('run_knowledge_worker');
      const result = await handler({ maxAttempts: 1 });

      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('task-xyz');
      expect(text).toContain('done');
    });

    it('returns no pending tasks message when queue is empty', async () => {
      mockDequeueAndLock.mockResolvedValue(null);

      const mockRetriever = { search: mock(), fetch: mock() };
      mockCreateLocalLlmRetriever.mockReturnValue(mockRetriever);
      mockCreateMcpEvidenceProvider.mockReturnValue(mock());
      mockCreateKnowFlowTaskHandler.mockReturnValue(mock());

      const handler = getHandler('run_knowledge_worker');
      const result = await handler({});

      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('No pending tasks');
    });
  });
});
