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
  buildTopicExplorationOutcome,
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
    expect(evidence.fetchedPageCount).toBe(0);
    expect(evidence.diagnostics?.outcome).toBe('llm_degraded');
    expect(retriever.search).not.toHaveBeenCalled();
  });

  it('fetches selected search results sequentially and stops after a useful page', async () => {
    mockRunLlmTask.mockImplementation(
      async (input: { task: string; context?: { url?: string } }) => {
        if (input.task === 'query_generation') {
          return { degraded: false, output: { queries: ['TypeScript typing'] } };
        }
        if (input.task === 'search_result_selection') {
          return {
            degraded: false,
            output: {
              selected: [
                { url: 'https://example.com/thin', priority: 0.9 },
                { url: 'https://typescriptlang.org/docs', priority: 0.8 },
                { url: 'https://example.com/third', priority: 0.7 },
              ],
            },
          };
        }
        if (input.task === 'page_usefulness_evaluation') {
          return {
            degraded: false,
            output: {
              useful: input.context?.url === 'https://typescriptlang.org/docs',
              score: input.context?.url === 'https://typescriptlang.org/docs' ? 0.9 : 0.2,
              reason: 'test decision',
            },
          };
        }
        if (input.task === 'emergent_topic_extraction') {
          return {
            degraded: false,
            output: {
              items: [
                {
                  topic: 'TypeScript narrowing',
                  whyResearch: 'Relevant follow-up topic.',
                  relationType: 'expands',
                  score: 0.8,
                },
              ],
            },
          };
        }
        throw new Error(`unexpected task ${input.task}`);
      },
    );

    const mockClaim = { text: 'TS is typed', confidence: 0.9, sourceIds: ['src-1'] };
    mockExtractEvidence.mockResolvedValue({
      claims: [mockClaim],
      sources: [{ id: 'src-1', domain: 'typescriptlang.org', fetchedAt: Date.now() }],
      normalizedSources: [],
      relations: [],
    });

    const retriever = {
      search: mock().mockResolvedValue(`- Thin page (https://example.com/thin)
  Generic snippet.
- TypeScript docs (https://typescriptlang.org/docs)
  Official TypeScript documentation.
- Third result (https://example.com/third)
  Should not be fetched.`),
      fetch: mock().mockImplementation(async (url: string) =>
        url === 'https://example.com/thin'
          ? 'thin page'
          : 'TypeScript is a typed superset of JavaScript.',
      ),
      disconnect: mock(),
    };

    const provider = createMcpEvidenceProvider(retriever, {
      runLlmTask: mockRunLlmTask,
      extractEvidence: mockExtractEvidence,
    });
    const evidence = await provider(makeTask());

    expect(retriever.search).toHaveBeenCalledWith('TypeScript typing', undefined);
    expect(retriever.fetch).toHaveBeenCalledTimes(2);
    expect(retriever.fetch.mock.calls[0]?.[0]).toBe('https://example.com/thin');
    expect(retriever.fetch.mock.calls[1]?.[0]).toBe('https://typescriptlang.org/docs');
    expect(retriever.fetch.mock.calls.map((call) => call[0])).not.toContain(
      'https://example.com/third',
    );
    expect(evidence.claims).toHaveLength(1);
    expect(evidence.claims[0]?.text).toBe('TS is typed');
    expect(evidence.emergentTopics).toHaveLength(1);
    expect(evidence.emergentTopics?.[0]?.topic).toBe('TypeScript narrowing');
    expect(evidence.emergentTopics?.[0]?.sourceUrl).toBe('https://example.com/thin');
  });

  it('skips URL on fetch error and continues', async () => {
    mockRunLlmTask.mockImplementation(async (input: { task: string }) => {
      if (input.task === 'query_generation') {
        return { degraded: false, output: { queries: ['TypeScript error handling'] } };
      }
      if (input.task === 'search_result_selection') {
        return {
          degraded: false,
          output: { selected: [{ url: 'https://example.com/ts-errors', priority: 0.8 }] },
        };
      }
      throw new Error(`unexpected task ${input.task}`);
    });

    const retriever = {
      search: mock().mockResolvedValue(`- Error handling (https://example.com/ts-errors)
  TypeScript error handling article.`),
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
    expect(retriever.fetch).toHaveBeenCalledWith('https://example.com/ts-errors', undefined);
  });

  it('skips query on search error and continues', async () => {
    mockRunLlmTask.mockImplementation(
      async (input: { task: string; context?: { url?: string } }) => {
        if (input.task === 'query_generation') {
          return { degraded: false, output: { queries: ['bad query', 'good query'] } };
        }
        if (input.task === 'search_result_selection') {
          return {
            degraded: false,
            output: { selected: [{ url: 'https://example.com/good', priority: 0.8 }] },
          };
        }
        if (input.task === 'page_usefulness_evaluation') {
          return {
            degraded: false,
            output: {
              useful: input.context?.url === 'https://example.com/good',
              score: 0.9,
              reason: 'useful page',
            },
          };
        }
        if (input.task === 'emergent_topic_extraction') {
          return { degraded: false, output: { items: [] } };
        }
        throw new Error(`unexpected task ${input.task}`);
      },
    );
    mockExtractEvidence.mockResolvedValue({
      claims: [{ text: 'Good claim', confidence: 0.9, sourceIds: ['src-1'] }],
      sources: [{ id: 'src-1', domain: 'example.com', fetchedAt: Date.now() }],
      normalizedSources: [],
      relations: [],
    });

    const retriever = {
      search: mock()
        .mockRejectedValueOnce(new Error('search failed'))
        .mockResolvedValue(`- Good result (https://example.com/good)
  Useful page.`),
      fetch: mock().mockResolvedValue('content'),
      disconnect: mock(),
    };

    const provider = createMcpEvidenceProvider(retriever, {
      runLlmTask: mockRunLlmTask,
      extractEvidence: mockExtractEvidence,
    });
    const evidence = await provider(makeTask());

    expect(evidence.queryCountUsed).toBeGreaterThanOrEqual(1);
    expect(retriever.fetch).toHaveBeenCalledWith('https://example.com/good', undefined);
    expect(evidence.claims).toHaveLength(1);
  });

  it('requires two useful domains for high-priority topics', async () => {
    mockRunLlmTask.mockImplementation(
      async (input: { task: string; context?: { url?: string } }) => {
        if (input.task === 'query_generation') {
          return { degraded: false, output: { queries: ['TypeScript best practice'] } };
        }
        if (input.task === 'search_result_selection') {
          return {
            degraded: false,
            output: {
              selected: [
                { url: 'https://docs.example.com/ts', priority: 0.9 },
                { url: 'https://guide.example.org/ts', priority: 0.8 },
                { url: 'https://third.example.net/ts', priority: 0.7 },
              ],
            },
          };
        }
        if (input.task === 'page_usefulness_evaluation') {
          return {
            degraded: false,
            output: {
              useful:
                input.context?.url === 'https://docs.example.com/ts' ||
                input.context?.url === 'https://guide.example.org/ts',
              score: 0.9,
              reason: 'useful page',
            },
          };
        }
        if (input.task === 'emergent_topic_extraction') {
          return { degraded: false, output: { items: [] } };
        }
        throw new Error(`unexpected task ${input.task}`);
      },
    );
    mockExtractEvidence.mockResolvedValue({
      claims: [{ text: 'Useful claim', confidence: 0.9, sourceIds: ['src-1'] }],
      sources: [{ id: 'src-1', domain: 'example.com', fetchedAt: Date.now() }],
      normalizedSources: [],
      relations: [],
    });

    const retriever = {
      search: mock().mockResolvedValue(`- Docs (https://docs.example.com/ts)
  Useful page.
- Guide (https://guide.example.org/ts)
  Useful page from another domain.
- Third (https://third.example.net/ts)
  Should not be fetched.`),
      fetch: mock().mockResolvedValue('content'),
      disconnect: mock(),
    };

    const provider = createMcpEvidenceProvider(retriever, {
      runLlmTask: mockRunLlmTask,
      extractEvidence: mockExtractEvidence,
    });
    const evidence = await provider(makeTask({ priority: 100 }));

    expect(retriever.fetch).toHaveBeenCalledTimes(2);
    expect(retriever.fetch.mock.calls.map((call) => call[0])).toEqual([
      'https://docs.example.com/ts',
      'https://guide.example.org/ts',
    ]);
    expect(evidence.usefulPageCount).toBe(2);
    expect(evidence.requiredUsefulPageCount).toBe(2);
    expect(evidence.usefulPageFound).toBe(true);
    expect(evidence.claims).toHaveLength(2);
  });
});

describe('buildTopicExplorationOutcome', () => {
  it('records accepted findings, sources, and original frontier reason', () => {
    const now = new Date('2026-04-30T00:00:00.000Z');
    const outcome = buildTopicExplorationOutcome({
      task: makeTask({
        topic: 'TypeScript magic number rule',
        expansion: {
          seedEntityId: 'rule/magic-number',
          seedCommunityId: '00000000-0000-0000-0000-000000000001',
          whyResearch: 'high-value rule, sparse graph neighborhood',
        },
      }),
      evidence: {
        claims: [
          {
            text: 'Magic numbers should be replaced with named constants unless the value is a conventional sentinel.',
            confidence: 0.95,
            sourceIds: ['src-1'],
          },
        ],
        sources: [
          {
            id: 'src-1',
            domain: 'docs.example.com',
            fetchedAt: now.getTime(),
            qualityScore: 0.9,
          },
        ],
        normalizedSources: [
          {
            id: 'src-1',
            url: 'https://docs.example.com/style/magic-numbers',
            domain: 'docs.example.com',
            title: 'Style guide',
            fetchedAt: now.getTime(),
          },
        ],
        relations: [],
        queryCountUsed: 1,
        searchQueries: ['typescript magic number constants'],
        usefulPageFound: true,
        usefulPageCount: 1,
        requiredUsefulPageCount: 1,
        fetchedPageCount: 1,
      },
      now,
    });

    expect(outcome.status).toBe('explored');
    expect(outcome.outcome).toBe('claims_recorded');
    expect(outcome.description).toContain('Accepted findings');
    expect(outcome.description).toContain('Magic numbers should be replaced');
    expect(outcome.description).toContain('Style guide - docs.example.com');
    expect(outcome.description).toContain('Original selection reason');
    expect(outcome.metadata.acceptedClaimCount).toBe(1);
    expect(outcome.metadata.sourceSamples).toContain(
      'Style guide - docs.example.com: https://docs.example.com/style/magic-numbers',
    );
  });

  it('marks no-evidence attempts as exhausted instead of leaving the topic queued', () => {
    const outcome = buildTopicExplorationOutcome({
      task: makeTask({
        topic: 'Sparse frontier',
        expansion: {
          seedEntityId: 'rule/sparse-frontier',
          whyResearch: 'sparse graph neighborhood',
        },
      }),
      evidence: {
        claims: [],
        sources: [],
        normalizedSources: [],
        relations: [],
        queryCountUsed: 0,
        usefulPageFound: false,
        usefulPageCount: 0,
        requiredUsefulPageCount: 1,
        fetchedPageCount: 0,
        diagnostics: {
          outcome: 'llm_degraded',
          messages: ['LLM degraded during query generation; MCP search was skipped.'],
        },
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(outcome.status).toBe('exhausted');
    expect(outcome.outcome).toBe('llm_degraded');
    expect(outcome.description).toContain('did not record enough useful knowledge');
    expect(outcome.description).toContain('LLM degraded during query generation');
    expect(outcome.metadata.retryAfter).toBeDefined();
    expect(outcome.metadata.knowflowStatus).toBe('exhausted');
  });

  it('records pipeline failures with a short retry window', () => {
    const outcome = buildTopicExplorationOutcome({
      task: makeTask({
        topic: 'Failing frontier',
        expansion: {
          seedEntityId: 'rule/failing-frontier',
          whyResearch: 'high-value rule',
        },
      }),
      evidence: {
        claims: [],
        sources: [],
        normalizedSources: [],
        relations: [],
        queryCountUsed: 0,
      },
      result: {
        taskId: 'task-1',
        topic: 'Failing frontier',
        ok: false,
        summary: 'Evidence collection failed: network error',
        phases: {
          evidenceCollection: {
            ok: false,
            error: 'network error',
            durationMs: 10,
          },
          flowExecution: { ok: false, durationMs: 0 },
          followupPlanning: { ok: false, durationMs: 0 },
        },
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.outcome).toBe('pipeline_failed');
    expect(outcome.description).toContain('pipeline failed');
    expect(outcome.metadata.failureReason).toBe('Evidence collection failed: network error');
    expect(outcome.metadata.knowflowStatus).toBe('failed');
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
