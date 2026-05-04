import { afterEach, describe, expect, test } from 'bun:test';
import {
  entities,
  experienceLogs,
  failureFirewallGoldenPaths,
  failureFirewallPatterns,
  reviewOutcomes,
} from '../src/db/schema.js';
import { buildFailureDiffFeatures } from '../src/services/failureFirewall/diffFeatures.js';
import {
  resolveFailureFirewallGoalOptions,
  runFailureFirewall,
} from '../src/services/failureFirewall/index.js';
import { loadFailureKnowledge } from '../src/services/failureFirewall/patternStore.js';
import { runReviewAgentic } from '../src/services/review/orchestrator.js';

const envBackup = {
  GNOSIS_ALLOWED_ROOTS: process.env.GNOSIS_ALLOWED_ROOTS,
  GNOSIS_FAILURE_FIREWALL_KNOWLEDGE_SOURCE: process.env.GNOSIS_FAILURE_FIREWALL_KNOWLEDGE_SOURCE,
};

afterEach(() => {
  process.env.GNOSIS_ALLOWED_ROOTS = envBackup.GNOSIS_ALLOWED_ROOTS;
  process.env.GNOSIS_FAILURE_FIREWALL_KNOWLEDGE_SOURCE =
    envBackup.GNOSIS_FAILURE_FIREWALL_KNOWLEDGE_SOURCE;
});

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

const cachePresentDiff = [
  'diff --git a/src/users/hooks.ts b/src/users/hooks.ts',
  'index 0000000..1111111 100644',
  '--- a/src/users/hooks.ts',
  '+++ b/src/users/hooks.ts',
  '@@ -1,3 +1,12 @@',
  ' import { useMutation, useQueryClient } from "@tanstack/react-query";',
  '+export function useSaveUser() {',
  '+  const queryClient = useQueryClient();',
  '+  return useMutation({',
  '+    mutationFn: async (input: UserInput) => fetch("/api/users", { method: "POST" }),',
  '+    onSuccess: () => {',
  '+      queryClient.invalidateQueries({ queryKey: ["users"] });',
  '+    },',
  '+  });',
  '+}',
].join('\n');

const docsOnlyDiff = [
  'diff --git a/docs/readme.md b/docs/readme.md',
  'index 0000000..1111111 100644',
  '--- a/docs/readme.md',
  '+++ b/docs/readme.md',
  '@@ -1 +1,2 @@',
  ' # Readme',
  '+More text.',
].join('\n');

function makeFailureKnowledgeDb(
  options: {
    dedicatedFails?: boolean;
    entityFails?: boolean;
    dedicatedPatternId?: string;
    dedicatedPatternFalsePositiveCount?: number;
    frameworks?: string[];
    reviewOutcomeGuidanceIds?: string[][];
  } = {},
) {
  const frameworks = options.frameworks ?? ['React'];
  return {
    select: () => ({
      from: (table: unknown) => {
        if (options.dedicatedFails && table === failureFirewallGoldenPaths) {
          return Promise.reject(new Error('dedicated unavailable'));
        }
        if (options.dedicatedFails && table === failureFirewallPatterns) {
          return Promise.reject(new Error('dedicated unavailable'));
        }
        if (options.entityFails && table === entities) {
          return Promise.reject(new Error('entities unavailable'));
        }
        if (options.entityFails && table === experienceLogs) {
          return Promise.reject(new Error('experience unavailable'));
        }
        if (table === failureFirewallGoldenPaths) {
          return Promise.resolve([
            {
              id: 'dedicated-gp-cache',
              title: 'Dedicated cache path',
              pathType: 'mutation_cache_update',
              appliesWhen: ['mutation changes state'],
              requiredSteps: ['invalidate or update the affected query key on success'],
              allowedAlternatives: ['setQueryData updates the affected cache'],
              blockWhenMissing: ['invalidate or update the affected query key on success'],
              severityWhenMissing: 'warning',
              riskSignals: ['cache_invalidation'],
              languages: ['typescript'],
              frameworks,
              tags: ['failure-firewall', 'golden-path'],
              status: 'active',
            },
          ]);
        }
        if (table === failureFirewallPatterns) {
          const id = options.dedicatedPatternId ?? 'dedicated-ff-cache';
          return Promise.resolve([
            {
              id,
              title: 'Dedicated missing cache update',
              patternType: 'missing_cache_invalidation',
              severity: 'error',
              riskSignals: ['cache_invalidation'],
              languages: ['typescript'],
              frameworks,
              matchHints: ['mutation without cache update'],
              requiredEvidence: [
                'mutation-like code changed',
                'cache update call is absent in added lines',
              ],
              goldenPathId: 'dedicated-gp-cache',
              status: 'active',
              falsePositiveCount: options.dedicatedPatternFalsePositiveCount ?? 0,
            },
          ]);
        }
        if (table === entities) {
          return Promise.resolve([
            {
              id: 'dedicated-gp-cache',
              name: 'Entity fallback cache path',
              description: null,
              type: 'mutation_cache_update',
              metadata: {
                tags: ['golden-path'],
                goldenPath: {
                  title: 'Entity fallback cache path',
                  pathType: 'mutation_cache_update',
                  requiredSteps: ['entity required step'],
                  riskSignals: ['cache_invalidation'],
                  languages: ['typescript'],
                  frameworks: ['React'],
                },
              },
            },
          ]);
        }
        if (table === experienceLogs) {
          return Promise.resolve([]);
        }
        if (table === reviewOutcomes) {
          return {
            where: () =>
              Promise.resolve(
                (options.reviewOutcomeGuidanceIds ?? []).map((guidanceIds) => ({ guidanceIds })),
              ),
          };
        }
        return Promise.reject(new Error('unexpected table'));
      },
    }),
  };
}

describe('failure firewall', () => {
  test('extracts local risk signals from mutation diffs', () => {
    const features = buildFailureDiffFeatures(cacheMissingDiff);

    expect(features.riskSignals).toContain('cache_invalidation');
    expect(features.changedFiles).toEqual(['src/users/hooks.ts']);
  });

  test('flags missing cache invalidation as a recurrence candidate', async () => {
    const result = await runFailureFirewall({ rawDiff: cacheMissingDiff, mode: 'fast' });

    expect(result.status).toBe('changes_requested');
    expect(result.matches[0]?.failurePattern?.id).toBe('ff-cache-invalidation-mutation-001');
    expect(result.matches[0]?.severity).toBe('error');
  });

  test('does not flag docs-only changes or allowed cache alternatives', async () => {
    const docs = await runFailureFirewall({ rawDiff: docsOnlyDiff, mode: 'fast' });
    const present = await runFailureFirewall({ rawDiff: cachePresentDiff, mode: 'fast' });

    expect(docs.matches).toEqual([]);
    expect(docs.metadata.docsOnly).toBe(true);
    expect(present.matches).toEqual([]);
  });

  test('review agentic routes failure_firewall goals to the local firewall', async () => {
    process.env.GNOSIS_ALLOWED_ROOTS = '/tmp';

    const result = await runReviewAgentic(
      {
        taskId: 'task-ff',
        repoPath: '/tmp',
        baseRef: 'main',
        headRef: 'HEAD',
        trigger: 'manual',
        sessionId: 'code-review-repo:main',
        mode: 'git_diff',
        taskGoal: 'failure_firewall: detect recurrence',
      },
      {
        diffProvider: async () => cacheMissingDiff,
      },
    );

    expect(result.metadata.stage).toBe('failure_firewall');
    expect(result.findings[0]?.source).toBe('rule_engine');
    expect(result.review_status).toBe('changes_requested');
  });

  test('with_llm mode reports degraded local LLM adjudication without blocking fast findings', async () => {
    process.env.GNOSIS_ALLOWED_ROOTS = '/tmp';

    const result = await runReviewAgentic(
      {
        taskId: 'task-ff-llm',
        repoPath: '/tmp',
        baseRef: 'main',
        headRef: 'HEAD',
        trigger: 'manual',
        sessionId: 'code-review-repo:main',
        mode: 'git_diff',
        taskGoal: 'failure_firewall --with-llm',
      },
      {
        diffProvider: async () => cacheMissingDiff,
        llmService: {
          provider: 'local',
          generate: async () => 'not json',
        },
      },
    );

    expect(result.metadata.degraded_mode).toBe(true);
    expect(result.metadata.degraded_reasons).toEqual(['llm_unparseable']);
    expect(result.metadata.local_llm_used).toBe(true);
    expect(result.review_status).toBe('changes_requested');
  });

  test('parses review task goal options for local LLM and knowledge source switching', () => {
    expect(
      resolveFailureFirewallGoalOptions('failure_firewall --with-llm --knowledge-source dedicated'),
    ).toEqual({
      mode: 'with_llm',
      knowledgeSource: 'dedicated',
    });
    expect(resolveFailureFirewallGoalOptions('failure_firewall --knowledge-source=hybrid')).toEqual(
      {
        mode: 'fast',
        knowledgeSource: 'hybrid',
      },
    );
    expect(
      resolveFailureFirewallGoalOptions('failure_firewall --knowledge-source invalid'),
    ).toEqual({
      mode: 'fast',
    });
  });

  test('can switch to dedicated failure firewall tables without entity/experience reads', async () => {
    const knowledge = await loadFailureKnowledge({
      database: makeFailureKnowledgeDb() as never,
      knowledgeSource: 'dedicated',
    });

    expect(knowledge.goldenPaths[0]?.id).toBe('dedicated-gp-cache');
    expect(knowledge.goldenPaths[0]?.source).toBe('dedicated');
    expect(knowledge.failurePatterns[0]?.id).toBe('dedicated-ff-cache');
    expect(knowledge.failurePatterns[0]?.source).toBe('dedicated');
  });

  test('runFailureFirewall forwards knowledge source to the pattern store', async () => {
    const result = await runFailureFirewall({
      rawDiff: cacheMissingDiff,
      mode: 'fast',
      knowledgeSource: 'dedicated',
      database: makeFailureKnowledgeDb() as never,
    });

    expect(result.goldenPathsEvaluated).toBe(1);
    expect(result.patternsEvaluated).toBe(1);
    expect(result.matches[0]?.failurePattern?.source).toBe('dedicated');
    expect(result.matches[0]?.failurePattern?.id).toBe('dedicated-ff-cache');
  });

  test('matches dedicated framework names case-insensitively', async () => {
    const result = await runFailureFirewall({
      rawDiff: cacheMissingDiff,
      mode: 'fast',
      knowledgeSource: 'dedicated',
      database: makeFailureKnowledgeDb({ frameworks: ['react'] }) as never,
    });

    expect(result.matches[0]?.failurePattern?.id).toBe('dedicated-ff-cache');
  });

  test('hybrid mode prefers dedicated rows over seed and entity rows for the same id', async () => {
    const knowledge = await loadFailureKnowledge({
      database: makeFailureKnowledgeDb({
        dedicatedPatternId: 'ff-cache-invalidation-mutation-001',
      }) as never,
      knowledgeSource: 'hybrid',
    });

    const cachePattern = knowledge.failurePatterns.find(
      (pattern) => pattern.id === 'ff-cache-invalidation-mutation-001',
    );
    const cachePath = knowledge.goldenPaths.find((path) => path.id === 'dedicated-gp-cache');

    expect(cachePattern?.source).toBe('dedicated');
    expect(cachePattern?.title).toBe('Dedicated missing cache update');
    expect(cachePath?.source).toBe('dedicated');
    expect(cachePath?.title).toBe('Dedicated cache path');
  });

  test('hybrid mode falls back to seed and entity knowledge when dedicated tables are unavailable', async () => {
    const knowledge = await loadFailureKnowledge({
      database: makeFailureKnowledgeDb({ dedicatedFails: true }) as never,
      knowledgeSource: 'hybrid',
    });

    expect(knowledge.goldenPaths.some((path) => path.source === 'seed')).toBe(true);
    expect(knowledge.goldenPaths.some((path) => path.source === 'entity')).toBe(true);
  });

  test('dedicated false positive counts are authoritative and review outcome duplicates are ignored', async () => {
    const knowledge = await loadFailureKnowledge({
      database: makeFailureKnowledgeDb({
        dedicatedPatternFalsePositiveCount: 2,
        reviewOutcomeGuidanceIds: [
          ['dedicated-ff-cache', 'dedicated-ff-cache'],
          ['dedicated-ff-cache'],
        ],
      }) as never,
      knowledgeSource: 'dedicated',
    });

    expect(knowledge.failurePatterns[0]?.falsePositiveCount).toBe(2);
  });
});
