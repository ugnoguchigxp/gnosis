import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const mockLookupFailureFirewallContext = mock(async () => ({
  shouldUse: true,
  reason: 'Matched raw lesson evidence for risk signals: auth',
  riskSignals: ['auth'],
  changedFiles: ['src/auth/middleware.ts'],
  lessonCandidates: [
    {
      id: 'note/auth-lesson',
      title: 'Keep auth guard boundaries explicit',
      kind: 'lesson',
      content: 'Preserve authorization checks when middleware changes.',
      tags: ['auth'],
      files: ['src/auth/middleware.ts'],
      evidence: [],
      riskSignals: ['auth'],
      score: 0.9,
      reason: 'risk_signal_overlap=1.00',
      source: 'entity',
      blocking: false,
    },
  ],
  goldenPathCandidates: [],
  failurePatternCandidates: [],
  suggestedUse: 'review_reference',
  degradedReasons: [],
}));

import { runReviewAgentic } from '../src/services/review/orchestrator.js';

const envBackup = {
  GNOSIS_ALLOWED_ROOTS: process.env.GNOSIS_ALLOWED_ROOTS,
};

const authDiff = [
  'diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts',
  '--- a/src/auth/middleware.ts',
  '+++ b/src/auth/middleware.ts',
  '@@ -1 +1,2 @@',
  ' export const guard = requireAuth;',
  '+export const tokenName = "session";',
].join('\n');

beforeEach(() => {
  process.env.GNOSIS_ALLOWED_ROOTS = '/tmp';
  mockLookupFailureFirewallContext.mockClear();
});

afterEach(() => {
  process.env.GNOSIS_ALLOWED_ROOTS = envBackup.GNOSIS_ALLOWED_ROOTS;
});

describe('review Failure Firewall context injection', () => {
  it('passes relevant raw lessons to the reviewer without changing the output schema', async () => {
    const reviewWithToolsFn = mock(async (_llm, messages) => {
      expect(
        messages.some(
          (message: { role: string; content: string }) =>
            message.role === 'system' && message.content.includes('note/auth-lesson'),
        ),
      ).toBe(true);
      expect(
        messages.some(
          (message: { role: string; content: string }) =>
            message.role === 'system' && message.content.includes('knowledge_refs'),
        ),
      ).toBe(true);
      return '{"findings":[],"summary":"ok","next_actions":[]}';
    });

    const result = await runReviewAgentic(
      {
        taskId: 'task-firewall-context',
        repoPath: '/tmp',
        baseRef: 'main',
        headRef: 'HEAD',
        trigger: 'manual',
        sessionId: 'code-review-repo:main',
        mode: 'git_diff',
        knowledgePolicy: 'off',
      },
      {
        diffProvider: async () => authDiff,
        llmService: { provider: 'cloud', generate: async () => '' } as never,
        failureFirewallContextFn: mockLookupFailureFirewallContext as never,
        persistReviewCaseFn: async () => undefined,
        recordReviewResultFn: async () => ({ updated: 0 }),
        reviewWithToolsFn,
      },
    );

    expect(result.review_status).toBe('no_major_findings');
    expect(result.findings).toEqual([]);
    expect(mockLookupFailureFirewallContext).toHaveBeenCalledTimes(1);
  });

  it('preserves lesson ids in knowledge_refs when the reviewer uses raw lesson evidence', async () => {
    const reviewWithToolsFn = mock(async () =>
      JSON.stringify({
        findings: [
          {
            title: 'Auth guard evidence needs verification',
            severity: 'warning',
            confidence: 'medium',
            file_path: 'src/auth/middleware.ts',
            line_new: 2,
            category: 'security',
            rationale: 'The raw lesson calls out auth guard boundary regressions for this file.',
            evidence: 'export const tokenName = "session";',
            knowledge_refs: ['note/auth-lesson'],
          },
        ],
        summary: 'one finding',
        next_actions: [],
      }),
    );

    const result = await runReviewAgentic(
      {
        taskId: 'task-firewall-refs',
        repoPath: '/tmp',
        baseRef: 'main',
        headRef: 'HEAD',
        trigger: 'manual',
        sessionId: 'code-review-repo:main',
        mode: 'git_diff',
        knowledgePolicy: 'off',
      },
      {
        diffProvider: async () => authDiff,
        llmService: { provider: 'cloud', generate: async () => '' } as never,
        failureFirewallContextFn: mockLookupFailureFirewallContext as never,
        persistReviewCaseFn: async () => undefined,
        recordReviewResultFn: async () => ({ updated: 0 }),
        reviewWithToolsFn,
      },
    );

    expect(result.findings[0]?.knowledge_refs).toEqual(['note/auth-lesson']);
    expect(result.metadata.knowledge_applied).toEqual(['note/auth-lesson']);
  });
});
