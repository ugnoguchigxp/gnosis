import { describe, expect, test } from 'bun:test';
import { searchEntityKnowledgeDetailed } from '../src/services/entityKnowledge.js';

type SearchEntityKnowledgeInput = Parameters<typeof searchEntityKnowledgeDetailed>[0];
type EntityKnowledgeDb = NonNullable<SearchEntityKnowledgeInput['database']>;

describe('entity knowledge priority sorting', () => {
  test('prioritizes procedure over lesson when scores and sources are identical', async () => {
    // Mock database that returns a lesson and a procedure with same exact match criteria
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => [
                {
                  id: 'note/lesson1',
                  type: 'lesson',
                  title: 'A lesson',
                  content: 'Some content',
                  metadata: {},
                  confidence: 0.5,
                  referenceCount: 0,
                  freshness: new Date('2026-01-01'),
                  createdAt: new Date('2026-01-01'),
                  score: 1,
                },
                {
                  id: 'note/proc1',
                  type: 'procedure',
                  title: 'A procedure',
                  content: 'Some content',
                  metadata: {},
                  confidence: 0.5,
                  referenceCount: 0,
                  freshness: new Date('2026-01-01'),
                  createdAt: new Date('2026-01-01'),
                  score: 1,
                },
              ],
            }),
          }),
        }),
      }),
    } as unknown as EntityKnowledgeDb;

    const mockGenerateEmbedding = async () => {
      throw new Error('embedding unavailable');
    };

    const { results } = await searchEntityKnowledgeDetailed({
      query: 'test',
      database: mockDb,
      generateQueryEmbedding: mockGenerateEmbedding,
    });

    // procedure (7) > lesson (2), so proc1 should be first
    expect(results[0].id).toBe('note/proc1');
    expect(results[1].id).toBe('note/lesson1');
  });

  test('score difference still overrides type priority', async () => {
    let callCount = 0;
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: (n: number) => {
                callCount++;
                if (callCount !== 2) return []; // Only return for vector search (2nd call)
                return [
                  {
                    id: 'note/proc1',
                    type: 'procedure',
                    title: 'A procedure',
                    content: 'Some content',
                    metadata: {},
                    score: 0.7, // Lower similarity
                  },
                  {
                    id: 'note/lesson1',
                    type: 'lesson',
                    title: 'A lesson',
                    content: 'Some content',
                    metadata: {},
                    score: 0.8, // Higher similarity
                  },
                ];
              },
            }),
          }),
        }),
      }),
    } as unknown as EntityKnowledgeDb;

    const mockGenerateEmbedding = async () => [0.1]; // Trigger vector search

    const { results } = await searchEntityKnowledgeDetailed({
      query: 'test',
      database: mockDb,
      generateQueryEmbedding: mockGenerateEmbedding,
    });

    // lesson1 has score 0.8, proc1 has 0.7. Score wins.
    expect(results[0].id).toBe('note/lesson1');
    expect(results[1].id).toBe('note/proc1');
  });
});
