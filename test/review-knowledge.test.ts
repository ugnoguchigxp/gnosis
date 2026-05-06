import { describe, expect, it } from 'bun:test';
import {
  getProjectKey,
  recordFeedback,
  shouldResolveFindingFromCommit,
} from '../src/services/review/knowledge/persister.js';
import {
  calculateScore,
  retrieveSuccessBenchmarks,
  searchSimilarFindings,
  toGuidanceItem,
} from '../src/services/review/knowledge/retriever.js';

describe('review knowledge helpers', () => {
  it('normalizes project keys from repo paths', () => {
    expect(getProjectKey('/Users/test/My Repo')).toBe('my-repo');
    expect(getProjectKey('/tmp/feature/repo_name')).toBe('repo_name');
  });

  it('converts guidance rows with sensible defaults', () => {
    const item = toGuidanceItem({
      content: 'Prefer explicit auth guards.',
      metadata: {
        tags: ['principle', 'auth'],
        guidanceType: 'rule',
        scope: 'always',
        priority: 80,
      },
      similarity: 0.9,
    });

    expect(item.id).toBe('Prefer explicit auth guards.');
    expect(item.title).toBe('Prefer explicit auth guards.');
    expect(item.scope).toBe('always');
    expect(item.priority).toBe(80);
    expect(item.tags).toEqual(['principle', 'auth']);
  });

  it('computes bounded retrieval scores', () => {
    expect(
      calculateScore({
        semanticSimilarity: 0.9,
        signalMatch: 1,
        tagMatch: 1,
        falsePositivePenalty: 0,
      }),
    ).toBeCloseTo(0.95);

    expect(
      calculateScore({
        semanticSimilarity: 0,
        signalMatch: 0,
        tagMatch: 0,
        falsePositivePenalty: -10,
      }),
    ).toBe(0);
  });

  it('formats success benchmarks from successful memories', async () => {
    const results = await retrieveSuccessBenchmarks('gnosis', ['auth'], 'TypeScript', {
      searchMemory: async () => [
        {
          id: 'memory-1',
          content: 'Validated JWT expiry before accepting the session.',
          createdAt: new Date('2026-04-19T00:00:00Z'),
          metadata: { title: 'JWT guard', filePath: 'src/auth.ts' },
          similarity: 0.91,
        },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toContain('過去の成功実装');
    expect(results[0]).toContain('JWT guard');
    expect(results[0]).toContain('src/auth.ts');
  });

  it('formats similar findings from review memory results', async () => {
    const results = await searchSimilarFindings('gnosis', ['auth'], 'TypeScript', {
      searchMemory: async () => [
        {
          id: 'memory-2',
          content: 'A previous review found missing token expiry validation.',
          createdAt: new Date('2026-04-19T00:00:00Z'),
          metadata: {
            category: 'security',
            title: 'Token expiry check',
            filePath: 'src/auth.ts',
          },
          similarity: 0.84,
        },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toContain('過去の類似指摘');
    expect(results[0]).toContain('security');
    expect(results[0]).toContain('Token expiry check');
  });

  it('upserts reviewer feedback with the provided guidance ids', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const fakeDb = {
      insert() {
        return {
          values(payload: Record<string, unknown>) {
            payloads.push(payload);
            return {
              onConflictDoUpdate: async () => undefined,
            };
          },
        };
      },
    } as never;

    await recordFeedback(
      'review-1',
      'finding-1',
      'dismissed',
      {
        notes: 'False positive after manual inspection.',
        falsePositive: true,
        guidanceIds: ['guide-1', 'guide-2'],
      },
      fakeDb,
    );

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.guidanceIds).toEqual(['guide-1', 'guide-2']);
    expect(payloads[0]?.falsePositive).toBe(true);
    expect(payloads[0]?.outcomeType).toBe('dismissed');
  });

  it('requires explicit evidence before marking reviewer feedback non-pending', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const fakeDb = {
      insert() {
        return {
          values(payload: Record<string, unknown>) {
            payloads.push(payload);
            return {
              onConflictDoUpdate: async () => undefined,
            };
          },
        };
      },
    } as never;

    await expect(
      recordFeedback('review-1', 'finding-1', 'resolved', { notes: 'fixed' }, fakeDb),
    ).rejects.toThrow('followupCommitHash');
    await expect(
      recordFeedback(
        'review-1',
        'finding-1',
        'adopted',
        { notes: 'accepted', followupCommitHash: 'abc123' },
        fakeDb,
      ),
    ).rejects.toThrow('only valid for resolved');
    await expect(recordFeedback('review-1', 'finding-1', 'dismissed', {}, fakeDb)).rejects.toThrow(
      'notes evidence',
    );

    const resolvedAt = new Date('2026-05-06T00:00:00.000Z');
    await recordFeedback(
      'review-1',
      'finding-1',
      'resolved',
      {
        notes: 'fixed by commit',
        followupCommitHash: 'abc123',
        resolutionTimestamp: resolvedAt,
        autoDetected: true,
      },
      fakeDb,
    );

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.outcomeType).toBe('resolved');
    expect(payloads[0]?.followupCommitHash).toBe('abc123');
    expect(payloads[0]?.resolutionTimestamp).toBe(resolvedAt);
    expect(payloads[0]?.autoDetected).toBe(true);
  });

  it('only auto-resolves findings when commit evidence explicitly links case, finding, and file', () => {
    expect(
      shouldResolveFindingFromCommit({
        reviewCaseId: 'review-1',
        findingId: 'finding-1',
        filePath: 'src/app.ts',
        commitMessage: 'Fix review-1 finding-1 validation issue',
        changedFiles: ['src/app.ts'],
      }),
    ).toBe(true);

    expect(
      shouldResolveFindingFromCommit({
        reviewCaseId: 'review-1',
        findingId: 'finding-1',
        filePath: 'src/app.ts',
        commitMessage: 'Fix validation issue',
        changedFiles: ['src/app.ts'],
      }),
    ).toBe(false);

    expect(
      shouldResolveFindingFromCommit({
        reviewCaseId: 'review-1',
        findingId: 'finding-1',
        filePath: 'src/app.ts',
        commitMessage: 'Fix review-1 finding-1 validation issue',
        changedFiles: ['src/other.ts'],
      }),
    ).toBe(false);
  });
});
