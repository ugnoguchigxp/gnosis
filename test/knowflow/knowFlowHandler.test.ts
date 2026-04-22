import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('../../src/config.js', () => ({
  config: {
    knowflow: {
      budget: { userBudget: 12, cronBudget: 6, cronRunBudget: 30 },
      worker: {
        maxQueriesPerTask: 3,
        cronRunWindowMs: 3600000,
      },
    },
  },
}));

import { config } from '../../src/config.js';
import type { TopicTask } from '../../src/services/knowflow/domain/task.js';
import {
  createKnowFlowTaskHandler,
  createMcpEvidenceProvider,
} from '../../src/services/knowflow/worker/knowFlowHandler.js';

const makeTask = (overrides: Partial<TopicTask> = {}): TopicTask => ({
  id: 'task-1',
  topic: 'TypeScript',
  mode: 'directed',
  source: 'user',
  priority: 50,
  status: 'pending',
  attempts: 0,
  dedupeKey: 'typescript',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

const makeRepo = () => ({
  getByTopic: mock().mockResolvedValue(null),
  merge: mock().mockResolvedValue({
    knowledge: { id: 'k1', canonicalTopic: 'typescript', claims: [], relations: [], sources: [] },
    changed: true,
  }),
});

describe('createMcpEvidenceProvider', () => {
  const mockRunLlmTask = mock();
  const mockExtractEvidence = mock();

  beforeEach(() => {
    mockRunLlmTask.mockReset();
    mockExtractEvidence.mockReset();
  });

  afterEach(() => {
    mockRunLlmTask.mockReset();
    mockExtractEvidence.mockReset();
  });

  it('returns empty evidence when LLM is degraded', async () => {
    mockRunLlmTask.mockResolvedValue({
      degraded: true,
      output: { queries: [] },
    });

    const retriever = { search: mock(), fetch: mock(), disconnect: mock() };
    const provider = createMcpEvidenceProvider(retriever, {
      runLlmTask: mockRunLlmTask,
      extractEvidence: mockExtractEvidence,
    });
    const evidence = await provider(makeTask());

    expect(evidence.claims).toHaveLength(0);
    expect(evidence.sources).toHaveLength(0);
    expect(evidence.queryCountUsed).toBe(0);
    expect(retriever.search).not.toHaveBeenCalled();
  });

  it.skip('searches and fetches URLs when LLM returns queries', async () => {
    mockRunLlmTask.mockResolvedValue({
      degraded: false,
      output: { queries: ['TypeScript typing'] },
    });

    const mockClaim = { text: 'TS is typed', confidence: 0.9, sourceIds: ['src-1'] };
    mockExtractEvidence.mockResolvedValue({
      claims: [mockClaim],
      sources: [{ id: 'src-1', domain: 'typescriptlang.org', fetchedAt: Date.now() }],
      normalizedSources: [],
      relations: [],
    });

    const retriever = {
      search: mock().mockResolvedValue('Found: https://typescriptlang.org/docs'),
      fetch: mock().mockResolvedValue('TypeScript is a typed superset of JavaScript.'),
      disconnect: mock(),
    };

    const provider = createMcpEvidenceProvider(retriever, {
      runLlmTask: mockRunLlmTask,
      extractEvidence: mockExtractEvidence,
    });
    const evidence = await provider(makeTask());

    expect(retriever.search).toHaveBeenCalledWith('TypeScript typing', undefined);
    expect(retriever.fetch).toHaveBeenCalledWith('https://typescriptlang.org/docs');
    expect(evidence.claims).toHaveLength(1);
    expect(evidence.claims[0]?.text).toBe('TS is typed');
  });

  it('skips URL on fetch error and continues', async () => {
    mockRunLlmTask.mockResolvedValue({
      degraded: false,
      output: { queries: ['TypeScript error handling'] },
    });

    const retriever = {
      search: mock().mockResolvedValue('See https://example.com/ts-errors'),
      fetch: mock().mockRejectedValue(new Error('network error')),
      disconnect: mock(),
    };

    const provider = createMcpEvidenceProvider(retriever, {
      runLlmTask: mockRunLlmTask,
      extractEvidence: mockExtractEvidence,
    });
    const evidence = await provider(makeTask());

    expect(evidence.claims).toHaveLength(0);
    expect(evidence.queryCountUsed).toBe(1);
  });

  it('skips query on search error and continues', async () => {
    mockRunLlmTask.mockResolvedValue({
      degraded: false,
      output: { queries: ['bad query', 'good query'] },
    });
    mockExtractEvidence.mockResolvedValue({
      claims: [],
      sources: [],
      normalizedSources: [],
      relations: [],
    });

    const retriever = {
      search: mock()
        .mockRejectedValueOnce(new Error('search failed'))
        .mockResolvedValue('https://example.com'),
      fetch: mock().mockResolvedValue('content'),
      disconnect: mock(),
    };

    const provider = createMcpEvidenceProvider(retriever, {
      runLlmTask: mockRunLlmTask,
      extractEvidence: mockExtractEvidence,
    });
    const evidence = await provider(makeTask());

    expect(evidence.queryCountUsed).toBeGreaterThanOrEqual(1);
  });
});

describe('createKnowFlowTaskHandler', () => {
  it('uses defaultEvidenceProvider when none provided', async () => {
    const repo = makeRepo();
    const handler = createKnowFlowTaskHandler({
      repository: repo,
      budget: { userBudget: 5, cronBudget: 3, cronRunBudget: 10 },
    });

    const result = await handler(makeTask({ source: 'user' }));
    expect(result.ok).toBe(true);
  });

  it('handles cron source tasks', async () => {
    const repo = makeRepo();
    const handler = createKnowFlowTaskHandler({
      repository: repo,
      budget: { userBudget: 5, cronBudget: 3, cronRunBudget: 10 },
    });

    const result = await handler(makeTask({ source: 'cron' }));
    expect(result.ok).toBe(true);
  });

  it('returns ok=false and logs error when evidenceProvider throws', async () => {
    const repo = makeRepo();
    const errorProvider = mock().mockRejectedValue(new Error('evidence failed'));
    const logger = mock();

    const handler = createKnowFlowTaskHandler({
      repository: repo,
      evidenceProvider: errorProvider,
      logger,
    });

    const result = await handler(makeTask());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('evidence failed');
    }

    const errorEvents = (logger.mock.calls as { event: string }[][]).filter(
      (c) => c[0]?.event === 'task.flow.error',
    );
    expect(errorEvents.length).toBeGreaterThan(0);
  });
});
