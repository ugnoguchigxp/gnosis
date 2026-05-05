import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockGenerateEmbedding = mock();
const mockSelect = mock();

import {
  searchEntityKnowledge,
  searchEntityKnowledgeDetailed,
} from '../src/services/entityKnowledge.js';

const makeSelectChain = (rows: unknown[]) => ({
  from: () => ({
    where: () => ({
      orderBy: () => ({
        limit: async (limit: number) => rows.slice(0, limit),
      }),
    }),
  }),
});

const mockSelectSequence = (rowSets: unknown[][]) => {
  let index = 0;
  mockSelect.mockImplementation(() => makeSelectChain(rowSets[index++] ?? []));
};

const row = (overrides: Record<string, unknown>) => ({
  id: 'entity-1',
  type: 'lesson',
  title: 'Embedding search lesson',
  content: 'Convert the query to an embedding before knowledge retrieval.',
  metadata: {},
  confidence: 0.8,
  referenceCount: 1,
  freshness: new Date('2026-05-05T00:00:00.000Z'),
  createdAt: new Date('2026-05-05T00:00:00.000Z'),
  score: 0.91,
  ...overrides,
});

describe('entity knowledge search', () => {
  beforeEach(() => {
    mockGenerateEmbedding.mockReset();
    mockSelect.mockReset();
  });

  it('generates a query embedding and merges vector candidates with other search paths', async () => {
    mockGenerateEmbedding.mockResolvedValue(new Array(384).fill(0.1));
    mockSelectSequence([[], [row({ id: 'entity-1', score: 0.91 })], [], []]);

    const results = await searchEntityKnowledge({
      query: 'embedding based MCP knowledge retrieval',
      type: 'all',
      limit: 3,
      database: { select: mockSelect } as never,
      generateQueryEmbedding: mockGenerateEmbedding as never,
    });

    expect(mockGenerateEmbedding).toHaveBeenCalledWith('embedding based MCP knowledge retrieval', {
      type: 'query',
      priority: 'high',
    });
    expect(mockSelect).toHaveBeenCalledTimes(4);
    expect(results[0]).toMatchObject({
      id: 'entity-1',
      score: 0.91,
      source: 'vector',
      matchSources: ['vector'],
    });
  });

  it('falls back to lexical search when embedding is unavailable', async () => {
    mockGenerateEmbedding.mockRejectedValue(new Error('embedding unavailable'));
    mockSelectSequence([
      [],
      [
        row({
          id: 'entity-2',
          type: 'rule',
          title: 'Lexical fallback rule',
          content: 'Fallback keeps MCP knowledge search useful when embedding is down.',
          confidence: 0.7,
          freshness: null,
          score: 0.42,
        }),
      ],
      [],
    ]);

    const results = await searchEntityKnowledge({
      query: 'fallback rule',
      type: 'rule',
      limit: 5,
      database: { select: mockSelect } as never,
      generateQueryEmbedding: mockGenerateEmbedding as never,
    });

    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
    expect(mockSelect).toHaveBeenCalledTimes(3);
    expect(results).toEqual([
      expect.objectContaining({
        id: 'entity-2',
        type: 'rule',
        score: 0.42,
        source: 'full_text',
      }),
    ]);
  });

  it('deduplicates the same entity across exact, vector, and full-text matches', async () => {
    mockGenerateEmbedding.mockResolvedValue(new Array(384).fill(0.1));
    mockSelectSequence([
      [row({ id: 'entity-1', score: 1 })],
      [row({ id: 'entity-1', score: 0.93 })],
      [row({ id: 'entity-1', score: 0.2 })],
      [],
    ]);

    const detailed = await searchEntityKnowledgeDetailed({
      query: 'Embedding search lesson',
      type: 'all',
      limit: 5,
      database: { select: mockSelect } as never,
      generateQueryEmbedding: mockGenerateEmbedding as never,
    });

    expect(detailed.results).toHaveLength(1);
    expect(detailed.results[0]).toMatchObject({
      id: 'entity-1',
      score: 1,
    });
    expect(detailed.results[0]?.matchSources.sort()).toEqual(['exact', 'full_text', 'vector']);
    expect(detailed.telemetry).toMatchObject({
      exactHitCount: 1,
      vectorHitCount: 1,
      fullTextHitCount: 1,
      directTextHitCount: 0,
      recentFallbackUsed: false,
      embeddingStatus: 'used',
      mergedCandidateCount: 1,
    });
  });

  it('uses recent fallback only when all primary retrieval paths are empty', async () => {
    mockGenerateEmbedding.mockResolvedValue(new Array(384).fill(0.1));
    mockSelectSequence([
      [],
      [],
      [],
      [],
      [row({ id: 'recent-1', title: 'Recent procedure', type: 'procedure', score: 0 })],
    ]);

    const detailed = await searchEntityKnowledgeDetailed({
      query: 'no direct hit query',
      type: 'all',
      limit: 5,
      database: { select: mockSelect } as never,
      generateQueryEmbedding: mockGenerateEmbedding as never,
    });

    expect(mockSelect).toHaveBeenCalledTimes(5);
    expect(detailed.results[0]).toMatchObject({
      id: 'recent-1',
      source: 'recent',
      score: 0.05,
    });
    expect(detailed.telemetry).toMatchObject({
      recentFallbackUsed: true,
      mergedCandidateCount: 1,
    });
  });
});
