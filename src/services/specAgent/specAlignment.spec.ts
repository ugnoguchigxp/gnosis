import { describe, expect, it } from 'bun:test';
import { analyzeSpecAlignment } from './specAlignment.js';

describe('analyzeSpecAlignment', () => {
  it('detects missing requirements and acceptance criteria', () => {
    const result = analyzeSpecAlignment('## Overview\n仕様概要のみ', null);

    expect(result.status).toBe('needs_confirmation');
    expect(
      result.findings.some((finding) => finding.title === 'Missing Requirements Section'),
    ).toBe(true);
    expect(result.findings.some((finding) => finding.title === 'Missing Acceptance Criteria')).toBe(
      true,
    );
  });
});
