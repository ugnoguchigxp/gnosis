import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { config } from '../src/config.js';
import {
  EntityInputSchema,
  LlmEntityDraftSchema,
  LlmRelationDraftSchema,
  RelationInputSchema,
} from '../src/domain/schemas';
import { generateEntityId } from '../src/utils/entityId';

type MockFn = ReturnType<typeof mock>;

type MockQuery<T> = {
  where: MockFn;
  orderBy: MockFn;
  limit: MockFn;
  then: <R>(resolve: (value: T) => R) => R;
};

type MockDbClient = {
  select: MockFn;
  insert: MockFn;
  execute: MockFn;
  update: MockFn;
  delete: MockFn;
};

const createMockQuery = <T>(data: T[] = []): MockQuery<T[]> => {
  const mockObj: MockQuery<T[]> = {
    where: mock(() => mockObj),
    orderBy: mock(() => mockObj),
    limit: mock(() => mockObj),
    // biome-ignore lint/suspicious/noThenProperty: mock
    then: (resolve) => resolve(data),
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

const mockDbUpdateSet = {
  set: mock(() => ({ where: mock(async () => {}) })),
};

const mockDbDeleteWhere = {
  where: mock(async () => {}),
};

const mockDb: MockDbClient = {
  select: mock(() => mockDbSelect),
  insert: mock(() => mockDbInsert),
  execute: mock(async () => {}),
  update: mock(() => mockDbUpdateSet),
  delete: mock(() => mockDbDeleteWhere),
};

const mockEmbed = async () => new Array(config.embeddingDimension).fill(0.1);

// mock.module('../src/db/index.js', () => ({
//   db: mockDb,
// }));

mock.module('../src/config.js', () => ({
  config: {
    embedCommand: 'mock-embed',
    embedTimeoutMs: 1000,
    embeddingDimension: 384,
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
  deleteRelation,
  digestTextIntelligence,
  findPathBetweenEntities,
  queryGraphContext,
  saveEntities,
  saveRelations,
  searchEntitiesByText,
  updateEntity,
} from '../src/services/graph';

type SaveEntitiesDb = NonNullable<Parameters<typeof saveEntities>[1]>;
type SaveRelationsDb = NonNullable<Parameters<typeof saveRelations>[1]>;
type SearchEntitiesDb = NonNullable<Parameters<typeof searchEntitiesByText>[2]>;
type UpdateEntityDb = NonNullable<Parameters<typeof updateEntity>[2]>;
type DeleteRelationDb = NonNullable<Parameters<typeof deleteRelation>[3]>;

describe('graph service', () => {
  beforeEach(() => {
    mockJudgeAndMerge.mockClear();
    mockSpawn.mockClear();
    // 埋め込み生成を常に成功させるようにモック (Memory サービス経由で呼ばれる)
    mockSpawn.mockImplementation(() => ({
      stdout: {
        on: (event: string, cb: (chunk: Buffer) => void) => {
          if (event === 'data')
            cb(Buffer.from(JSON.stringify(new Array(config.embeddingDimension).fill(0.1))));
        },
      },
      stderr: { on: () => {} },
      on: (event: string, cb: (code: number) => void) => {
        if (event === 'close') setTimeout(() => cb(0), 1);
      },
      kill: () => {},
    }));
  });

  describe('buildGraph', () => {
    it('builds a graph instance from database records', async () => {
      // Pass the mockDb explicitly to avoid global leakage
      const graph = await buildGraph(mockDb as unknown as SaveEntitiesDb);
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
      } as unknown as SaveEntitiesDb;

      const input = [{ id: 'e1', name: 'entity1', type: 'person', description: 'desc' }];
      await saveEntities(input, db, mockEmbed, { judgeAndMerge: mockJudgeAndMerge });

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
      } as unknown as SaveEntitiesDb;

      mockJudgeAndMerge.mockResolvedValue({
        shouldMerge: true,
        merged: { name: 'merged', type: 'person', description: 'merged desc' },
      });

      const input = [{ id: 'e_new', name: 'new', type: 'person', description: 'new desc' }];
      await saveEntities(input, db, mockEmbed, { judgeAndMerge: mockJudgeAndMerge });

      expect(mockJudgeAndMerge).toHaveBeenCalled();
      // マージによって既存の ID ('e_old') が使われるはず
      const insertArgs = (
        mockValues.mock.calls as unknown as Array<[Array<Record<string, unknown>>]>
      ).at(0)?.[0]?.[0];
      if (!insertArgs) throw new Error('expected insert arguments to exist');
      expect(insertArgs.id).toBe('e_old');
      expect(insertArgs.name).toBe('merged');
    });
  });

  describe('saveRelations', () => {
    it('inserts relations with weight handling', async () => {
      const mockExecute = mock(async () => {});
      const mockDbLocal = {
        execute: mockExecute,
      } as unknown as SaveRelationsDb;

      const relations = [{ sourceId: 'a', targetId: 'b', relationType: 'related', weight: 0.8 }];
      await saveRelations(relations, mockDbLocal);

      expect(mockExecute).toHaveBeenCalled();
    });

    it('resolves name-based draft relations to entity IDs', async () => {
      const mockExecute = mock(async () => {});
      const mockDbLocal = {
        execute: mockExecute,
      } as unknown as SaveRelationsDb;

      await saveRelations(
        [
          {
            sourceType: 'library',
            sourceName: 'Drizzle ORM',
            targetType: 'service',
            targetName: 'PostgreSQL',
            relationType: 'depends_on',
          },
        ],
        mockDbLocal,
      );

      // name ベース形式が ID に解決されて execute が 1 回呼ばれる
      expect(mockExecute).toHaveBeenCalledTimes(1);
      // 生成される ID を generateEntityId 単体テストで検証済み
      expect(generateEntityId('library', 'Drizzle ORM')).toBe('library/drizzle-orm');
      expect(generateEntityId('service', 'PostgreSQL')).toBe('service/postgresql');
    });
  });

  describe('findPathBetweenEntities', () => {
    it('throws error if entity not found', async () => {
      const findEntityById = mock(async () => null);
      const searchEntityByQuery = mock(async () => null);

      await expect(
        findPathBetweenEntities('non-existent', 'any', mockDb as unknown as SaveEntitiesDb, {
          findEntityById,
          searchEntityByQuery,
        }),
      ).rejects.toThrow();

      expect(findEntityById).toHaveBeenCalledTimes(2);
      expect(searchEntityByQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe('queryGraphContext', () => {
    it('returns empty results if starting entity not found', async () => {
      const result = await queryGraphContext('none', 2, 20, mockDb as unknown as SaveEntitiesDb);
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });

    it('returns entity and community when found, traverses BFS', async () => {
      const mockEntity = {
        id: 'e1',
        name: 'Entity1',
        type: 'concept',
        description: 'desc',
        communityId: 'c1',
        embedding: null,
        referenceCount: 0,
        lastReferencedAt: null,
        metadata: null,
      };
      const mockCommunity = { id: 'c1', name: 'Community1', summary: 'A test community' };

      let selectCallCount = 0;
      mockDb.select = mock(() => {
        selectCallCount += 1;
        if (selectCallCount === 1) {
          // startEntity lookup
          return { from: mock(() => createMockQuery([mockEntity])) };
        }
        if (selectCallCount === 2) {
          // community lookup
          return { from: mock(() => createMockQuery([mockCommunity])) };
        }
        if (selectCallCount === 3) {
          // BFS entity fetch
          return { from: mock(() => createMockQuery([mockEntity])) };
        }
        // outgoing + incoming relations → empty
        return { from: mock(() => createMockQuery([])) };
      });

      const result = await queryGraphContext('e1', 2, 20, mockDb as unknown as SaveEntitiesDb);

      // restore
      mockDb.select = mock(() => mockDbSelect);

      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.communities.length).toBeGreaterThan(0);
      expect(result.communities[0]).toMatchObject({ id: 'c1' });
    });
  });

  describe('searchEntitiesByText', () => {
    it('returns empty results when db returns nothing', async () => {
      const db = {
        select: mock(() => ({
          from: mock(() => createMockQuery([])),
        })),
        update: mock(() => ({ set: mock(() => ({ where: mock(async () => {}) })) })),
      } as unknown as SearchEntitiesDb;

      const results = await searchEntitiesByText('TypeScript', 5, db, {
        embeddingGenerator: mockEmbed,
      });
      expect(results).toEqual([]);
    });

    it('returns entities and updates referenceCount when found', async () => {
      const mockEntityRow = {
        id: 'e1',
        name: 'TypeScript',
        type: 'technology',
        description: 'typed JS',
        similarity: 0.9,
      };
      const mockUpdateWhere = mock(async () => {});
      const mockUpdateSet = mock(() => ({ where: mockUpdateWhere }));
      const mockUpdate = mock(() => ({ set: mockUpdateSet }));
      const db = {
        select: mock(() => ({
          from: mock(() => createMockQuery([mockEntityRow])),
        })),
        update: mockUpdate,
      } as unknown as SearchEntitiesDb;

      const results = await searchEntitiesByText('TypeScript', 5, db, {
        embeddingGenerator: mockEmbed,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe('TypeScript');
      expect(mockUpdate).toHaveBeenCalled();
    });
  });

  describe('updateEntity', () => {
    it('calls db.update with the given id and updates', async () => {
      const mockUpdateWhere = mock(async () => {});
      const mockUpdateSet = mock(() => ({ where: mockUpdateWhere }));
      const mockUpdateFn = mock(() => ({ set: mockUpdateSet }));
      const db = { update: mockUpdateFn } as unknown as UpdateEntityDb;

      await updateEntity('e1', { name: 'Updated Name' }, db);

      expect(mockUpdateFn).toHaveBeenCalled();
      expect(mockUpdateSet).toHaveBeenCalledWith({ name: 'Updated Name' });
      expect(mockUpdateWhere).toHaveBeenCalled();
    });
  });

  describe('deleteRelation', () => {
    it('calls db.delete with correct conditions', async () => {
      const mockDeleteWhere = mock(async () => {});
      const mockDeleteFn = mock(() => ({ where: mockDeleteWhere }));
      const db = { delete: mockDeleteFn } as unknown as DeleteRelationDb;

      await deleteRelation('src', 'tgt', 'related_to', db);

      expect(mockDeleteFn).toHaveBeenCalled();
      expect(mockDeleteWhere).toHaveBeenCalled();
    });
  });

  describe('digestTextIntelligence', () => {
    it('extracts entities and finds existing candidates', async () => {
      const mockExtractor = mock().mockResolvedValue([
        { id: 'e1', name: 'TypeScript', type: 'technology', description: 'typed JS' },
      ]);
      const mockSearcher = mock().mockResolvedValue([
        {
          id: 'existing-e1',
          name: 'TS',
          type: 'technology',
          description: 'typed JS superset',
          similarity: 0.95,
        },
      ]);

      const results = await digestTextIntelligence('TypeScript is typed', 5, 0.8, {
        extractor: mockExtractor,
        searcher: mockSearcher,
      });

      expect(mockExtractor).toHaveBeenCalledWith('TypeScript is typed');
      expect(results).toHaveLength(1);
      expect(results[0]?.extracted.name).toBe('TypeScript');
      expect(results[0]?.existingCandidates).toHaveLength(1);
    });

    it('filters candidates below similarity threshold', async () => {
      const mockExtractor = mock().mockResolvedValue([
        { id: 'e1', name: 'Bun', type: 'runtime', description: 'fast JS runtime' },
      ]);
      const mockSearcher = mock().mockResolvedValue([
        { id: 'x', name: 'Node', type: 'runtime', description: 'old runtime', similarity: 0.5 },
      ]);

      const results = await digestTextIntelligence('Bun runtime', 5, 0.8, {
        extractor: mockExtractor,
        searcher: mockSearcher,
      });

      expect(results[0]?.existingCandidates).toHaveLength(0);
    });

    it('returns empty when extractor returns no entities', async () => {
      const mockExtractor = mock().mockResolvedValue([]);
      const mockSearcher = mock();

      const results = await digestTextIntelligence('random text', 5, 0.8, {
        extractor: mockExtractor,
        searcher: mockSearcher,
      });

      expect(results).toHaveLength(0);
      expect(mockSearcher).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// ユニットテスト: generateEntityId
// ---------------------------------------------------------------------------
describe('generateEntityId', () => {
  it('generates slug from type and name', () => {
    expect(generateEntityId('library', 'Drizzle ORM')).toBe('library/drizzle-orm');
    expect(generateEntityId('tool', 'biome')).toBe('tool/biome');
    expect(generateEntityId('task', '差分の安全性を確認する')).toBe('task/差分の安全性を確認する');
  });

  it('normalizes multiple spaces to single hyphen', () => {
    // \s+ は 1 以上の連続スペースを 1 つのハイフンに置換する
    expect(generateEntityId('library', 'My  Library')).toBe('library/my-library');
  });

  it('trims whitespace from name', () => {
    expect(generateEntityId('tool', '  biome  ')).toBe('tool/biome');
  });

  it('is deterministic for the same input', () => {
    const a = generateEntityId('project', 'gnosis');
    const b = generateEntityId('project', 'gnosis');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// ユニットテスト: スキーマバリデーション (制御語彙)
// ---------------------------------------------------------------------------
describe('制御語彙バリデーション', () => {
  it('LlmEntityDraftSchema: 有効な type を受け入れる', () => {
    const result = LlmEntityDraftSchema.safeParse({
      type: 'library',
      name: 'drizzle-orm',
      description: 'PostgreSQL 向けの TypeScript ORM。スキーマ定義と型安全なクエリを提供する',
    });
    expect(result.success).toBe(true);
  });

  it('LlmEntityDraftSchema: 制御語彙外の type を拒否する', () => {
    const result = LlmEntityDraftSchema.safeParse({
      type: 'technology', // 語彙外
      name: 'TypeScript',
      description: '型付き JavaScript',
    });
    expect(result.success).toBe(false);
  });

  it('LlmRelationDraftSchema: 有効な relationType を受け入れる', () => {
    const result = LlmRelationDraftSchema.safeParse({
      sourceType: 'goal',
      sourceName: 'PR レビュー完了',
      targetType: 'task',
      targetName: '差分の安全性確認',
      relationType: 'has_step',
    });
    expect(result.success).toBe(true);
  });

  it('LlmRelationDraftSchema: 制御語彙外の relationType を拒否する', () => {
    const result = LlmRelationDraftSchema.safeParse({
      sourceType: 'task',
      sourceName: 'A',
      targetType: 'task',
      targetName: 'B',
      relationType: 'related_to', // 語彙外
    });
    expect(result.success).toBe(false);
  });

  it('EntityInputSchema: id あり入力を受け入れる (後方互換)', () => {
    const result = EntityInputSchema.safeParse({
      id: 'manual-id',
      type: 'project',
      name: 'gnosis',
      description: 'メモリ管理システム',
    });
    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('manual-id');
  });

  it('EntityInputSchema: id なし入力を受け入れる (LLM ドラフト互換)', () => {
    const result = EntityInputSchema.safeParse({
      type: 'library',
      name: 'drizzle-orm',
      description: 'TypeScript ORM',
    });
    expect(result.success).toBe(true);
    expect(result.data?.id).toBeUndefined();
  });

  it('RelationInputSchema: id ベース形式を受け入れる (後方互換)', () => {
    const result = RelationInputSchema.safeParse({
      sourceId: 'library/ts',
      targetId: 'tool/bun',
      relationType: 'depends_on',
    });
    expect(result.success).toBe(true);
  });

  it('RelationInputSchema: name ベース形式を受け入れる (新形式)', () => {
    const result = RelationInputSchema.safeParse({
      sourceType: 'library',
      sourceName: 'TypeScript',
      targetType: 'tool',
      targetName: 'Bun',
      relationType: 'depends_on',
    });
    expect(result.success).toBe(true);
  });
});
