import { afterEach, describe, expect, test } from 'bun:test';
import type { ReviewMcpToolCaller } from '../src/services/review/mcp/caller.js';
import { runReviewStageB } from '../src/services/review/orchestrator.js';
import { planReview } from '../src/services/review/planner/riskScorer.js';
import type { ReviewOutput } from '../src/services/review/types.js';

const envBackup = {
  GNOSIS_ALLOWED_ROOTS: process.env.GNOSIS_ALLOWED_ROOTS,
};

afterEach(() => {
  process.env.GNOSIS_ALLOWED_ROOTS = envBackup.GNOSIS_ALLOWED_ROOTS;
});

const SAMPLE_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/auth.ts
@@ -0,0 +1,6 @@
+export function requiresAuth(token: string) {
+  const normalized = token.trim();
+  const session = normalized.length > 0 ? { ok: true } : { ok: false };
+  return session.ok ? normalized : '';
+}
+
+export const authGuard = true;`;

function createMockMcpCaller() {
  return {
    async callTool(name: string) {
      if (name === 'mcp_diffguard_analyze_diff') {
        return {
          analysis: { files: [{ filePath: 'src/auth.ts', changeTypes: ['added'] }] },
          inferredFiles: ['src/auth.ts'],
        };
      }

      if (name === 'mcp_diffguard_review_diff') {
        return {
          findings: [
            {
              id: 'dg-1',
              file: 'src/auth.ts',
              line: 1,
              level: 'error',
              message: 'Auth guard should validate token expiration.',
              ruleId: 'DG001',
            },
          ],
        };
      }

      if (name === 'mcp_astmend_analyze_references_from_file') {
        return {
          references: [
            { file: 'src/auth.ts', line: 1, isDefinition: true },
            { file: 'src/consumer.ts', line: 12, isDefinition: false },
          ],
        };
      }

      if (name === 'mcp_astmend_detect_impact_from_file') {
        return {
          result: [{ name: 'requiresAuth', kind: 'function', file: 'src/auth.ts' }],
        };
      }

      return null;
    },
  };
}

describe('stage B review flow', () => {
  test('plans high risk changes and lowers low-risk changes', () => {
    expect(planReview(['auth'])).toMatchObject({
      riskLevel: 'high',
      useHeavyLLM: true,
      expandContext: true,
    });
    expect(planReview(['docs_only'])).toMatchObject({
      riskLevel: 'low',
      useHeavyLLM: false,
      expandContext: false,
    });
  });

  test('runs the stage B flow with structured diff and MCP findings', async () => {
    const repoPath = '/tmp';
    process.env.GNOSIS_ALLOWED_ROOTS = '/tmp';

    const result = (await runReviewStageB(
      {
        taskId: 'task-2',
        repoPath,
        baseRef: 'main',
        headRef: 'HEAD',
        trigger: 'manual',
        sessionId: 'code-review-repo:main',
        mode: 'git_diff',
        enableStaticAnalysis: false,
      },
      {
        diffProvider: async () => SAMPLE_DIFF,
        mcpCaller: createMockMcpCaller() as unknown as ReviewMcpToolCaller,
        llmService: {
          provider: 'cloud',
          async generate() {
            return JSON.stringify({
              summary: 'Auth helper needs stronger validation.',
              next_actions: ['Add token expiration checks.'],
              findings: [
                {
                  id: 'f-001',
                  title: 'Missing token validation',
                  severity: 'warning',
                  confidence: 'medium',
                  file_path: 'src/auth.ts',
                  line_new: 5,
                  category: 'security',
                  rationale: 'The token is returned without explicit expiration validation.',
                  evidence: '  return session.ok ? normalized : "";',
                  needsHumanConfirmation: false,
                },
                {
                  id: 'f-002',
                  title: 'Hallucinated file',
                  severity: 'error',
                  confidence: 'high',
                  file_path: 'src/missing.ts',
                  line_new: 1,
                  category: 'bug',
                  rationale: 'This file is not part of the diff.',
                  evidence: 'const missing = true;',
                  needsHumanConfirmation: false,
                },
              ],
            });
          },
        },
      },
    )) as ReviewOutput;

    expect(result.review_status).toBe('changes_requested');
    expect(result.metadata.risk_level).toBe('high');
    expect(result.metadata.static_analysis_used).toBe(true);
    expect(result.findings.some((finding) => finding.file_path === 'src/missing.ts')).toBe(false);
    expect(result.findings.some((finding) => finding.source === 'static_analysis')).toBe(true);
    expect(result.markdown).toContain('Source');
    expect(result.markdown).toContain('Missing token validation');
    expect(result.markdown).toContain('DG001');
  });
});
