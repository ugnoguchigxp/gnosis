import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { runReviewAgentic } from '../src/services/review/orchestrator.js';
import type { GuidanceItem } from '../src/services/review/types.js';

const envBackup = {
  GNOSIS_ALLOWED_ROOTS: process.env.GNOSIS_ALLOWED_ROOTS,
  GNOSIS_REVIEW_EMPTY_KNOWLEDGE_MODE: process.env.GNOSIS_REVIEW_EMPTY_KNOWLEDGE_MODE,
};

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -0,0 +1 @@
+const a = 1;
`;

const baseRequest = {
  taskId: 'task-e',
  repoPath: '/tmp',
  baseRef: 'main',
  headRef: 'HEAD',
  trigger: 'manual' as const,
  sessionId: 'code-review-repo:main',
  mode: 'git_diff' as const,
  knowledgePolicy: 'required' as const,
};

const fakeCloudLlm = {
  provider: 'cloud' as const,
  generate: async () => '',
};

beforeEach(() => {
  process.env.GNOSIS_ALLOWED_ROOTS = '/tmp';
  process.env.GNOSIS_REVIEW_EMPTY_KNOWLEDGE_MODE = undefined;
});

afterEach(() => {
  process.env.GNOSIS_ALLOWED_ROOTS = envBackup.GNOSIS_ALLOWED_ROOTS;
  process.env.GNOSIS_REVIEW_EMPTY_KNOWLEDGE_MODE = envBackup.GNOSIS_REVIEW_EMPTY_KNOWLEDGE_MODE;
});

describe('review agentic (knowledge policy)', () => {
  it('fails when required knowledge retrieval raises an error', async () => {
    const retrieveGuidanceFn = async () => {
      throw new Error('database unavailable');
    };
    const reviewWithToolsFn = async () => '{"findings":[],"summary":"ok","next_actions":[]}';

    await expect(
      runReviewAgentic(baseRequest, {
        diffProvider: async () => DIFF,
        llmService: fakeCloudLlm as never,
        retrieveGuidanceFn,
        reviewWithToolsFn,
      }),
    ).rejects.toThrow('[E008]');
  });

  it('marks no_applicable_knowledge as degraded (not hard-fail)', async () => {
    const principle: GuidanceItem = {
      id: 'guidance-1',
      title: 'Validate new branches',
      content: 'Check added branches for null handling.',
      guidanceType: 'rule',
      scope: 'on_demand',
      priority: 10,
      tags: ['principle'],
    };
    const retrieveGuidanceFn = async () => ({
      principles: [principle],
      heuristics: [],
      patterns: [],
      skills: [],
      benchmarks: [],
    });
    const reviewWithToolsFn = async () =>
      JSON.stringify({
        findings: [
          {
            title: 'Potential null issue',
            severity: 'warning',
            confidence: 'high',
            file_path: 'src/a.ts',
            line_new: 1,
            category: 'bug',
            rationale: 'added path may receive null',
            evidence: 'const a = 1;',
          },
        ],
        summary: 'one finding',
        next_actions: [],
      });

    const result = await runReviewAgentic(baseRequest, {
      diffProvider: async () => DIFF,
      llmService: fakeCloudLlm as never,
      retrieveGuidanceFn,
      reviewWithToolsFn,
    });

    expect(result.metadata.knowledge_retrieval_status).toBe('no_applicable_knowledge');
    expect(result.metadata.degraded_mode).toBe(true);
    expect(result.metadata.degraded_reasons).toContain('knowledge_no_applicable');
    expect(result.findings[0]?.knowledge_basis).toBe('novel_issue');
  });

  it('fails on empty index when empty-knowledge mode is fail', async () => {
    process.env.GNOSIS_REVIEW_EMPTY_KNOWLEDGE_MODE = 'fail';
    const retrieveGuidanceFn = async () => ({
      principles: [],
      heuristics: [],
      patterns: [],
      skills: [],
      benchmarks: [],
    });
    const reviewWithToolsFn = async () => '{"findings":[],"summary":"ok","next_actions":[]}';

    await expect(
      runReviewAgentic(baseRequest, {
        diffProvider: async () => DIFF,
        llmService: fakeCloudLlm as never,
        retrieveGuidanceFn,
        reviewWithToolsFn,
      }),
    ).rejects.toThrow('[E008]');
  });

  it('keeps running on empty index when empty-knowledge mode is warn', async () => {
    process.env.GNOSIS_REVIEW_EMPTY_KNOWLEDGE_MODE = 'warn';
    const retrieveGuidanceFn = async () => ({
      principles: [],
      heuristics: [],
      patterns: [],
      skills: [],
      benchmarks: [],
    });
    const reviewWithToolsFn = async () =>
      JSON.stringify({
        findings: [
          {
            title: 'Potential issue',
            severity: 'warning',
            confidence: 'high',
            file_path: 'src/a.ts',
            line_new: 1,
            category: 'bug',
            rationale: 'guard path',
            evidence: 'const a = 1;',
          },
        ],
        summary: 'ok',
        next_actions: [],
      });

    const result = await runReviewAgentic(baseRequest, {
      diffProvider: async () => DIFF,
      llmService: fakeCloudLlm as never,
      retrieveGuidanceFn,
      reviewWithToolsFn,
    });

    expect(result.metadata.knowledge_retrieval_status).toBe('empty_index');
    expect(result.metadata.degraded_mode).toBe(true);
    expect(result.metadata.degraded_reasons).toContain('knowledge_empty_index');
  });
});
