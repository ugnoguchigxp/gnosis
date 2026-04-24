import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockGenerateImplementationPlan = mock();
const mockReviewDocument = mock();
const mockPersistReviewCase = mock(async () => undefined);
const mockDispatchHookEvent = mock(async () => undefined);

mock.module('../../../src/services/specAgent/implementationPlanner.js', () => ({
  generateImplementationPlan: mockGenerateImplementationPlan,
}));
mock.module('../../../src/services/reviewAgent/documentReviewer.js', () => ({
  reviewDocument: mockReviewDocument,
}));
mock.module('../../../src/services/review/knowledge/index.js', () => ({
  persistReviewCase: mockPersistReviewCase,
}));
mock.module('../../../src/hooks/service.js', () => ({
  dispatchHookEvent: mockDispatchHookEvent,
}));

import { reviewImplementationPlanTools } from '../../../src/mcp/tools/reviewImplementationPlan.js';

describe('review_implementation_plan MCP tool', () => {
  const handler = reviewImplementationPlanTools.find(
    (tool) => tool.name === 'review_implementation_plan',
  )?.handler;
  if (!handler) throw new Error('review_implementation_plan tool not found');

  beforeEach(() => {
    mockGenerateImplementationPlan.mockReset();
    mockReviewDocument.mockReset();
    mockPersistReviewCase.mockReset();
    mockDispatchHookEvent.mockReset();
    mockPersistReviewCase.mockResolvedValue(undefined);
    mockDispatchHookEvent.mockResolvedValue(undefined);
  });

  it('merges alignment findings with document review findings', async () => {
    mockGenerateImplementationPlan.mockResolvedValue({
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
          cautionNotes: [],
        },
      ],
      lessons: [],
      reviewChecklist: ['check 1'],
      markdown: '# ref plan',
    });
    mockReviewDocument.mockResolvedValue({
      reviewId: 'r1',
      documentType: 'plan',
      status: 'no_major_findings',
      findings: [],
      summary: 'ok',
      nextActions: [],
      appliedContext: {
        procedureIds: [],
        lessonIds: [],
        guidanceIds: [],
        memoryIds: [],
      },
    });

    const result = await handler({
      repoPath: '/tmp/repo',
      goal: 'Auth migration',
      content: '# plan\n- [ ] setup middleware',
    });

    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      status: string;
      findings: Array<{ title: string }>;
    };
    expect(payload.status).toBe('needs_confirmation');
    expect(payload.findings.some((finding) => finding.title.includes('Missing Golden Path'))).toBe(
      true,
    );
    expect(mockPersistReviewCase).toHaveBeenCalledTimes(1);
    expect(mockDispatchHookEvent).toHaveBeenCalledTimes(1);
  });

  it('works when reference plan is unavailable', async () => {
    mockGenerateImplementationPlan.mockResolvedValue(null);
    mockReviewDocument.mockResolvedValue({
      reviewId: 'r2',
      documentType: 'plan',
      status: 'needs_confirmation',
      findings: [
        {
          title: 'Manual check required',
          severity: 'warning',
          confidence: 'medium',
          category: 'risk',
          rationale: 'needs review',
        },
      ],
      summary: 'reviewed',
      nextActions: ['check'],
      appliedContext: {
        procedureIds: [],
        lessonIds: [],
        guidanceIds: [],
        memoryIds: [],
      },
    });

    const result = await handler({
      repoPath: '/tmp/repo',
      goal: 'Auth migration',
      content: '# plan\n- [ ] something',
    });

    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      status: string;
      referencePlan: unknown;
      findings: Array<{ title: string }>;
    };
    expect(payload.status).toBe('needs_confirmation');
    expect(payload.referencePlan).toBeNull();
    expect(payload.findings.some((finding) => finding.title === 'Manual check required')).toBe(
      true,
    );
  });
});
