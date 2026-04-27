import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';

const mockConfig = {
  knowflow: {
    llm: {
      timeoutMs: 5000,
    },
    keywordCron: {
      enabled: true,
      maxTopics: 10,
      minResearchScore: 6.5,
      lookbackHours: 24,
      evalModelAlias: 'gemma4',
      evalFallbackAlias: 'openai',
    },
  },
  gemma4Script: '/tmp/scripts/gemma4',
  bonsaiScript: '/tmp/scripts/bonsai',
  bedrockScript: '/tmp/scripts/bedrock',
  openaiScript: '/tmp/scripts/openai',
};

mock.module('../../src/config.js', () => ({
  config: mockConfig,
  KeywordEvalAliasSchema: z.enum(['bonsai', 'gemma4', 'bedrock', 'openai']),
}));

import { runKeywordSeederOnce } from '../../src/services/knowflow/cron/keywordSeeder.js';
import type {
  KeywordEvaluationRow,
  KeywordSource,
} from '../../src/services/knowflow/cron/types.js';

describe('runKeywordSeederOnce', () => {
  const mockEnqueue = mock();
  const mockSaveEvaluations = mock();
  const mockUpdateCheckpoint = mock();
  const mockGetSinceTime = mock();
  const mockEvaluateSource = mock();
  const mockSourceLoader = mock();

  beforeEach(() => {
    mockConfig.knowflow.keywordCron.enabled = true;
    mockConfig.knowflow.keywordCron.maxTopics = 10;
    mockConfig.knowflow.keywordCron.minResearchScore = 6.5;

    mockEnqueue.mockReset();
    mockSaveEvaluations.mockReset();
    mockUpdateCheckpoint.mockReset();
    mockGetSinceTime.mockReset();
    mockEvaluateSource.mockReset();
    mockSourceLoader.mockReset();

    mockGetSinceTime.mockResolvedValue(new Date('2026-04-18T00:00:00.000Z'));
    mockUpdateCheckpoint.mockResolvedValue(undefined);
    mockSaveEvaluations.mockResolvedValue(0);
  });

  it('enqueues only items with search_score > 6.5', async () => {
    const savedRows: KeywordEvaluationRow[] = [];
    const now = new Date('2026-04-18T10:00:00.000Z');

    const source: KeywordSource = {
      sourceType: 'experience',
      sourceId: 's-1',
      content: 'example',
      createdAt: now,
    };

    mockSourceLoader.mockResolvedValue([source]);
    mockEvaluateSource.mockResolvedValue({
      aliasUsed: 'gemma4',
      items: [
        {
          topic: 'threshold-edge',
          category: 'feature_spec',
          why_research: 'edge case',
          search_score: 6.5,
          term_difficulty_score: 4.2,
          uncertainty_score: 5.1,
        },
        {
          topic: 'threshold-over',
          category: 'performance',
          why_research: 'needs validation',
          search_score: 6.5001,
          term_difficulty_score: 3.1,
          uncertainty_score: 6.3,
        },
      ],
    });

    mockEnqueue.mockResolvedValue({
      task: { id: 'task-enqueued-1' },
      deduped: false,
    });

    mockSaveEvaluations.mockImplementation(async (rows: KeywordEvaluationRow[]) => {
      savedRows.push(...rows);
      return rows.length;
    });

    const result = await runKeywordSeederOnce({
      now: () => now,
      sourceLoader: mockSourceLoader,
      evaluateSource: mockEvaluateSource,
      getSinceTime: mockGetSinceTime,
      updateCheckpoint: mockUpdateCheckpoint,
      queueRepository: {
        enqueue: mockEnqueue,
      } as never,
      evaluationRepository: {
        saveEvaluations: mockSaveEvaluations,
      } as never,
      logger: () => {},
    });

    expect(result.evaluated).toBe(2);
    expect(result.enqueued).toBe(1);
    expect(result.skipped).toBe(1);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);

    const enqueueInput = mockEnqueue.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(enqueueInput.topic).toBe('threshold-over');
    expect(enqueueInput.priority).toBe(1);
    expect(enqueueInput.source).toBe('cron');

    expect(savedRows).toHaveLength(2);
    const skipped = savedRows.find((row) => row.topic === 'threshold-edge');
    const enqueued = savedRows.find((row) => row.topic === 'threshold-over');
    expect(skipped?.decision).toBe('skipped');
    expect(enqueued?.decision).toBe('enqueued');
    expect(enqueued?.enqueuedTaskId).toBe('task-enqueued-1');
  });

  it('returns early when feature is disabled', async () => {
    mockConfig.knowflow.keywordCron.enabled = false;

    const result = await runKeywordSeederOnce({
      logger: () => {},
      sourceLoader: mockSourceLoader,
      evaluateSource: mockEvaluateSource,
      getSinceTime: mockGetSinceTime,
      updateCheckpoint: mockUpdateCheckpoint,
      queueRepository: {
        enqueue: mockEnqueue,
      } as never,
      evaluationRepository: {
        saveEvaluations: mockSaveEvaluations,
      } as never,
    });

    expect(result.evaluated).toBe(0);
    expect(result.enqueued).toBe(0);
    expect(mockSourceLoader).not.toHaveBeenCalled();
    expect(mockSaveEvaluations).not.toHaveBeenCalled();
  });
});
