import { describe, expect, it, mock } from 'bun:test';
import {
  buildAgenticSearchTaskEnvelope,
  buildKnowledgeQueryText,
  recordTaskNote,
  searchKnowledgeV2,
  selectAgenticSearchPhrases,
} from '../src/services/agentFirst';

describe('agentFirst minimal utilities', () => {
  it('builds task envelope from MCP input', () => {
    const task = buildAgenticSearchTaskEnvelope({
      userRequest: 'Debug MCP host connection closed error in agentic search',
      intent: 'debug',
      files: ['src/mcp/tools/agentFirst.ts'],
      changeTypes: ['mcp', 'test'],
      technologies: ['typescript'],
    });

    expect(task.intent).toBe('debug');
    expect(task.tokens).toContain('debug');
    expect(task.files).toContain('src/mcp/tools/agentFirst.ts');
  });

  it('selects phrases for agenticSearch input', () => {
    const phrases = selectAgenticSearchPhrases({
      request: 'Refactor agentic search',
      intent: 'edit',
      repoPath: '/tmp/repo',
      files: ['src/services/agentFirst.ts'],
      changeTypes: ['mcp', 'refactor'],
      technologies: ['typescript'],
      tokens: ['agentic', 'search', 'refactor'],
    });

    expect(phrases).toContain('mcp');
    expect(phrases).toContain('typescript');
    expect(phrases.some((p) => p.includes('agentFirst.ts'))).toBe(true);
  });

  it('keeps selected phrases available for SystemContext evaluation', () => {
    const task = buildAgenticSearchTaskEnvelope({
      userRequest: 'Review agentic search fallback',
      changeTypes: ['mcp'],
      technologies: ['typescript'],
    });

    expect(selectAgenticSearchPhrases(task)).toContain('agentic');
  });

  it('builds deterministic retrieval text from task context', () => {
    const queryText = buildKnowledgeQueryText({
      taskGoal: 'Improve Gnosis knowledge retrieval',
      query: 'embedding search',
      files: ['src/services/entityKnowledge.ts'],
      changeTypes: ['mcp', 'backend'],
      technologies: ['TypeScript', 'pgvector'],
      intent: 'edit',
    });

    expect(queryText).toContain('Improve Gnosis knowledge retrieval');
    expect(queryText).toContain('embedding search');
    expect(queryText).toContain('src/services/entityKnowledge.ts');
    expect(queryText).toContain('pgvector');
    expect(queryText.length).toBeLessThanOrEqual(1200);
  });

  it('returns raw retrieval telemetry from merged knowledge search', async () => {
    const searchEntityKnowledge = mock(async () => ({
      results: [
        {
          id: 'note/1',
          type: 'lesson',
          title: 'Merged retrieval',
          content: 'Vector and full-text hits should be merged.',
          metadata: {},
          confidence: 0.8,
          referenceCount: 1,
          freshness: null,
          createdAt: new Date('2026-05-05T00:00:00.000Z'),
          score: 0.91,
          source: 'vector',
          matchSources: ['vector', 'full_text'],
          sourceScores: { vector: 0.91, full_text: 0.2 },
        },
      ],
      telemetry: {
        queryText: 'Improve retrieval embedding TypeScript',
        vectorHitCount: 1,
        exactHitCount: 0,
        fullTextHitCount: 1,
        directTextHitCount: 0,
        recentFallbackUsed: false,
        embeddingStatus: 'used',
        mergedCandidateCount: 1,
      },
    }));

    const result = await searchKnowledgeV2(
      {
        taskGoal: 'Improve retrieval',
        query: 'embedding',
        technologies: ['TypeScript'],
      },
      { searchEntityKnowledge: searchEntityKnowledge as never },
    );

    expect(searchEntityKnowledge).toHaveBeenCalledWith({
      query: 'Improve retrieval embedding TypeScript',
      type: 'all',
      limit: 10,
    });
    expect(result.retrieval).toMatchObject({
      mode: 'merged_embedding_and_lexical',
      vectorHitCount: 1,
      fullTextHitCount: 1,
      embeddingStatus: 'used',
      mergedCandidateCount: 1,
    });
    expect(result.flatTopHits[0]).toMatchObject({
      id: 'note/1',
      matchSources: ['vector', 'full_text'],
    });
  });

  it('records task notes as searchable entities with metadata and embeddings', async () => {
    const insertedValues: unknown[] = [];
    const onConflictDoUpdate = mock(async () => undefined);
    const values = mock((value: unknown) => {
      insertedValues.push(value);
      return { onConflictDoUpdate };
    });
    const insert = mock(() => ({ values }));
    const generateKnowledgeEmbedding = mock(async () => new Array(384).fill(0.1));

    const result = await recordTaskNote(
      {
        content: 'MCP knowledge search should merge vector and lexical candidates.',
        kind: 'procedure',
        category: 'mcp',
        title: 'Merge knowledge retrieval candidates',
        files: ['src/services/entityKnowledge.ts'],
        triggerPhrases: ['knowledge retrieval'],
        appliesWhen: ['mcp search'],
        metadata: { triggerPhrases: ['embedding search'] },
        tags: ['Retrieval'],
      },
      {
        database: { insert } as never,
        generateKnowledgeEmbedding: generateKnowledgeEmbedding as never,
      },
    );

    expect(result).toMatchObject({
      saved: true,
      kind: 'procedure',
      category: 'mcp',
      embeddingStatus: 'stored',
    });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(insertedValues[0]).toMatchObject({
      type: 'procedure',
      name: 'Merge knowledge retrieval candidates',
      description: 'MCP knowledge search should merge vector and lexical candidates.',
      embedding: expect.any(Array),
      metadata: {
        kind: 'procedure',
        category: 'mcp',
        files: ['src/services/entityKnowledge.ts'],
        tags: ['retrieval'],
        triggerPhrases: ['embedding search', 'knowledge retrieval'],
        appliesWhen: ['mcp search'],
      },
      provenance: 'manual',
      scope: 'task_note',
    });
  });
});
