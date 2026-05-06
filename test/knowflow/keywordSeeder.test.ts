import { beforeEach, describe, expect, it, mock } from 'bun:test';
const mockConfig = {
  knowflow: {
    llm: {
      timeoutMs: 5000,
    },
    keywordCron: {
      enabled: true,
      maxTopics: 10,
      lookbackHours: 24,
    },
  },
};

mock.module('../../src/config.js', () => ({
  config: mockConfig,
}));

import { runKeywordSeederOnce } from '../../src/services/knowflow/cron/keywordSeeder.js';
import type { KeywordSource } from '../../src/services/knowflow/cron/types.js';

describe('runKeywordSeederOnce', () => {
  const mockEnqueue = mock();
  const mockUpdateCheckpoint = mock();
  const mockGetSinceTime = mock();
  const mockScoutPhrases = mock();
  const mockSourceLoader = mock();
  const mockContextLoader = mock();

  beforeEach(() => {
    mockConfig.knowflow.keywordCron.enabled = true;
    mockConfig.knowflow.keywordCron.maxTopics = 10;

    mockEnqueue.mockReset();
    mockUpdateCheckpoint.mockReset();
    mockGetSinceTime.mockReset();
    mockScoutPhrases.mockReset();
    mockSourceLoader.mockReset();
    mockContextLoader.mockReset();

    mockGetSinceTime.mockResolvedValue(new Date('2026-04-18T00:00:00.000Z'));
    mockUpdateCheckpoint.mockResolvedValue(undefined);
    mockContextLoader.mockResolvedValue('recent work logs about MCP fetch failures');
  });

  it('enqueues non-empty Phrase Scout lines without scores or categories', async () => {
    const now = new Date('2026-04-18T10:00:00.000Z');
    const source: KeywordSource = {
      sourceType: 'experience',
      sourceId: 's-1',
      content: 'example',
      createdAt: now,
    };

    mockSourceLoader.mockResolvedValue([source]);
    mockScoutPhrases.mockResolvedValue([
      'MCP fetch retry budget',
      'TypeScript AST symbol resolution',
    ]);
    mockEnqueue.mockResolvedValue({ task: { id: 'task-enqueued-1' }, deduped: false });

    const result = await runKeywordSeederOnce({
      now: () => now,
      sourceLoader: mockSourceLoader,
      contextLoader: mockContextLoader,
      scoutPhrases: mockScoutPhrases,
      getSinceTime: mockGetSinceTime,
      updateCheckpoint: mockUpdateCheckpoint,
      queueRepository: { enqueue: mockEnqueue } as never,
      logger: () => {},
    });

    expect(result.phrases).toBe(2);
    expect(result.enqueued).toBe(2);
    expect(mockEnqueue).toHaveBeenCalledTimes(2);

    const enqueueInput = mockEnqueue.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(enqueueInput.topic).toBe('MCP fetch retry budget');
    expect(enqueueInput.source).toBe('cron');
    expect(enqueueInput).not.toHaveProperty('evaluation');
    expect(enqueueInput).not.toHaveProperty('priority');
  });

  it('returns early when feature is disabled', async () => {
    mockConfig.knowflow.keywordCron.enabled = false;

    const result = await runKeywordSeederOnce({
      logger: () => {},
      sourceLoader: mockSourceLoader,
      scoutPhrases: mockScoutPhrases,
      getSinceTime: mockGetSinceTime,
      updateCheckpoint: mockUpdateCheckpoint,
      queueRepository: { enqueue: mockEnqueue } as never,
    });

    expect(result.phrases).toBe(0);
    expect(result.enqueued).toBe(0);
    expect(mockSourceLoader).not.toHaveBeenCalled();
  });

  it('completes without enqueueing when Phrase Scout returns no phrases', async () => {
    const now = new Date('2026-04-18T10:00:00.000Z');
    mockSourceLoader.mockResolvedValue([
      {
        sourceType: 'experience',
        sourceId: 's-empty',
        content: 'no actionable programming direction',
        createdAt: now,
      },
    ] satisfies KeywordSource[]);
    mockScoutPhrases.mockResolvedValue([]);

    const result = await runKeywordSeederOnce({
      now: () => now,
      sourceLoader: mockSourceLoader,
      contextLoader: mockContextLoader,
      scoutPhrases: mockScoutPhrases,
      getSinceTime: mockGetSinceTime,
      updateCheckpoint: mockUpdateCheckpoint,
      queueRepository: { enqueue: mockEnqueue } as never,
      logger: () => {},
    });

    expect(result.phrases).toBe(0);
    expect(result.enqueued).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockUpdateCheckpoint).toHaveBeenCalledTimes(1);
  });
});
