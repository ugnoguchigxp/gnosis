import { describe, expect, it, mock } from 'bun:test';

mock.module('../src/config.js', () => ({
  config: {
    embedCommand: 'mock-embed',
    embedTimeoutMs: 1000,
    embeddingDimension: 384,
    dedupeThreshold: 0.9,
    llmTimeoutMs: 5000,
    llmScript: 'echo',
    claudeLogDir: '/tmp/claude',
    antigravityLogDir: '/tmp/antigravity',
    memory: { retries: 1, retryWaitMultiplier: 0.01 },
    graph: { similarityThreshold: 0.8, maxPathHops: 5 },
    llm: { maxBuffer: 10 * 1024 * 1024, defaultTimeoutMs: 45_000 },
    backgroundWorker: { minRawCount: 5 },
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
  },
}));

import { config } from '../src/config.js';
import { experienceLogs, relations, vibeMemories } from '../src/db/schema.js';
import { consolidateEpisodes } from '../src/services/consolidation.js';

// biome-ignore lint/suspicious/noExplicitAny: mock helper
function makeDb(rawMemories: any[] = [], experiencesData: any[] = [], stepsData: any[] = []) {
  const insertReturning = mock().mockResolvedValue([
    { id: 'ep-uuid-123', content: 'story', memoryType: 'episode' },
  ]);

  // biome-ignore lint/suspicious/noExplicitAny: mock
  const mockQuery = (data: any[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: mock
    const chain: any = {
      orderBy: () => chain,
      limit: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      // biome-ignore lint/suspicious/noThenProperty: intentional mock thenable for DB chain
      // biome-ignore lint/suspicious/noExplicitAny: mock
      then: (resolve: (v: any[]) => void) => Promise.resolve(data).then(resolve),
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
}

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
      // biome-ignore lint/suspicious/noExplicitAny: mock
      database: db as any,
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

    const mockEmbed = mock().mockResolvedValue(new Array(config.embeddingDimension).fill(0.1));

    const result = await consolidateEpisodes('sess1', {
      // biome-ignore lint/suspicious/noExplicitAny: mock
      database: db as any,
      spawnSync: mockSpawn,
      embedText: mockEmbed,
      minRawCount: 5,
      getGuidance: mock().mockResolvedValue('Mocked guidance'),
      withSemaphore: (_name, _concurrency, fn) => fn(),
    });

    expect(result).not.toBeNull();
    expect(result?.episodeId).toBe('ep-uuid-123');
    expect(result?.episodeEntityId).toContain('episode/');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: mock
    const promptArg = (mockSpawn.mock.calls as any)[0][2];
    expect(promptArg).toBeDefined();
  }, 15000);

  it('applies Time Gap Heuristic to split early segments', async () => {
    const rawMemos = [
      {
        id: 'm1',
        content: 'memo 1',
        createdAt: new Date('2026-04-18T10:00:00Z'),
        isSynthesized: false,
        memoryType: 'raw',
      },
      {
        id: 'm2',
        content: 'memo 2',
        createdAt: new Date('2026-04-18T10:10:00Z'),
        isSynthesized: false,
        memoryType: 'raw',
      },
      {
        id: 'm3',
        content: 'memo 3',
        createdAt: new Date('2026-04-18T11:20:00Z'),
        isSynthesized: false,
        memoryType: 'raw',
      }, // 70 min gap
      {
        id: 'm4',
        content: 'memo 4',
        createdAt: new Date('2026-04-18T11:25:00Z'),
        isSynthesized: false,
        memoryType: 'raw',
      },
      {
        id: 'm5',
        content: 'memo 5',
        createdAt: new Date('2026-04-18T11:30:00Z'),
        isSynthesized: false,
        memoryType: 'raw',
      },
    ];
    // With minRawCount=2, it should take the first segment (m1, m2) because it's cut by gap.
    const db = makeDb(rawMemos, []);
    const mockSpawn = mock().mockReturnValue({
      stdout: JSON.stringify({
        story: 'Gap segment story',
        importance: 0.5,
        episodeAt: '2026-04-18T10:05:00Z',
      }),
      status: 0,
    });

    const result = await consolidateEpisodes('sess-gap', {
      // biome-ignore lint/suspicious/noExplicitAny: mock
      database: db as any,
      spawnSync: mockSpawn,
      minRawCount: 2, // Segment size is 2
      embedText: mock().mockResolvedValue(new Array(384).fill(0)),
      getGuidance: mock().mockResolvedValue(''),
      withSemaphore: (_n, _c, fn) => fn(),
    });

    expect(result).not.toBeNull();
    expect(mockSpawn).toHaveBeenCalled();
    // Verify that ONLY the first 2 memos were sent in prompt
    // args matching: [script, ['--output', 'text', '--prompt', prompt], options]
    // biome-ignore lint/suspicious/noExplicitAny: mock
    const args = (mockSpawn.mock.calls[0] as any)[1] || [];
    const promptIdx = args.indexOf('--prompt');
    const prompt = promptIdx !== -1 ? args[promptIdx + 1] : '';

    expect(prompt).toContain('memo 1');
    expect(prompt).toContain('memo 2');
    expect(prompt).not.toContain('memo 3');
  });

  it('includes experience logs and procedures in the prompt', async () => {
    const rawMemos = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      content: `memo ${i}`,
      memoryType: 'raw',
      isSynthesized: false,
      createdAt: new Date(),
    }));
    const experiences = [{ type: 'failure', content: 'Something went wrong' }];
    const steps = [{ name: 'Step 1', description: 'Do the thing' }];

    const db = makeDb(rawMemos, experiences, steps);
    const mockSpawn = mock().mockReturnValue({
      stdout: JSON.stringify({
        story: 'Integrated story',
        importance: 0.5,
        episodeAt: '2026-04-18T12:00:00Z',
      }),
      status: 0,
    });

    await consolidateEpisodes('sess-full', {
      // biome-ignore lint/suspicious/noExplicitAny: mock
      database: db as any,
      spawnSync: mockSpawn,
      minRawCount: 5,
      sourceTask: 'goal-123',
      embedText: mock().mockResolvedValue(new Array(384).fill(0)),
      getGuidance: mock().mockResolvedValue(''),
      withSemaphore: (_n, _c, fn) => fn(),
    });

    // biome-ignore lint/suspicious/noExplicitAny: mock
    const args = (mockSpawn.mock.calls[0] as any)[1] || [];
    const promptIdx = args.indexOf('--prompt');
    const prompt = promptIdx !== -1 ? args[promptIdx + 1] : '';

    expect(prompt).toContain('Something went wrong'); // Experience
    expect(prompt).toContain('Step 1'); // Procedure
    expect(prompt).toContain('【対象タスク: goal-123】');
  });
});
