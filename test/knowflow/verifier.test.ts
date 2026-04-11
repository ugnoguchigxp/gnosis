import { describe, expect, it } from 'bun:test';
import { buildVerificationSummary, verifyEvidence } from '../../src/services/knowflow/verifier';

describe('verifier', () => {
  it('returns accepted/rejected/conflicts from deterministic rules', () => {
    const now = Date.now();
    const result = verifyEvidence({
      topic: 'TypeScript',
      now,
      sources: [
        {
          id: 'src-1',
          domain: 'docs.typescriptlang.org',
          fetchedAt: now - 3 * 24 * 60 * 60 * 1000,
          qualityScore: 0.95,
        },
        {
          id: 'src-2',
          domain: 'developer.mozilla.org',
          fetchedAt: now - 10 * 24 * 60 * 60 * 1000,
          qualityScore: 0.9,
        },
        {
          id: 'src-3',
          domain: 'random-blog.example',
          fetchedAt: now - 600 * 24 * 60 * 60 * 1000,
          qualityScore: 0.3,
        },
      ],
      claims: [
        {
          text: 'TypeScript is a typed superset of JavaScript.',
          confidence: 0.9,
          sourceIds: ['src-1', 'src-2'],
        },
        {
          text: 'TypeScript is not a typed superset of JavaScript.',
          confidence: 0.85,
          sourceIds: ['src-3'],
        },
        {
          text: 'TypeScript is a typed superset of JavaScript.',
          confidence: 0.4,
          sourceIds: ['src-1'],
        },
      ],
    });

    expect(result.acceptedClaims).toHaveLength(1);
    expect(result.acceptedClaims[0]?.text).toContain('typed superset');
    expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(result.rejectedClaims.length).toBe(2);
    expect(result.rejectedClaims.some((item) => item.reasons.includes('duplication'))).toBe(true);
    expect(
      result.rejectedClaims.some((item) => item.reasons.includes('contradiction-detected')),
    ).toBe(true);
  });

  it('builds summary for queue resultSummary', () => {
    const summary = buildVerificationSummary({
      acceptedClaims: [
        {
          text: 'A',
          confidence: 0.8,
          sourceIds: ['s1'],
        },
      ],
      rejectedClaims: [
        {
          claim: { text: 'B', sourceIds: [], confidence: 0.1 },
          score: 0.1,
          reasons: ['low-overall-score'],
          blocking: false,
        },
      ],
      conflicts: [],
      metrics: {
        totalClaims: 2,
        acceptedCount: 1,
        rejectedCount: 1,
        conflictCount: 0,
      },
    });
    expect(summary).toContain('accepted=1');
    expect(summary).toContain('rejected=1');
  });
});
