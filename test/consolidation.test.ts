import { describe, expect, it, mock } from 'bun:test';

mock.module('../src/config.js', () => ({
  config: {
    embedCommand: 'mock-embed',
    embedTimeoutMs: 1000,
    embeddingDimension: 3,
    dedupeThreshold: 0.9,
    llmTimeoutMs: 5000,
    llmScript: 'echo',
    claudeLogDir: '/tmp/claude',
    antigravityLogDir: '/tmp/antigravity',
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

import { experienceLogs, relations, vibeMemories } from '../src/db/schema.js';
import { consolidateEpisodes } from '../src/services/consolidation.js';

// biome-ignore lint/suspicious/noExplicitAny: mock helper
const makeDb = (rawMemories: any[] = [], experiencesData: any[] = [], stepsData: any[] = []) => {
  const insertReturning = mock().mockResolvedValue([
    { id: 'ep-uuid-123', content: 'story', memoryType: 'episode' },
  ]);

  // biome-ignore lint/suspicious/noExplicitAny: mock
  const mockQuery = (data: any[]) => {
    const chain = {
      orderBy: () => chain,
      limit: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      // biome-ignore lint/suspicious/noThenProperty: intentional mock thenable for DB chain
      then: (resolve: (v: typeof data) => void) => Promise.resolve(data).then(resolve),
    };
    return chain;
  };

  return {
    select: () => ({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      from: (table: any) => {
        if (table === vibeMemories) return mockQuery(rawMemories);
        if (table === experienceLogs) return mockQuery(experiencesData);
        if (table === relations) return mockQuery(stepsData);
        return mockQuery([]);
      },
    }),
    insert: () => ({
      values: () => ({
        returning: insertReturning,
        onConflictDoNothing: mock().mockResolvedValue([]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: mock().mockResolvedValue(undefined),
      }),
    }),
  };
};

describe('consolidateEpisodes', () => {
  it('returns null when raw memories are fewer than minRawCount', async () => {
    const db = makeDb([
      {
        id: 'm1',
        sessionId: 'sess1',
        content: 'memo 1',
        memoryType: 'raw',
        isSynthesized: false,
        createdAt: new Date(),
      },
    ]);

    const result = await consolidateEpisodes('sess1', {
      database: db as never,
      minRawCount: 5,
      getGuidance: mock().mockResolvedValue(''),
    });

    expect(result).toBeNull();
  });

  it('calls LLM and creates episode when enough raw memories', async () => {
    const rawMemos = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      sessionId: 'sess1',
      content: `memo ${i}`,
      memoryType: 'raw',
      isSynthesized: false,
      createdAt: new Date(Date.now() + i * 1000),
    }));
    const db = makeDb(rawMemos, [], []);

    const mockSpawn = mock().mockReturnValue({
      stdout: JSON.stringify({
        story: 'テストストーリー本文です。問題が発生し、解決した経緯を記録しました。',
        importance: 0.7,
        episodeAt: '2026-04-16T00:00:00.000Z',
      }),
      stderr: '',
      status: 0,
      error: undefined,
    });

    const mockEmbed = mock().mockResolvedValue([0.1, 0.2, 0.3]);

    const result = await consolidateEpisodes('sess1', {
      database: db as never,
      spawnSync: mockSpawn,
      embedText: mockEmbed,
      minRawCount: 5,
      getGuidance: mock().mockResolvedValue('Mocked guidance'),
      withLock: (_name, fn) => fn(),
    });

    expect(result).not.toBeNull();
    expect(result?.episodeId).toBe('ep-uuid-123');
    expect(result?.episodeEntityId).toContain('episode/');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: mock
    const promptArg = (mockSpawn.mock.calls as any)[0][2];
    expect(promptArg).toBeDefined();
  });

  it('throws when LLM fails', async () => {
    const rawMemos = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      sessionId: 'sess1',
      content: `memo ${i}`,
      memoryType: 'raw',
      isSynthesized: false,
    }));
    const db = makeDb(rawMemos, []);

    const mockSpawn = mock().mockReturnValue({
      stdout: '',
      stderr: 'error',
      status: 1,
      error: undefined,
    });

    await expect(
      consolidateEpisodes('sess1', {
        database: db as never,
        spawnSync: mockSpawn,
        minRawCount: 5,
        withLock: (_name, fn) => fn(),
      }),
    ).rejects.toThrow();
  });
});
