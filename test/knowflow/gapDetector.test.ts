import { describe, expect, it } from 'bun:test';
import { detectGaps } from '../../src/services/knowflow/gap/detector';

describe('gap detector', () => {
  it('combines rule-based gaps and llm gaps', () => {
    const now = Date.now();
    const result = detectGaps({
      topic: 'TypeScript Compiler API',
      now,
      knowledge: {
        id: 'k1',
        canonicalTopic: 'typescript compiler api',
        aliases: ['typescript compiler api'],
        claims: [
          {
            id: 'c1',
            text: 'Compiler API allows AST traversal.',
            confidence: 0.7,
            sourceIds: ['src-1'],
          },
        ],
        relations: [],
        sources: [
          {
            id: 'src-1',
            url: 'https://example.com/old',
            fetchedAt: now - 500 * 24 * 60 * 60 * 1000,
            domain: 'example.com',
          },
        ],
        confidence: 0.7,
        coverage: 0.2,
        version: 1,
        createdAt: now - 500 * 24 * 60 * 60 * 1000,
        updatedAt: now - 500 * 24 * 60 * 60 * 1000,
      },
      verifierResult: {
        acceptedClaims: [],
        rejectedClaims: [
          {
            claim: {
              text: 'Compiler API cannot parse TypeScript.',
              confidence: 0.2,
              sourceIds: ['src-1'],
            },
            score: 0.2,
            reasons: ['contradiction-detected'],
            blocking: true,
          },
        ],
        conflicts: [
          {
            leftClaim: 'Compiler API can parse TypeScript.',
            rightClaim: 'Compiler API cannot parse TypeScript.',
            reason: 'contradiction',
          },
        ],
        metrics: {
          totalClaims: 2,
          acceptedCount: 1,
          rejectedCount: 1,
          conflictCount: 1,
        },
      },
      llmGaps: [
        {
          type: 'missing_example',
          description: 'Need concrete code examples.',
          priority: 0.9,
        },
      ],
    });

    const gapTypes = result.gaps.map((gap) => gap.type);
    expect(gapTypes).toContain('missing_definition');
    expect(gapTypes).toContain('missing_constraints');
    expect(gapTypes).toContain('weak_evidence');
    expect(gapTypes).toContain('outdated');
    expect(gapTypes).toContain('uncertain');
    expect(gapTypes).toContain('missing_example');

    const missingExample = result.gaps.find((gap) => gap.type === 'missing_example');
    expect(missingExample?.origin).toBe('merged');
    expect((missingExample?.priority ?? 0) >= 0.9).toBe(true);
  });
});
