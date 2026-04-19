import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { config } from '../src/config.js';
import { entities, relations, vibeMemories } from '../src/db/schema.js';
import { queryProcedure, recordOutcome, updateConfidence } from '../src/services/procedure.js';

describe('procedure service', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mock
  let mockDb: any;
  const mockEmbed = async () => new Array(config.embeddingDimension).fill(0.1);

  const mockGoal = {
    id: 'g1',
    name: 'Goal',
    description: 'desc',
    confidence: 1.0,
    similarity: 0.9,
  };
  const mockTask1 = {
    id: 't1',
    name: 'Task 1',
    description: 'd1',
    confidence: 0.8,
    type: 'task',
  };
  const mockTask2 = {
    id: 't2',
    name: 'Task 2',
    description: 'd2',
    confidence: 0.7,
    type: 'task',
  };

  // biome-ignore lint/suspicious/noExplicitAny: mock
  const createMockChain = (data: any[] = []) => {
    // biome-ignore lint/suspicious/noExplicitAny: mock
    const chain: any = {
      where: mock(() => chain),
      orderBy: mock(() => chain),
      limit: mock(() => chain),
      innerJoin: mock(() => chain),
      for: mock(() => chain),
      onConflictDoUpdate: mock(() => chain),
      onConflictDoNothing: mock(() => chain),
      set: mock(() => chain),
      values: mock(() => chain),
      returning: mock(async () => data),
      // biome-ignore lint/suspicious/noThenProperty: drizzle thenable
      // biome-ignore lint/suspicious/noExplicitAny: mock
      then: (resolve: any) => Promise.resolve(data).then(resolve),
    };
    return chain;
  };

  beforeEach(() => {
    mockDb = {
      // biome-ignore lint/suspicious/noExplicitAny: mock
      select: mock((cols: any) => ({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        from: mock((table: any) => {
          // Default behaviors based on table/context
          if (table === entities) {
            // biome-ignore lint/suspicious/noExplicitAny: mock
            if (cols && (cols as any).similarity) return createMockChain([mockGoal]);
            // For recordOutcome/confidence update
            return createMockChain([mockTask1]);
          }
          if (table === relations) return createMockChain([]);
          if (table === vibeMemories) return createMockChain([]);
          return createMockChain([]);
        }),
      })),
      insert: mock(() => ({ values: mock(() => createMockChain([{ id: 'mock-id' }])) })),
      update: mock(() => ({ set: mock(() => ({ where: mock(() => createMockChain([])) })) })),
      delete: mock(() => ({ where: mock(() => createMockChain([])) })),
      execute: mock(async () => []),
      // biome-ignore lint/suspicious/noExplicitAny: mock
      transaction: mock(async (callback: any) => callback(mockDb)),
    };
  });

  describe('queryProcedure', () => {
    it('returns full procedure with steps and sorting', async () => {
      let hopCount = 0;
      mockDb.select = mock((cols) => ({
        from: mock((table) => {
          if (table === entities) {
            // biome-ignore lint/suspicious/noExplicitAny: mock
            if (cols && (cols as any).similarity) return createMockChain([mockGoal]);
            // Task entities retrieval
            return createMockChain([mockTask1, mockTask2]);
          }
          if (table === relations) {
            if (hopCount === 0) {
              hopCount++;
              return createMockChain([{ targetId: 't1' }, { targetId: 't2' }]);
            }
            return createMockChain([]);
          }
          return createMockChain([]);
        }),
      }));

      const result = await queryProcedure('test goal', undefined, {
        database: mockDb,
        embed: mockEmbed,
      });

      expect(result).not.toBeNull();
      if (result) {
        expect(result.goal.id).toBe('g1');
        expect(result.tasks).toHaveLength(2);
        expect(result.tasks[0].id).toBe('t1');
      }
    });

    it('filters tasks by context if provided', async () => {
      const mockTaskMatched = { id: 'tm', name: 'Matched', type: 'task' };
      mockDb.select = mock((cols) => ({
        from: mock((table) => {
          if (table === entities) {
            // biome-ignore lint/suspicious/noExplicitAny: mock
            if (cols && (cols as any).similarity) return createMockChain([mockGoal]);
            return createMockChain([mockTaskMatched]);
          }
          if (table === relations) {
            // queryProcedure uses context filtering with ctxSimilarity, and step retrieval with targetId
            // biome-ignore lint/suspicious/noExplicitAny: mock
            if ((cols as any).ctxSimilarity)
              return createMockChain([{ targetId: 'tm', ctxSimilarity: 0.9 }]);
            // biome-ignore lint/suspicious/noExplicitAny: mock
            if ((cols as any).targetId) return createMockChain([{ targetId: 'tm' }]);
            return createMockChain([]);
          }
          return createMockChain([]);
        }),
      }));

      const result = await queryProcedure(
        'test',
        { context: 'specific' },
        { database: mockDb, embed: mockEmbed },
      );
      expect(result).not.toBeNull();
      if (result) {
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0].id).toBe('tm');
      }
    });
  });

  describe('recordOutcome', () => {
    it('updates confidence scores and records episode', async () => {
      const saveEntities = mock(async () => undefined);
      const saveRelations = mock(async () => undefined);

      await recordOutcome(
        {
          goalId: 'g1',
          taskResults: [{ taskId: 't1', followed: true, succeeded: true }],
          sessionId: 's1',
        },
        { database: mockDb, embed: mockEmbed, saveEntities, saveRelations },
      );

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.update).toHaveBeenCalled();
      expect(saveEntities).toHaveBeenCalled();
      expect(saveRelations).toHaveBeenCalled();
    });

    it('handles improvements if provided', async () => {
      const saveEntities = mock(async () => undefined);
      const saveRelations = mock(async () => undefined);

      await recordOutcome(
        {
          goalId: 'g1',
          taskResults: [{ taskId: 't1', followed: true, succeeded: true }],
          improvements: [{ type: 'add_task', suggestion: 'new one' }],
          sessionId: 's1',
        },
        { database: mockDb, embed: mockEmbed, saveEntities, saveRelations },
      );

      expect(mockDb.insert).toHaveBeenCalled();
      expect(saveEntities).toHaveBeenCalledTimes(2);
      expect(saveRelations).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateConfidence', () => {
    it('increases confidence on success', () => {
      const result = updateConfidence(0.5, 'followed_success');
      expect(result).toBeGreaterThan(0.5);
    });

    it('decreases confidence on failure', () => {
      const result = updateConfidence(0.5, 'followed_failure');
      expect(result).toBeLessThan(0.5);
    });
  });
});
