import { afterEach, describe, expect, test } from 'bun:test';
import { runReviewStageA } from '../src/services/review/orchestrator.js';
import { renderReviewMarkdown } from '../src/services/review/render/markdown.js';
import type { ReviewOutput } from '../src/services/review/types.js';

const envBackup = {
  GNOSIS_ALLOWED_ROOTS: process.env.GNOSIS_ALLOWED_ROOTS,
};

afterEach(() => {
  process.env.GNOSIS_ALLOWED_ROOTS = envBackup.GNOSIS_ALLOWED_ROOTS;
});

const SAMPLE_DIFF = `diff --git a/src/app.ts b/src/app.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/app.ts
@@ -0,0 +1 @@
+const value = input;`;

describe('stage A review flow', () => {
  test('renders markdown with degraded mode and no findings', () => {
    const output: ReviewOutput = {
      review_id: 'review-1',
      review_status: 'no_major_findings',
      findings: [],
      summary: 'No changes detected',
      next_actions: [],
      rerun_review: false,
      metadata: {
        reviewed_files: 0,
        risk_level: 'low',
        static_analysis_used: false,
        knowledge_applied: [],
        degraded_mode: true,
        degraded_reasons: ['llm_timeout'],
        local_llm_used: false,
        heavy_llm_used: false,
        review_duration_ms: 1,
      },
      markdown: '',
    };

    const markdown = renderReviewMarkdown(output);

    expect(markdown).toContain('Degraded Mode');
    expect(markdown).toContain('No Major Issues Found');
  });

  test('runs the stage A flow and filters hallucinated findings', async () => {
    const repoPath = '/tmp';
    process.env.GNOSIS_ALLOWED_ROOTS = '/tmp';

    const result = await runReviewStageA(
      {
        taskId: 'task-1',
        repoPath,
        baseRef: 'main',
        headRef: 'HEAD',
        trigger: 'manual',
        sessionId: 'code-review-repo:main',
        mode: 'git_diff',
      },
      {
        diffProvider: async () => SAMPLE_DIFF,
        llmService: {
          provider: 'cloud',
          async generate() {
            return JSON.stringify({
              summary: 'One valid finding and one hallucinated finding.',
              next_actions: ['Review the input validation path.'],
              findings: [
                {
                  id: 'f-001',
                  title: 'Missing validation',
                  severity: 'error',
                  confidence: 'high',
                  file_path: 'src/app.ts',
                  line_new: 1,
                  category: 'validation',
                  rationale: 'The input is used without validation.',
                  evidence: '+const value = input;',
                  needsHumanConfirmation: false,
                },
                {
                  id: 'f-002',
                  title: 'Hallucinated file',
                  severity: 'warning',
                  confidence: 'medium',
                  file_path: 'src/missing.ts',
                  line_new: 3,
                  category: 'bug',
                  rationale: 'This file does not exist in the diff.',
                  evidence: '+const impossible = true;',
                  needsHumanConfirmation: false,
                },
              ],
            });
          },
        },
      },
    );

    expect(result.review_status).toBe('changes_requested');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file_path).toBe('src/app.ts');
    expect(result.markdown).toContain('Missing validation');
    expect(result.markdown).not.toContain('src/missing.ts');
  });

  test('returns needs_confirmation when LLM times out', async () => {
    const repoPath = '/tmp';
    process.env.GNOSIS_ALLOWED_ROOTS = '/tmp';

    const result = await runReviewStageA(
      {
        taskId: 'task-timeout',
        repoPath,
        baseRef: 'main',
        headRef: 'HEAD',
        trigger: 'manual',
        sessionId: 'code-review-repo:main',
        mode: 'git_diff',
      },
      {
        diffProvider: async () => SAMPLE_DIFF,
        llmService: {
          provider: 'cloud',
          async generate() {
            return JSON.stringify({
              summary: 'Review timed out',
              next_actions: [],
              findings: [],
            });
          },
        },
      },
    );

    expect(result.review_status).toBe('needs_confirmation');
    expect(result.metadata.degraded_mode).toBe(true);
    expect(result.metadata.degraded_reasons).toContain('llm_timeout');
  });
});
