import { describe, expect, it } from 'bun:test';
import { analyzePlanAlignment } from './planAlignment.js';

describe('analyzePlanAlignment', () => {
  it('detects missing golden tasks and mitigation notes', () => {
    const result = analyzePlanAlignment('## Plan\n- [ ] setup ci\n', {
      goal: { id: 'g1', name: 'Auth', description: '' },
      constraints: [],
      tasks: [
        {
          id: 't1',
          name: 'Select JWT library',
          description: '',
          confidence: 0.9,
          isGoldenPath: true,
          order: 0,
          validationCriteria: [],
          cautionNotes: ['failure observed before'],
        },
      ],
      lessons: [],
      reviewChecklist: ['check 1'],
      markdown: '# ref',
    });

    expect(result.status).toBe('needs_confirmation');
    expect(result.findings.some((finding) => finding.title.includes('Missing Golden Path'))).toBe(
      true,
    );
    expect(
      result.findings.some((finding) => finding.title.includes('Missing Mitigation Notes')),
    ).toBe(true);
  });
});
