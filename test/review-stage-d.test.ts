import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildPatchOperation,
  generateFixSuggestion,
  isFixable,
} from '../src/services/review/knowledge/fixSuggester.js';
import { renderReviewMarkdown } from '../src/services/review/render/markdown.js';
import type { Finding, FixSuggestion, ReviewOutput } from '../src/services/review/types.js';

const tempDir = path.join('/tmp', `gnosis-stage-d-${Date.now()}`);

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function createFinding(
  overrides: Partial<Finding> &
    Pick<
      Finding,
      | 'id'
      | 'title'
      | 'severity'
      | 'confidence'
      | 'file_path'
      | 'line_new'
      | 'category'
      | 'rationale'
      | 'evidence'
      | 'fingerprint'
      | 'needsHumanConfirmation'
      | 'source'
    >,
): Finding {
  return {
    ...overrides,
    suggested_fix: overrides.suggested_fix,
    knowledge_refs: overrides.knowledge_refs,
    metadata: overrides.metadata,
  };
}

describe('review stage D', () => {
  test('builds fix operations from metadata hints', () => {
    const finding = createFinding({
      id: 'f-1',
      title: 'Add missing param',
      severity: 'warning',
      confidence: 'medium',
      file_path: 'src/example.ts',
      line_new: 3,
      category: 'missing-parameter',
      rationale: 'The helper needs another argument.',
      evidence: 'helper()',
      fingerprint: 'abc123',
      needsHumanConfirmation: false,
      source: 'rule_engine',
      metadata: {
        functionName: 'helper',
        paramName: 'projectKey',
        paramType: 'string',
      },
    });

    expect(isFixable(finding)).toBe(true);
    expect(buildPatchOperation(finding)).toMatchObject({
      type: 'update_function',
      file: 'src/example.ts',
      name: 'helper',
    });
  });

  test('rejects fix operations with incomplete metadata', () => {
    const finding = createFinding({
      id: 'f-0',
      title: 'Missing import metadata',
      severity: 'warning',
      confidence: 'medium',
      file_path: 'src/example.ts',
      line_new: 1,
      category: 'missing-import',
      rationale: 'Needs import details.',
      evidence: 'foo()',
      fingerprint: 'meta-missing',
      needsHumanConfirmation: false,
      source: 'rule_engine',
      metadata: { specifiers: ['foo'] },
    });

    expect(buildPatchOperation(finding)).toBeNull();
  });

  test('generates a fix suggestion from Astmend output', async () => {
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'src/example.ts'),
      'export function helper() { return true; }\n',
      'utf8',
    );

    const finding = createFinding({
      id: 'f-2',
      title: 'Add missing param',
      severity: 'warning',
      confidence: 'medium',
      file_path: 'src/example.ts',
      line_new: 1,
      category: 'missing-parameter',
      rationale: 'The helper needs another argument.',
      evidence: 'helper()',
      fingerprint: 'def456',
      needsHumanConfirmation: false,
      source: 'rule_engine',
      metadata: {
        functionName: 'helper',
        paramName: 'projectKey',
        paramType: 'string',
      },
    });

    const caller = {
      async callTool(name: string) {
        if (name !== 'mcp_astmend_apply_patch_to_text') {
          return null;
        }

        return {
          success: true,
          diff: '--- a/src/example.ts\n+++ b/src/example.ts\n',
          updatedText: 'export function helper(projectKey: string) { return true; }\n',
          rejects: [],
        };
      },
    };

    const suggestion = await generateFixSuggestion(finding, tempDir, caller as never);

    expect(suggestion).not.toBeNull();
    expect(suggestion?.confidence).toBe('high');
    expect(suggestion?.diff).toContain('+++ b/src/example.ts');
  });

  test('renders fix suggestions and KPI snapshots', () => {
    const suggestion: FixSuggestion = {
      findingId: 'f-3',
      operation: { type: 'remove_import' },
      diff: '--- a/src/example.ts\n+++ b/src/example.ts\n',
      updatedText: 'export {}\n',
      confidence: 'high',
    };

    const output: ReviewOutput = {
      review_id: 'review-1',
      review_status: 'no_major_findings',
      findings: [
        createFinding({
          id: 'f-3',
          title: 'Remove unused import',
          severity: 'warning',
          confidence: 'medium',
          file_path: 'src/example.ts',
          line_new: 1,
          category: 'unused-import',
          rationale: 'The import is never used.',
          evidence: 'import foo from "foo";',
          fingerprint: 'ghi789',
          needsHumanConfirmation: false,
          source: 'static_analysis',
        }),
      ],
      summary: 'stage d',
      next_actions: ['remove the import'],
      rerun_review: false,
      metadata: {
        reviewed_files: 1,
        risk_level: 'low',
        static_analysis_used: true,
        knowledge_applied: [],
        degraded_mode: false,
        degraded_reasons: [],
        local_llm_used: false,
        heavy_llm_used: true,
        review_duration_ms: 12,
      },
      markdown: '',
      fix_suggestions: [suggestion],
      review_kpis: {
        totalReviews: 10,
        totalFindings: 4,
        avgFindingsPerReview: 0.4,
        precisionRate: 0.75,
        falsePositiveRate: 0.25,
        knowledgeContributionRate: 0.5,
        zeroFpDays: 3,
        avgReviewDurationMs: 100,
        precisionByCategory: { maintainability: 1 },
      },
    };

    const markdown = renderReviewMarkdown(output);

    expect(markdown).toContain('Fix Suggestions');
    expect(markdown).toContain('KPI Snapshot');
    expect(markdown).toContain('Precision: 75.0%');
  });
});
