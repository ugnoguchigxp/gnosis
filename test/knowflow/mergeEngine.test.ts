import { describe, expect, it } from 'bun:test';
import type { Knowledge, KnowledgeUpsertInput } from '../../src/knowflow/knowledge/types';
import { mergeVerifiedKnowledge, normalizeMergeInput } from '../../src/knowflow/merge';

describe('merge engine', () => {
  it('normalizes and dedupes merge input deterministically', () => {
    const normalized = normalizeMergeInput({
      topic: ' TypeScript Compiler API ',
      aliases: ['TS Compiler API', 'typescript compiler api'],
      acceptedClaims: [
        {
          text: 'Compiler API exposes AST nodes.',
          confidence: 0.8,
          sourceIds: ['s1'],
        },
        {
          text: 'Compiler API exposes AST nodes.',
          confidence: 0.6,
          sourceIds: ['s2'],
        },
      ],
      relations: [
        {
          type: 'compares_with',
          targetTopic: 'ts-morph',
          confidence: 0.6,
        },
        {
          type: 'compares_with',
          targetTopic: 'TS-MORPH',
          confidence: 0.8,
        },
      ],
      sources: [
        {
          id: 's1',
          url: 'https://example.com/1',
          fetchedAt: 100,
          title: 'old',
        },
        {
          id: 's1',
          url: 'https://example.com/1',
          fetchedAt: 200,
          title: 'new',
        },
      ],
    });

    expect(normalized.topic).toBe('TypeScript Compiler API');
    expect(normalized.claims).toHaveLength(1);
    expect(normalized.claims[0]?.sourceIds.sort()).toEqual(['s1', 's2']);
    expect(normalized.relations).toHaveLength(1);
    expect(normalized.relations[0]?.targetTopic).toBe('ts-morph');
    expect(normalized.sources).toHaveLength(1);
    expect(normalized.sources[0]?.fetchedAt).toBe(200);
  });

  it('delegates normalized payload to repository.merge', async () => {
    let capturedTopic = '';
    const repository = {
      async merge(input: KnowledgeUpsertInput) {
        capturedTopic = input.topic;
        const now = Date.now();
        const knowledge: Knowledge = {
          id: 'k1',
          canonicalTopic: 'typescript compiler api',
          aliases: [],
          claims: [],
          relations: [],
          sources: [],
          confidence: 0,
          coverage: 0,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        return {
          knowledge,
          changed: true,
        };
      },
    };

    const result = await mergeVerifiedKnowledge(repository, {
      topic: 'TypeScript Compiler API',
      acceptedClaims: [],
      relations: [],
      sources: [],
    });

    expect(capturedTopic).toBe('TypeScript Compiler API');
    expect(result.changed).toBe(true);
  });
});
