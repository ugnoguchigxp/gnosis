import { beforeEach, describe, expect, it, mock } from 'bun:test';

// 簡易的な Drizzle モック作成関数
// biome-ignore lint/suspicious/noExplicitAny: mock
const createMockQuery = (data: any = []) => {
  const mockObj = {
    where: mock(() => mockObj),
    orderBy: mock(() => mockObj),
    limit: mock(() => mockObj),
    // biome-ignore lint/suspicious/noThenProperty: mock
    // biome-ignore lint/suspicious/noExplicitAny: mock
    then: (resolve: any) => resolve(data),
  };
  return mockObj;
};

const mockDbInsert = {
  values: mock(() => ({
    onConflictDoUpdate: mock(async () => {}),
    returning: mock(async () => []),
  })),
};

const mockDbSelect = {
  from: mock(() => createMockQuery([])),
};

const mockDb = {
  select: mock(() => mockDbSelect),
  insert: mock(() => mockDbInsert),
  execute: mock(async () => {}),
};

mock.module('../src/db/index.js', () => ({
  db: mockDb,
}));

mock.module('../src/config.js', () => ({
  config: {
    embedCommand: 'mock-embed',
    embedTimeoutMs: 1000,
    embeddingDimension: 3,
    dedupeThreshold: 0.9,
    llmTimeoutMs: 90_000,
    claudeLogDir: '/tmp/claude',
    antigravityLogDir: '/tmp/antigravity',
    memory: {
      retries: 1,
      retryWaitMultiplier: 0.01,
    },
    graph: {
      similarityThreshold: 0.8,
      maxPathHops: 5,
    },
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
    llm: {
      maxBuffer: 10 * 1024 * 1024,
      defaultTimeoutMs: 45_000,
    },
  },
}));

// node:child_process の spawn をモック
const mockSpawn = mock();
mock.module('node:child_process', () => ({
  spawn: mockSpawn,
}));

const mockJudgeAndMerge = mock();

import {
  buildGraph,
  findPathBetweenEntities,
  queryGraphContext,
  saveEntities,
  saveRelations,
} from '../src/services/graph';

describe('graph service', () => {
  beforeEach(() => {
    mockJudgeAndMerge.mockClear();
    mockSpawn.mockClear();
    // 埋め込み生成を常に成功させるようにモック (Memory サービス経由で呼ばれる)
    mockSpawn.mockImplementation(() => ({
      stdout: {
        // biome-ignore lint/suspicious/noExplicitAny: mock
        on: (event: string, cb: any) => event === 'data' && cb(Buffer.from('[0.1, 0.2, 0.3]')),
      },
      stderr: { on: () => {} },
      // biome-ignore lint/suspicious/noExplicitAny: mock
      on: (event: string, cb: any) => {
        if (event === 'close') setTimeout(() => cb(0), 1);
      },
      kill: () => {},
    }));
  });

  describe('buildGraph', () => {
    it('builds a graph instance from database records', async () => {
      // db.select モックは global で定義されているものを利用（必要に応じて個別に設定）
      const graph = await buildGraph();
      expect(graph).toBeDefined();
      expect(typeof graph.addNode).toBe('function');
    });
  });

  describe('saveEntities', () => {
    it('saves a new entity without deduplication if similarity is low', async () => {
      const mockValues = mock(() => ({
        onConflictDoUpdate: mock(async () => {}),
      }));
      const mockInsert = mock(() => ({
        values: mockValues,
      }));
      const db = {
        select: mock(() => ({
          from: mock(() => createMockQuery([])),
        })),
        insert: mockInsert,
        // biome-ignore lint/suspicious/noExplicitAny: mock
      } as any;

      const input = [{ id: 'e1', name: 'entity1', type: 'person', description: 'desc' }];
      await saveEntities(input, db, undefined, { judgeAndMerge: mockJudgeAndMerge });

      expect(db.insert).toHaveBeenCalled();
      expect(mockJudgeAndMerge).not.toHaveBeenCalled();
    });

    it('merges entities if high similarity detected', async () => {
      const existing = {
        id: 'e_old',
        name: 'old',
        type: 'person',
        description: 'old desc',
        similarity: 0.95,
      };
      const mockValues = mock(() => ({
        onConflictDoUpdate: mock(async () => {}),
      }));
      const mockInsert = mock(() => ({
        values: mockValues,
      }));
      const db = {
        select: mock(() => ({
          from: mock(() => createMockQuery([existing])),
        })),
        insert: mockInsert,
        // biome-ignore lint/suspicious/noExplicitAny: mock
      } as any;

      mockJudgeAndMerge.mockResolvedValue({
        shouldMerge: true,
        merged: { name: 'merged', type: 'person', description: 'merged desc' },
      });

      const input = [{ id: 'e_new', name: 'new', type: 'person', description: 'new desc' }];
      await saveEntities(input, db, undefined, { judgeAndMerge: mockJudgeAndMerge });

      expect(mockJudgeAndMerge).toHaveBeenCalled();
      // マージによって既存の ID ('e_old') が使われるはず
      // biome-ignore lint/suspicious/noExplicitAny: mock
      const insertArgs = (mockValues.mock.calls as any)[0][0][0];
      expect(insertArgs.id).toBe('e_old');
      expect(insertArgs.name).toBe('merged');
    });
  });

  describe('saveRelations', () => {
    it('inserts relations with weight handling', async () => {
      const mockExecute = mock(async () => {});
      const mockDb = {
        execute: mockExecute,
        // biome-ignore lint/suspicious/noExplicitAny: mock
      } as any;

      const relations = [{ sourceId: 'a', targetId: 'b', relationType: 'related', weight: 0.8 }];
      await saveRelations(relations, mockDb);

      expect(mockExecute).toHaveBeenCalled();
    });
  });

  describe('findPathBetweenEntities', () => {
    it('throws error if entity not found', async () => {
      // 実際には内部で findEntityById や searchEntityByQuery を呼ぶ
      // db.select で空を返すようにしてエラーを誘発
      await expect(findPathBetweenEntities('non-existent', 'any')).rejects.toThrow();
    });
  });

  describe('queryGraphContext', () => {
    it('returns empty results if starting entity not found', async () => {
      const result = await queryGraphContext('none');
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });
  });
});
