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

import { reviewSpecDocumentTools } from '../../../src/mcp/tools/reviewSpecDocument.js';

describe('review_spec_document MCP tool', () => {
  const handler = reviewSpecDocumentTools.find(
    (tool) => tool.name === 'review_spec_document',
  )?.handler;
  if (!handler) throw new Error('review_spec_document tool not found');

  beforeEach(() => {
    mockGenerateImplementationPlan.mockReset();
    mockReviewDocument.mockReset();
    mockPersistReviewCase.mockReset();
    mockDispatchHookEvent.mockReset();
    mockPersistReviewCase.mockResolvedValue(undefined);
    mockDispatchHookEvent.mockResolvedValue(undefined);
  });

  it('returns merged spec findings and persists review case', async () => {
    mockGenerateImplementationPlan.mockResolvedValue({
      goal: { id: 'g1', name: 'Auth', description: '' },
      constraints: [],
      tasks: [],
      lessons: [],
      reviewChecklist: ['check 1'],
      markdown: '# ref plan',
    });
    mockReviewDocument.mockResolvedValue({
      reviewId: 'r2',
      documentType: 'spec',
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
      content: 'overview only',
    });

    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      status: string;
      findings: Array<{ title: string }>;
    };
    expect(payload.status).toBe('needs_confirmation');
    expect(
      payload.findings.some((finding) => finding.title === 'Missing Requirements Section'),
    ).toBe(true);
    expect(mockPersistReviewCase).toHaveBeenCalledTimes(1);
    expect(mockDispatchHookEvent).toHaveBeenCalledTimes(1);
  });

  it('keeps no_major_findings when spec includes requirements and acceptance criteria', async () => {
    mockGenerateImplementationPlan.mockResolvedValue(null);
    mockReviewDocument.mockResolvedValue({
      reviewId: 'r3',
      documentType: 'spec',
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
      content: '## Requirements\n- auth\n## Acceptance Criteria\n- tests pass',
    });

    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      status: string;
      findings: Array<{ title: string }>;
      referencePlan: unknown;
    };
    expect(payload.status).toBe('no_major_findings');
    expect(payload.findings.length).toBe(0);
    expect(payload.referencePlan).toBeNull();
  });
});
