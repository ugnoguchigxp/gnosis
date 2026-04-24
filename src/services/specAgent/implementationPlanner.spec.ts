import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockQueryProcedure = mock();
const mockRecallExperienceLessons = mock();

mock.module('../procedure.js', () => ({
  queryProcedure: mockQueryProcedure,
}));
mock.module('../experience.js', () => ({
  recallExperienceLessons: mockRecallExperienceLessons,
}));

import { generateImplementationPlan } from './implementationPlanner.js';

describe('generateImplementationPlan', () => {
  beforeEach(() => {
    mockQueryProcedure.mockReset();
    mockRecallExperienceLessons.mockReset();
  });

  it('builds markdown plan and maps caution constraints', async () => {
    mockQueryProcedure.mockResolvedValue({
      goal: { id: 'g1', name: 'Auth migration', description: 'goal desc' },
      tasks: [
        {
          id: 't1',
          name: 'Select JWT lib',
          description: 'choose library',
          confidence: 0.9,
          order: 0,
          episodes: [],
          isGoldenPath: true,
          validationCriteria: ['library decision documented'],
        },
      ],
      constraints: [
        {
          id: 'caution:t1',
          name: 'Caution for Select JWT lib',
          description: 'Caution: task has failure history.',
          severity: 'warning',
        },
      ],
    });
    mockRecallExperienceLessons.mockResolvedValue([]);

    const result = await generateImplementationPlan({
      goal: 'Migrate auth',
      project: 'gnosis',
    });

    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.tasks[0]?.cautionNotes).toContain('Caution: task has failure history.');
    expect(result.reviewChecklist.length).toBeGreaterThan(0);
    expect(result.markdown).toContain('## Tasks');
    expect(result.markdown).toContain('Golden Path');
  });
});
