import { describe, expect, it } from 'bun:test';
import { resolveReviewExitCode } from '../src/services/review/cli.js';
import type { ReviewOutput } from '../src/services/review/types.js';

function makeOutput(reviewStatus: ReviewOutput['review_status'], degraded = false): ReviewOutput {
  return {
    review_id: 'review-1',
    review_status: reviewStatus,
    findings: [],
    summary: '',
    next_actions: [],
    rerun_review: false,
    metadata: {
      reviewed_files: 0,
      risk_level: 'low',
      static_analysis_used: false,
      knowledge_applied: [],
      degraded_mode: degraded,
      degraded_reasons: degraded ? ['llm_timeout'] : [],
      local_llm_used: false,
      heavy_llm_used: true,
      review_duration_ms: 1,
    },
    markdown: '',
  };
}

describe('review CLI exit policy', () => {
  it('is non-blocking by default (permissive)', () => {
    expect(resolveReviewExitCode(makeOutput('changes_requested'), 'permissive')).toBe(0);
    expect(resolveReviewExitCode(makeOutput('needs_confirmation', true), 'permissive')).toBe(0);
  });

  it('blocks only on changes_requested in balanced mode', () => {
    expect(resolveReviewExitCode(makeOutput('changes_requested'), 'balanced')).toBe(3);
    expect(resolveReviewExitCode(makeOutput('needs_confirmation', true), 'balanced')).toBe(0);
  });

  it('blocks on uncertain outcomes in strict mode', () => {
    expect(resolveReviewExitCode(makeOutput('changes_requested'), 'strict')).toBe(3);
    expect(resolveReviewExitCode(makeOutput('needs_confirmation'), 'strict')).toBe(2);
    expect(resolveReviewExitCode(makeOutput('no_major_findings', true), 'strict')).toBe(2);
  });
});
