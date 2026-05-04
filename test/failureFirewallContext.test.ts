import { describe, expect, test } from 'bun:test';
import {
  entities,
  experienceLogs,
  failureFirewallGoldenPaths,
  failureFirewallPatterns,
  reviewOutcomes,
} from '../src/db/schema.js';
import { lookupFailureFirewallContext } from '../src/services/failureFirewall/context.js';

const cacheMissingDiff = [
  'diff --git a/src/users/hooks.ts b/src/users/hooks.ts',
  'index 0000000..1111111 100644',
  '--- a/src/users/hooks.ts',
  '+++ b/src/users/hooks.ts',
  '@@ -1,3 +1,10 @@',
  ' import { useMutation } from "@tanstack/react-query";',
  '+export function useSaveUser() {',
  '+  return useMutation({',
  '+    mutationFn: async (input: UserInput) => {',
  '+      return fetch("/api/users", { method: "POST", body: JSON.stringify(input) });',
  '+    },',
  '+  });',
  '+}',
].join('\n');

function rowsQuery<T>(rows: T[]) {
  return {
    where: () => Promise.resolve(rows),
  };
}

function makeLessonContextDb() {
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === failureFirewallGoldenPaths || table === failureFirewallPatterns) {
          return Promise.resolve([]);
        }
        if (table === reviewOutcomes) {
          return { where: () => Promise.resolve([]) };
        }
        if (table === experienceLogs) {
          return Promise.resolve([]);
        }
        if (table === entities) {
          return rowsQuery([
            {
              id: 'note/cache-lesson',
              name: 'Mutation cache update lesson',
              description:
                'State-changing mutations should invalidate or update the affected query key after success.',
              type: 'lesson',
              metadata: {
                kind: 'lesson',
                category: 'review',
                tags: ['cache_invalidation'],
                files: ['src/users/hooks.ts'],
                evidence: [{ type: 'review', value: 'accepted finding' }],
              },
              confidence: 0.8,
            },
          ]);
        }
        return Promise.resolve([]);
      },
    }),
  };
}

function makeThrowingDb() {
  return {
    select: () => ({
      from: () => {
        throw new Error('database should not be queried');
      },
    }),
  };
}

function makeStructuredContextDb() {
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === failureFirewallGoldenPaths) {
          return Promise.resolve([
            {
              id: 'dedicated-gp-context',
              title: 'Dedicated context path',
              pathType: 'mutation_cache_update',
              appliesWhen: ['mutation changes state'],
              requiredSteps: ['invalidate or update the affected query key on success'],
              allowedAlternatives: [],
              blockWhenMissing: [],
              severityWhenMissing: 'warning',
              riskSignals: ['cache_invalidation'],
              languages: ['typescript'],
              frameworks: ['React'],
              tags: ['failure-firewall'],
              status: 'active',
            },
          ]);
        }
        if (table === failureFirewallPatterns) {
          return Promise.resolve([]);
        }
        if (table === reviewOutcomes) {
          return { where: () => Promise.resolve([]) };
        }
        if (table === entities || table === experienceLogs) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      },
    }),
  };
}

describe('failure firewall context lookup', () => {
  test('skips docs-only changes', async () => {
    const context = await lookupFailureFirewallContext({
      files: ['docs/readme.md'],
      changeTypes: ['docs'],
      taskGoal: 'Update docs only',
    });

    expect(context.shouldUse).toBe(false);
    expect(context.suggestedUse).toBe('skip');
    expect(context.reason).toContain('Docs-only');
  });

  test('does not treat empty changeTypes as docs-only and skips database lookup without risk', async () => {
    const context = await lookupFailureFirewallContext({
      files: ['src/users/model.ts'],
      changeTypes: [],
      taskGoal: 'Rename a local variable',
      database: makeThrowingDb() as never,
    });

    expect(context.shouldUse).toBe(false);
    expect(context.riskSignals).not.toContain('docs_only');
    expect(context.degradedReasons).toEqual([]);
  });

  test('returns bounded golden path and failure candidates for risky diffs', async () => {
    const context = await lookupFailureFirewallContext({
      rawDiff: cacheMissingDiff,
      maxGoldenPaths: 2,
      maxFailurePatterns: 1,
    });

    expect(context.shouldUse).toBe(true);
    expect(context.riskSignals).toContain('cache_invalidation');
    expect(context.goldenPathCandidates.length).toBeLessThanOrEqual(2);
    expect(context.failurePatternCandidates.length).toBeLessThanOrEqual(1);
  });

  test('returns ordinary entity lessons as non-blocking context candidates', async () => {
    const context = await lookupFailureFirewallContext({
      rawDiff: cacheMissingDiff,
      knowledgeSource: 'dedicated',
      database: makeLessonContextDb() as never,
      maxGoldenPaths: 0,
      maxFailurePatterns: 0,
    });

    expect(context.shouldUse).toBe(true);
    expect(context.suggestedUse).toBe('review_reference');
    expect(context.lessonCandidates[0]?.id).toBe('note/cache-lesson');
    expect(context.lessonCandidates[0]?.blocking).toBe(false);
    expect(context.reason).toContain('raw lesson');
  });

  test('uses injected database when loading structured context candidates', async () => {
    const context = await lookupFailureFirewallContext({
      rawDiff: cacheMissingDiff,
      knowledgeSource: 'dedicated',
      database: makeStructuredContextDb() as never,
      maxFailurePatterns: 0,
      maxLessonCandidates: 0,
    });

    expect(context.goldenPathCandidates[0]?.id).toBe('dedicated-gp-context');
  });
});
