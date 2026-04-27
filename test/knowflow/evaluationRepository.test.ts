import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { knowflowKeywordEvaluations } from '../../src/db/schema.js';
import { KeywordEvaluationRepository } from '../../src/services/knowflow/cron/evaluationRepository.js';

// Helper to create a Drizzle-like mock chain
// biome-ignore lint/suspicious/noExplicitAny: mock
const createMockChain = (data: any[] = []) => {
  // biome-ignore lint/suspicious/noExplicitAny: mock
  const chain: any = {
    where: mock(() => chain),
    orderBy: mock(() => chain),
    limit: mock(() => chain),
    returning: mock(async () => data),
    onConflictDoNothing: mock(() => ({
      returning: mock(async () => data),
    })),
    // biome-ignore lint/suspicious/noThenProperty: drizzle thenable
    // biome-ignore lint/suspicious/noExplicitAny: mock
    then: (resolve: any) => Promise.resolve(data).then(resolve),
  };
  return chain;
};

describe('KeywordEvaluationRepository', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mock
  let mockDb: any;
  let repository: KeywordEvaluationRepository;

  beforeEach(() => {
    mockDb = {
      select: mock(() => ({ from: mock(() => createMockChain([])) })),
      insert: mock(() => ({ values: mock(() => createMockChain([])) })),
      update: mock(() => ({ set: mock(() => ({ where: mock(() => createMockChain([])) })) })),
    };
    repository = new KeywordEvaluationRepository(mockDb);
  });

  it('saveEvaluations inserts rows', async () => {
    const runId = randomUUID();
    const rows = [
      {
        runId,
        sourceType: 'experience' as const,
        sourceId: 's1',
        topic: 'test',
        category: 'cat',
        whyResearch: 'why',
        searchScore: 8,
        termDifficultyScore: 5,
        uncertaintyScore: 3,
        threshold: 6.5,
        decision: 'enqueued' as const,
        modelAlias: 'gemma4' as const,
      },
    ];

    mockDb.insert.mockReturnValueOnce({
      values: mock(() => ({
        onConflictDoNothing: mock(() => ({
          returning: mock(async () => [{ id: '1' }]),
        })),
      })),
    });

    const count = await repository.saveEvaluations(rows);
    expect(count).toBe(1);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('attachEnqueuedTaskId updates record', async () => {
    const evalId = randomUUID();
    const taskId = randomUUID();

    mockDb.update.mockReturnValueOnce({
      set: mock(() => ({
        where: mock(() => createMockChain([{ id: evalId }])),
      })),
    });

    const success = await repository.attachEnqueuedTaskId(evalId, taskId);
    expect(success).toBe(true);
    expect(mockDb.update).toHaveBeenCalledWith(knowflowKeywordEvaluations);
  });

  it('listRecent fetches with limit', async () => {
    const mockData = [
      { id: '1', topic: 't1' },
      { id: '2', topic: 't2' },
    ];
    mockDb.select.mockReturnValueOnce({
      from: mock(() => ({
        orderBy: mock(() => ({
          limit: mock(async () => mockData),
        })),
      })),
    });

    const results = await repository.listRecent(2);
    expect(results).toHaveLength(2);
    expect(results[0].topic).toBe('t1');
  });

  it('listRecentEvaluations is an alias for listRecent', async () => {
    const mockData = [{ id: '1', topic: 't1' }];
    mockDb.select.mockReturnValueOnce({
      from: mock(() => ({
        orderBy: mock(() => ({
          limit: mock(async () => mockData),
        })),
      })),
    });

    const results = await repository.listRecentEvaluations(1);
    expect(results).toHaveLength(1);
  });
});
