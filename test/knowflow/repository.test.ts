import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  knowledgeClaims,
  knowledgeRelations,
  knowledgeSources,
  knowledgeTopics,
} from '../../src/db/schema.js';
import { PgKnowledgeRepository } from '../../src/services/knowflow/knowledge/repository.js';

// Helper to create a Drizzle-like mock chain
// biome-ignore lint/suspicious/noExplicitAny: mock
const createMockChain = (data: any[] = []) => {
  // biome-ignore lint/suspicious/noExplicitAny: mock
  const chain: any = {
    where: mock(() => chain),
    orderBy: mock(() => chain),
    limit: mock(() => chain),
    innerJoin: mock(() => chain),
    for: mock(() => chain),
    returning: mock(async () => data),
    onConflictDoNothing: mock(async () => data),
    // biome-ignore lint/suspicious/noThenProperty: drizzle thenable
    // biome-ignore lint/suspicious/noExplicitAny: mock
    then: (resolve: any) => Promise.resolve(data).then(resolve),
  };
  return chain;
};

describe('PgKnowledgeRepository', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mock
  let mockDb: any;
  let repository: PgKnowledgeRepository;

  beforeEach(() => {
    mockDb = {
      select: mock(() => ({ from: mock(() => createMockChain([])) })),
      insert: mock(() => ({ values: mock(() => createMockChain([])) })),
      update: mock(() => ({ set: mock(() => ({ where: mock(() => createMockChain([])) })) })),
      delete: mock(() => ({ where: mock(() => createMockChain([])) })),
      // biome-ignore lint/suspicious/noExplicitAny: mock
      transaction: mock(async (callback: any) => {
        return callback(mockDb);
      }),
    };

    repository = new PgKnowledgeRepository({}, mockDb);
  });

  it('getByTopic returns null if topic does not exist', async () => {
    mockDb.select.mockReturnValueOnce({ from: () => createMockChain([]) });

    const result = await repository.getByTopic('non-existent');
    expect(result).toBeNull();
  });

  it('getByTopic returns knowledge if topic exists', async () => {
    const mockTopic = {
      id: 'topic-1',
      canonicalTopic: 'test',
      aliases: ['test'],
      confidence: 0.8,
      coverage: 0.5,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Set up mock responses for the transaction calls
    mockDb.select
      .mockReturnValueOnce({ from: () => createMockChain([mockTopic]) }) // Topic search
      .mockReturnValueOnce({ from: () => createMockChain([]) }) // claims
      .mockReturnValueOnce({ from: () => createMockChain([]) }) // relations
      .mockReturnValueOnce({ from: () => createMockChain([]) }); // sources

    const result = await repository.getByTopic('test');
    expect(result).not.toBeNull();
    expect(result?.canonicalTopic).toBe('test');
  });

  it('searchTopics returns multiple items', async () => {
    const mockTopics = [
      {
        id: 't1',
        canonicalTopic: 'a',
        aliases: ['a'],
        confidence: 0.5,
        coverage: 0.1,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 't2',
        canonicalTopic: 'b',
        aliases: ['b'],
        confidence: 0.5,
        coverage: 0.1,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    mockDb.select.mockReturnValueOnce({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: mock(() => createMockChain(mockTopics)) }) }),
      }),
    });

    // buildKnowledge for each topic
    mockDb.select
      .mockReturnValueOnce({ from: () => createMockChain([]) })
      .mockReturnValueOnce({ from: () => createMockChain([]) })
      .mockReturnValueOnce({ from: () => createMockChain([]) })
      .mockReturnValueOnce({ from: () => createMockChain([]) })
      .mockReturnValueOnce({ from: () => createMockChain([]) })
      .mockReturnValueOnce({ from: () => createMockChain([]) });

    const results = await repository.searchTopics('query');
    expect(results).toHaveLength(2);
  });

  it('merge handles existing topic and merges claims', async () => {
    const mockTopic = {
      id: 't1',
      canonicalTopic: 'existing',
      aliases: ['existing'],
      confidence: 0.5,
      coverage: 0.5,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const mockClaim = {
      id: 'c1',
      topicId: 't1',
      text: 'Existing claim',
      confidence: 0.5,
      sourceIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // 1. merge initialization
    mockDb.select.mockReturnValueOnce({
      from: () => ({
        where: () => ({ limit: () => ({ for: () => createMockChain([mockTopic]) }) }),
      }),
    });
    // 2. buildKnowledge for existing
    mockDb.select
      .mockReturnValueOnce({ from: () => createMockChain([mockClaim]) }) // claims
      .mockReturnValueOnce({ from: () => createMockChain([]) }) // relations
      .mockReturnValueOnce({ from: () => createMockChain([]) }); // sources

    // 3. persistKnowledge (update topic, deletes, inserts)
    // 4. final buildKnowledge
    mockDb.select.mockReturnValueOnce({ from: () => createMockChain([mockTopic]) });
    mockDb.select
      .mockReturnValueOnce({ from: () => createMockChain([mockClaim]) })
      .mockReturnValueOnce({ from: () => createMockChain([]) })
      .mockReturnValueOnce({ from: () => createMockChain([]) });

    const result = await repository.merge({
      topic: 'existing',
      claims: [{ text: 'New content for claim', confidence: 0.8, sourceIds: ['src-1'] }],
      sources: [{ id: 'src-1', url: 'http://example.com', fetchedAt: Date.now() }],
      relations: [],
      aliases: [],
    });

    expect(result.changed).toBe(true);
    // Since we didn't mock shouldMergeClaim/fingerprintText to differ, they might merge.
    // In this test, we just want to see it completes.
  });
});
