import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const mockAgenticSearchRun = mock();
const mockReviewTaskRun = mock();

import {
  agentFirstTools,
  resetAgenticSearchRunnerForTest,
  resetReviewTaskRunnerForTest,
  runReviewTaskForMcp,
  setAgenticSearchRunnerForTest,
  setReviewTaskRunnerForTest,
} from '../../../src/mcp/tools/agentFirst.js';

const getHandler = (name: string) => {
  const tool = agentFirstTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool.handler;
};

describe('agent-first MCP tools', () => {
  beforeEach(() => {
    mockAgenticSearchRun.mockReset();
    mockReviewTaskRun.mockReset();
    setAgenticSearchRunnerForTest({ run: mockAgenticSearchRun as never });
    setReviewTaskRunnerForTest(mockReviewTaskRun as never);
  });

  afterEach(() => {
    resetAgenticSearchRunnerForTest();
    resetReviewTaskRunnerForTest();
  });

  it('agentic_search delegates to AgenticSearchRunner', async () => {
    mockAgenticSearchRun.mockResolvedValue({ answer: 'Runner answer' });
    const handler = getHandler('agentic_search');
    const result = await handler({ userRequest: 'Find guidance' });
    expect(result.content[0]?.text).toBe('Runner answer');
    expect(mockAgenticSearchRun).toHaveBeenCalledWith({ userRequest: 'Find guidance' });
  });

  it('review_task delegates to review runner and does not return the old minimal stub', async () => {
    mockReviewTaskRun.mockResolvedValue({
      status: 'ok',
      reviewStatus: 'no_major_findings',
      findings: [],
      summary: 'reviewed',
      knowledgeUsed: [],
    });
    const handler = getHandler('review_task');
    const result = await handler({
      targetType: 'implementation_plan',
      target: { content: '# Plan\nShip safely.' },
      knowledgePolicy: 'off',
    });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(payload.status).toBe('ok');
    expect(payload.status).not.toBe('unavailable_in_minimal_mode');
    expect(mockReviewTaskRun).toHaveBeenCalledWith({
      targetType: 'implementation_plan',
      target: { content: '# Plan\nShip safely.' },
      knowledgePolicy: 'off',
    });
  });

  it('marks required document knowledge as degraded when no context was applied', async () => {
    const result = await runReviewTaskForMcp(
      {
        targetType: 'implementation_plan',
        target: { content: '# Plan\nShip safely.' },
        knowledgePolicy: 'required',
      },
      {
        createLlmService: async () => ({
          provider: 'local',
          generate: async () => '{}',
        }),
        reviewDocumentFn: async () => ({
          reviewId: 'doc-review-1',
          documentType: 'plan',
          status: 'no_major_findings',
          findings: [],
          summary: 'reviewed',
          nextActions: [],
          appliedContext: {
            procedureIds: [],
            lessonIds: [],
            guidanceIds: [],
            memoryIds: [],
          },
          markdown: '',
        }),
        now: () => 100,
      },
    );

    expect(result.status).toBe('degraded');
    expect(result.reviewStatus).toBe('needs_confirmation');
    expect(result.knowledgeUsed).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      knowledgePolicy: 'required',
      degraded: true,
      degradedReasons: ['knowledge_required_unavailable'],
    });
  });
});
