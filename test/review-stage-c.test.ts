import { afterEach, describe, expect, test } from 'bun:test';
import { getProjectKey, persistReviewCase } from '../src/services/review/knowledge/persister.js';
import {
  filterInapplicableGuidance,
  retrieveGuidance,
} from '../src/services/review/knowledge/retriever.js';
import { buildReviewPromptV3 } from '../src/services/review/llm/promptBuilder.js';
import type { GuidanceItem, ReviewOutput, ReviewRequest } from '../src/services/review/types.js';

const envBackup = {
  GNOSIS_ALLOWED_ROOTS: process.env.GNOSIS_ALLOWED_ROOTS,
};

afterEach(() => {
  process.env.GNOSIS_ALLOWED_ROOTS = envBackup.GNOSIS_ALLOWED_ROOTS;
});

function createGuidanceItem(
  overrides: Partial<GuidanceItem> & { id: string; title: string; content: string },
): GuidanceItem {
  return {
    id: overrides.id,
    title: overrides.title,
    content: overrides.content,
    guidanceType: overrides.guidanceType ?? 'rule',
    scope: overrides.scope ?? 'on_demand',
    priority: overrides.priority ?? 50,
    tags: overrides.tags ?? [],
    applicability: overrides.applicability,
  };
}

describe('review stage C', () => {
  test('filters guidance by applicability and builds V3 prompts', () => {
    const guidance: GuidanceItem[] = [
      createGuidanceItem({
        id: 'principle-1',
        title: 'Auth boundary',
        content: 'Check auth on all inputs.',
        tags: ['principle'],
        applicability: { signals: ['auth'], frameworks: ['Next.js'] },
      }),
      createGuidanceItem({
        id: 'heuristic-1',
        title: 'Config change',
        content: 'Treat config changes carefully.',
        tags: ['heuristic'],
        applicability: { excludedFrameworks: ['SvelteKit'] },
      }),
      createGuidanceItem({
        id: 'pattern-1',
        title: 'Migration guard',
        content: 'Include migrations with schema changes.',
        tags: ['pattern'],
        applicability: { signals: ['migration'] },
      }),
    ];

    const filtered = filterInapplicableGuidance(guidance, {
      language: 'typescript',
      framework: 'Next.js',
      riskSignals: ['auth', 'migration'],
    });

    expect(filtered.map((item) => item.id)).toEqual(['principle-1', 'heuristic-1', 'pattern-1']);

    const prompt = buildReviewPromptV3({
      instruction: 'Check security boundaries.',
      projectInfo: { language: 'TypeScript', framework: 'Next.js' },
      rawDiff: 'diff --git a/src/auth.ts b/src/auth.ts',
      diffSummary: {
        filesChanged: 1,
        linesAdded: 1,
        linesRemoved: 0,
        riskSignals: ['auth'],
      },
      selectedHunks: [],
      staticAnalysisFindings: [],
      impactAnalysis: undefined,
      recalledPrinciples: [guidance[0]],
      recalledHeuristics: [guidance[1]],
      recalledPatterns: [guidance[2]],
      optionalSkills: [],
      pastSimilarFindings: ['過去の類似指摘 (security) src/auth.ts: Missing token check'],
      pastSuccessBenchmarks: [
        '過去の成功実装 (secure-auth) Implementation using standard JWT helper',
      ],
      outputSchema: {},
    });

    expect(prompt).toContain('適用すべき原則');
    expect(prompt).toContain('過去の類似指摘');
    expect(prompt).toContain('Missing token check');
  });

  test('retrieves and ranks guidance entries from stored metadata', async () => {
    const rows = [
      {
        id: 'guide-1',
        content: 'Guard all auth inputs.',
        priority: 90,
        metadata: {
          title: 'Auth principle',
          tags: ['principle'],
          priority: 90,
          guidanceType: 'rule',
          scope: 'always',
          archiveKey: 'guide-1',
          applicability: { signals: ['auth'], frameworks: ['Next.js'] },
        },
        similarity: 0.92,
      },
      {
        id: 'guide-2',
        content: 'Review config changes.',
        priority: 70,
        metadata: {
          title: 'Config heuristic',
          tags: ['heuristic'],
          priority: 70,
          guidanceType: 'rule',
          scope: 'on_demand',
          archiveKey: 'guide-2',
          applicability: { signals: ['config_changed'] },
        },
        similarity: 0.88,
      },
    ];

    const database = {
      select() {
        return {
          from() {
            return {
              where() {
                return Promise.resolve([{ guidanceIds: ['guide-2'] }]);
              },
            };
          },
        };
      },
    } as never;

    let alwaysCalled = false;
    const result = await retrieveGuidance('repo', ['auth'], 'TypeScript', 'Next.js', {
      getAlwaysOnGuidance: async () => {
        alwaysCalled = true;
        return [rows[0]];
      },
      getOnDemandGuidance: async () => [rows[1]],
      database,
      searchMemory: async () => [], // Add mock for retrieving benchmarks
    });

    expect(alwaysCalled).toBe(false);
    expect(result.principles.map((item) => item.id)).not.toContain('guide-1');
    expect(result.heuristics).toHaveLength(0);
  });

  test('persists review case, experience, and findings memory', async () => {
    const calls: Array<{ table: string; payload: unknown }> = [];
    const fakeDatabase = {
      insert(table: { toString?: () => string }) {
        return {
          values(payload: unknown) {
            calls.push({ table: String(table), payload });
            return {
              onConflictDoUpdate: async () => undefined,
            };
          },
        };
      },
    } as never;

    const saveExperienceCalls: unknown[] = [];
    const saveMemoryCalls: unknown[] = [];

    const request: ReviewRequest = {
      taskId: 'task-1',
      repoPath: '/Users/y.noguchi/Code/gnosis',
      baseRef: 'main',
      headRef: 'HEAD',
      trigger: 'manual',
      sessionId: 'code-review-gnosis:main',
      mode: 'git_diff',
    };

    const result: ReviewOutput = {
      review_id: 'review-1',
      review_status: 'needs_confirmation',
      findings: [
        {
          id: 'finding-1',
          title: 'Missing validation',
          severity: 'warning',
          confidence: 'medium',
          file_path: 'src/app.ts',
          line_new: 12,
          category: 'validation',
          rationale: 'Input is not checked before use.',
          evidence: 'input',
          fingerprint: 'abcdef1234567890',
          needsHumanConfirmation: false,
          source: 'rule_engine',
          knowledge_refs: ['guide-1'],
        },
      ],
      summary: 'one finding',
      next_actions: ['confirm the validation path'],
      rerun_review: false,
      metadata: {
        reviewed_files: 1,
        risk_level: 'medium',
        static_analysis_used: false,
        knowledge_applied: ['guide-1'],
        degraded_mode: false,
        degraded_reasons: [],
        local_llm_used: false,
        heavy_llm_used: true,
        review_duration_ms: 10,
      },
      markdown: '# Code Review Results',
    };

    await persistReviewCase(request, result, {
      database: fakeDatabase,
      saveExperience: async (...args) => {
        saveExperienceCalls.push(args);
        return undefined as never;
      },
      saveMemory: async (...args) => {
        saveMemoryCalls.push(args);
        return undefined as never;
      },
      now: () => new Date('2026-04-15T00:00:00.000Z'),
    });

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(saveExperienceCalls).toHaveLength(1);
    expect(saveMemoryCalls).toHaveLength(2);
    expect(getProjectKey('/Users/y.noguchi/Code/gnosis')).toBe('gnosis');
  });
});
