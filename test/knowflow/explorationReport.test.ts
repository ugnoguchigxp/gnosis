import { describe, expect, it } from 'bun:test';
import { buildExplorationReport } from '../../src/services/knowflow/report/explorationReport';

describe('exploration report', () => {
  it('builds a structured report with normalized budget and conflict strings', () => {
    const report = buildExplorationReport({
      topic: 'Graph RAG',
      now: 1_700_000_000_000,
      verification: {
        acceptedClaims: [{ text: 'Claim A', confidence: 0.9, sourceIds: ['s1'] }],
        rejectedClaims: [
          {
            claim: { text: 'Claim B', confidence: 0.2, sourceIds: ['s2'] },
            score: 0.2,
            reasons: ['low-overall-score'],
            blocking: false,
          },
        ],
        conflicts: [
          {
            leftClaim: 'A is true',
            rightClaim: 'A is not true',
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
      gaps: [
        {
          type: 'weak_evidence',
          description: 'Need more independent sources.',
          priority: 0.8,
          origin: 'rule',
        },
      ],
      budgetUsed: 8,
      budgetLimit: 5,
    });

    expect(report.topic).toBe('Graph RAG');
    expect(report.generatedAt).toBe(1_700_000_000_000);
    expect(report.summary).toBe('Accepted 1 claims, rejected 1, conflicts 1, gaps 1');
    expect(report.acceptedClaims).toEqual(['Claim A']);
    expect(report.rejectedClaims).toEqual(['Claim B']);
    expect(report.conflicts).toEqual(['A is true <> A is not true']);
    expect(report.budget.used).toBe(8);
    expect(report.budget.limit).toBe(5);
    expect(report.budget.remaining).toBe(0);
  });
});
