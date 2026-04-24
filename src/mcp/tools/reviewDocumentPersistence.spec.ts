import { describe, expect, it } from 'bun:test';
import {
  toReviewFindingFromDocument,
  toReviewOutputFromDocument,
} from './reviewDocumentPersistence.js';

describe('reviewDocumentPersistence', () => {
  it('maps document categories into review categories', () => {
    const finding = toReviewFindingFromDocument(
      'r1',
      {
        title: 'Missing requirement',
        severity: 'warning',
        confidence: 'high',
        category: 'missing_requirement',
        rationale: 'not enough',
      },
      'docs/spec.md',
      'spec_document',
    );

    expect(finding.category).toBe('validation');
    expect(finding.file_path).toBe('docs/spec.md');
    expect(finding.line_new).toBe(1);
  });

  it('builds review output metadata from finding severities', () => {
    const output = toReviewOutputFromDocument(
      'r2',
      'summary',
      'changes_requested',
      [
        {
          id: 'f1',
          title: 'Error',
          severity: 'error',
          confidence: 'high',
          file_path: 'inline',
          line_new: 1,
          category: 'bug',
          rationale: 'r',
          evidence: 'e',
          fingerprint: 'fp',
          needsHumanConfirmation: false,
          source: 'local_llm',
        },
      ],
      ['fix'],
    );

    expect(output.rerun_review).toBe(true);
    expect(output.metadata.risk_level).toBe('high');
    expect(output.next_actions).toEqual(['fix']);
  });
});
