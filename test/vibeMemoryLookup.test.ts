import { describe, expect, it, mock } from 'bun:test';
import { fetchVibeMemory, searchVibeMemories } from '../src/services/vibeMemoryLookup.js';

type SelectRow = Record<string, unknown>;

function createSelectChain(rows: SelectRow[]) {
  const chain = {
    from: mock(() => chain),
    where: mock(() => chain),
    orderBy: mock(() => chain),
    limit: mock(async () => rows),
  };
  return chain;
}

function createUpdateChain() {
  const chain = {
    set: mock(() => chain),
    where: mock(async () => undefined),
  };
  return chain;
}

function createMockDb(selectResults: SelectRow[][]) {
  const queue = [...selectResults];
  const updateChain = createUpdateChain();
  const database = {
    select: mock(() => createSelectChain(queue.shift() ?? [])),
    update: mock(() => updateChain),
  };
  return { database, updateChain };
}

describe('vibeMemoryLookup', () => {
  it('runs vector search with a query embedding and returns only thin snippets', async () => {
    const generateQueryEmbedding = mock(async () => [0.1, 0.2, 0.3]);
    const { database } = createMockDb([
      [
        {
          id: 'memory-1',
          sessionId: 'session-1',
          content: `before ${'x'.repeat(40)} target phrase ${'y'.repeat(40)} after`,
          createdAt: new Date('2026-05-06T00:00:00.000Z'),
          score: 0.82,
          metadata: { hidden: true },
        },
      ],
    ]);

    const result = await searchVibeMemories(
      { query: 'target phrase', mode: 'vector', maxSnippetChars: 40 },
      { database: database as never, generateQueryEmbedding },
    );

    expect(generateQueryEmbedding).toHaveBeenCalledWith('target phrase', {
      type: 'query',
      priority: 'high',
    });
    expect(result.retrieval.embeddingStatus).toBe('used');
    expect(result.retrieval.vectorHitCount).toBe(1);
    expect(result.retrieval.likeHitCount).toBe(0);
    expect(result.items[0]).toMatchObject({
      id: 'memory-1',
      sessionId: 'session-1',
      source: 'vector',
      matchSources: ['vector'],
      score: 0.82,
    });
    expect(result.items[0]?.snippet).toContain('target phrase');
    expect(result.items[0]).not.toHaveProperty('content');
    expect(result.items[0]).not.toHaveProperty('metadata');
  });

  it('runs LIKE search without embedding generation', async () => {
    const generateQueryEmbedding = mock(async () => [0.1]);
    const { database } = createMockDb([
      [
        {
          id: 'memory-like',
          sessionId: 'session-1',
          content: 'compressed context note',
          createdAt: new Date('2026-05-06T01:00:00.000Z'),
          score: 1,
        },
      ],
    ]);

    const result = await searchVibeMemories(
      { query: 'context', mode: 'like' },
      { database: database as never, generateQueryEmbedding },
    );

    expect(generateQueryEmbedding).not.toHaveBeenCalled();
    expect(result.retrieval.embeddingStatus).toBe('not_attempted');
    expect(result.items[0]).toMatchObject({
      id: 'memory-like',
      source: 'like',
      matchSources: ['like'],
      score: 1,
    });
  });

  it('merges hybrid vector and LIKE hits for the same memory id', async () => {
    const generateQueryEmbedding = mock(async () => [0.4]);
    const createdAt = new Date('2026-05-06T02:00:00.000Z');
    const { database } = createMockDb([
      [
        {
          id: 'memory-both',
          sessionId: 'session-1',
          content: 'vector side target',
          createdAt,
          score: 0.76,
        },
      ],
      [
        {
          id: 'memory-both',
          sessionId: 'session-1',
          content: 'like side target',
          createdAt,
          score: 1,
        },
      ],
    ]);

    const result = await searchVibeMemories(
      { query: 'target', mode: 'hybrid' },
      { database: database as never, generateQueryEmbedding },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'memory-both',
      source: 'like',
      matchSources: ['vector', 'like'],
      score: 1,
    });
  });

  it('falls back to LIKE in hybrid mode when embedding is unavailable', async () => {
    const generateQueryEmbedding = mock(async () => {
      throw new Error('embed unavailable');
    });
    const { database } = createMockDb([
      [
        {
          id: 'memory-like-only',
          sessionId: 'session-1',
          content: 'context survives embedding outage',
          createdAt: new Date('2026-05-06T03:00:00.000Z'),
          score: 1,
        },
      ],
    ]);

    const result = await searchVibeMemories(
      { query: 'context', mode: 'hybrid' },
      { database: database as never, generateQueryEmbedding },
    );

    expect(result.retrieval.embeddingStatus).toBe('unavailable');
    expect(result.degraded?.code).toBe('EMBEDDING_UNAVAILABLE');
    expect(result.items[0]?.id).toBe('memory-like-only');
  });

  it('fetches an explicit UTF-16 range and updates reference counters', async () => {
    const { database, updateChain } = createMockDb([
      [
        {
          id: 'memory-fetch',
          sessionId: 'session-1',
          content: '0123456789abcdef',
          createdAt: new Date('2026-05-06T04:00:00.000Z'),
        },
      ],
    ]);

    const result = await fetchVibeMemory(
      { id: 'memory-fetch', start: 2, end: 8 },
      { database: database as never },
    );

    expect(result.text).toBe('234567');
    expect(result.range).toMatchObject({
      start: 2,
      end: 8,
      totalChars: 16,
      source: 'explicit_range',
    });
    expect(result.excerpts[0]).toMatchObject({ matched: false, start: 2, end: 8 });
    expect(database.update).toHaveBeenCalledTimes(1);
    expect(updateChain.where).toHaveBeenCalledTimes(1);
  });

  it('caps explicit ranges by maxChars', async () => {
    const { database } = createMockDb([
      [
        {
          id: 'memory-capped',
          sessionId: 'session-1',
          content: '0123456789abcdef',
          createdAt: new Date('2026-05-06T04:30:00.000Z'),
        },
      ],
    ]);

    const result = await fetchVibeMemory(
      { id: 'memory-capped', start: 2, end: 12, maxChars: 5 },
      { database: database as never },
    );

    expect(result.text).toBe('23456');
    expect(result.range).toMatchObject({ start: 2, end: 7, source: 'explicit_range' });
    expect(result.truncated).toBe(true);
  });

  it('fetches query-centered excerpts with a default 1000 character window', async () => {
    const content = `${'a'.repeat(700)}needle phrase${'b'.repeat(700)}`;
    const { database } = createMockDb([
      [
        {
          id: 'memory-query',
          sessionId: 'session-1',
          content,
          createdAt: new Date('2026-05-06T05:00:00.000Z'),
        },
      ],
    ]);

    const result = await fetchVibeMemory(
      { id: 'memory-query', query: 'needle phrase' },
      { database: database as never },
    );

    expect(result.text.length).toBe(1000);
    expect(result.text).toContain('needle phrase');
    expect(result.range.source).toBe('query_match');
    expect(result.excerpts[0]?.matched).toBe(true);
  });

  it('returns a prefix fallback when no query match exists', async () => {
    const { database } = createMockDb([
      [
        {
          id: 'memory-prefix',
          sessionId: 'session-1',
          content: 'prefix only content',
          createdAt: new Date('2026-05-06T06:00:00.000Z'),
        },
      ],
    ]);

    const result = await fetchVibeMemory(
      { id: 'memory-prefix', query: 'missing' },
      { database: database as never },
    );

    expect(result.text).toBe('prefix only content');
    expect(result.range.source).toBe('prefix_fallback');
    expect(result.degraded?.code).toBe('NO_EXACT_EXCERPT_MATCH');
  });

  it('returns degraded results for missing memory and out-of-bounds ranges', async () => {
    const missingDb = createMockDb([[]]);
    const missing = await fetchVibeMemory(
      { id: 'missing' },
      { database: missingDb.database as never },
    );
    expect(missing.degraded?.code).toBe('MEMORY_NOT_FOUND');

    const outOfBoundsDb = createMockDb([
      [
        {
          id: 'memory-short',
          sessionId: 'session-1',
          content: 'short',
          createdAt: new Date('2026-05-06T07:00:00.000Z'),
        },
      ],
    ]);
    const outOfBounds = await fetchVibeMemory(
      { id: 'memory-short', start: 20 },
      { database: outOfBoundsDb.database as never },
    );
    expect(outOfBounds.text).toBe('');
    expect(outOfBounds.degraded?.code).toBe('RANGE_OUT_OF_BOUNDS');
  });
});
