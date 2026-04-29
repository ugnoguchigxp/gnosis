import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REVIEW_LIMITS, ReviewError } from '../src/services/review/errors.js';
import { validateAllowedRoot } from '../src/services/review/foundation/allowedRoots.js';
import { enforceHardLimit } from '../src/services/review/foundation/hardLimit.js';
import { maskOrThrow, maskSecrets } from '../src/services/review/foundation/secretMask.js';
import { validateSessionId } from '../src/services/review/foundation/sessionId.js';
import {
  FindingSchema,
  ReviewOutputSchema,
  ReviewRequestSchema,
} from '../src/services/review/types.js';

const envBackup = {
  GNOSIS_ALLOWED_ROOTS: process.env.GNOSIS_ALLOWED_ROOTS,
};

afterEach(() => {
  process.env.GNOSIS_ALLOWED_ROOTS = envBackup.GNOSIS_ALLOWED_ROOTS;
});

describe('review foundation', () => {
  test('validates allowed root within the configured boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-review-root-'));
    const nested = path.join(root, 'repo');
    fs.mkdirSync(nested);
    process.env.GNOSIS_ALLOWED_ROOTS = root;

    expect(() => validateAllowedRoot(nested)).not.toThrow();
  });

  test('rejects project root outside the configured boundary', () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-review-allowed-'));
    const disallowed = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-review-disallowed-'));
    process.env.GNOSIS_ALLOWED_ROOTS = allowed;

    expect(() => validateAllowedRoot(disallowed)).toThrow(ReviewError);
  });

  test('validates session id format', () => {
    expect(() => validateSessionId('code-review-gnosis:main')).not.toThrow();
    expect(() => validateSessionId('')).toThrow(ReviewError);
    expect(() => validateSessionId('bad id')).toThrow(ReviewError);
  });

  test('enforces hard limits for file and line counts', () => {
    const tooManyFiles = Array.from({ length: REVIEW_LIMITS.MAX_FILES + 1 }, (_, index) =>
      [
        `diff --git a/file-${index}.ts b/file-${index}.ts`,
        'index 0000000..1111111 100644',
        '--- a/file.ts',
        '+++ b/file.ts',
        '@@ -0,0 +1 @@',
        '+added line',
      ].join('\n'),
    ).join('\n');

    expect(() => enforceHardLimit(tooManyFiles)).toThrow(ReviewError);
  });

  test('allows review diffs up to the configured total line limit', () => {
    const diffHeader = [
      'diff --git a/file.ts b/file.ts',
      'index 0000000..1111111 100644',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,1 +1,1 @@',
      '-old line',
      '+new line',
    ];
    const paddingLines = Array.from(
      { length: REVIEW_LIMITS.MAX_DIFF_LINES - diffHeader.length },
      () => ' context line',
    );
    const maxAllowedDiff = [...diffHeader, ...paddingLines].join('\n');
    const tooLargeDiff = `${maxAllowedDiff}\n context line`;

    expect(maxAllowedDiff.split(/\r?\n/)).toHaveLength(REVIEW_LIMITS.MAX_DIFF_LINES);
    expect(() => enforceHardLimit(maxAllowedDiff)).not.toThrow();
    expect(() => enforceHardLimit(tooLargeDiff)).toThrow(ReviewError);
  });

  test('masks common secret patterns', () => {
    const input = 'apiKey="supersecret123456"\nBearer abcdefghijklmnopqrstuv';
    const result = maskSecrets(input);

    expect(result.hadSecrets).toBe(true);
    expect(result.maskCount).toBeGreaterThan(0);
    expect(result.masked).toContain('[MASKED:API_KEY]');
  });

  test('returns input unchanged when no secrets are present', () => {
    const input = 'const value = "safe";';
    expect(maskOrThrow(input, true)).toBe(input);
  });

  test('validates review request and output schemas', () => {
    const request = ReviewRequestSchema.parse({
      taskId: 'task-1',
      repoPath: '/tmp/repo',
      baseRef: 'main',
      headRef: 'HEAD',
      trigger: 'manual',
      sessionId: 'code-review-gnosis:main',
      mode: 'git_diff',
      enableStaticAnalysis: false,
      enableKnowledgeRetrieval: false,
    });

    const finding = FindingSchema.parse({
      id: 'finding-1',
      title: 'Missing validation',
      severity: 'warning',
      confidence: 'medium',
      file_path: 'src/app.ts',
      line_new: 12,
      category: 'validation',
      rationale: 'Input is not checked before use.',
      evidence: '+ value = input',
      fingerprint: 'abcdef1234567890',
      needsHumanConfirmation: false,
      source: 'rule_engine',
    });

    const output = ReviewOutputSchema.parse({
      review_id: 'review-1',
      task_id: request.taskId,
      review_status: 'needs_confirmation',
      findings: [finding],
      summary: 'one finding',
      next_actions: ['confirm the validation path'],
      rerun_review: false,
      metadata: {
        reviewed_files: 1,
        risk_level: 'medium',
        static_analysis_used: false,
        knowledge_applied: [],
        degraded_mode: false,
        degraded_reasons: [],
        local_llm_used: false,
        heavy_llm_used: true,
        review_duration_ms: 10,
      },
      markdown: '# Code Review Results',
    });

    expect(request.taskId).toBe('task-1');
    expect(output.findings[0]?.file_path).toBe('src/app.ts');
  });
});
