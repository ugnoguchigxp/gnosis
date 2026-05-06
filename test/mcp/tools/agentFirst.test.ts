import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const mockAgenticSearchRun = mock();
const mockReviewTaskRun = mock();

import { GNOSIS_CONSTANTS } from '../../../src/constants.js';
import {
  agentFirstTools,
  resetAgenticSearchRunnerForTest,
  resetReviewTaskRunnerForTest,
  resolveMcpReviewTimeoutMs,
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
    process.env.GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS = undefined;
    resetAgenticSearchRunnerForTest();
    resetReviewTaskRunnerForTest();
  });

  it('uses a five-minute MCP review LLM timeout by default', () => {
    process.env.GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS = undefined;
    expect(resolveMcpReviewTimeoutMs()).toBe(GNOSIS_CONSTANTS.MCP_REVIEW_LLM_TIMEOUT_MS_DEFAULT);
  });

  it('allows overriding the MCP review LLM timeout', () => {
    process.env.GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS = '120000';
    expect(resolveMcpReviewTimeoutMs()).toBe(120_000);
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

  it('passes the MCP review timeout into document review', async () => {
    process.env.GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS = '240000';
    let observedTimeoutMs: number | undefined;

    const result = await runReviewTaskForMcp(
      {
        targetType: 'implementation_plan',
        target: { content: '# Plan\nShip safely.' },
        knowledgePolicy: 'off',
      },
      {
        createLlmService: async () => ({
          provider: 'local',
          generate: async () => '{}',
        }),
        reviewDocumentFn: async (_input, deps) => {
          observedTimeoutMs = (deps as { timeoutMs?: number }).timeoutMs;
          return {
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
          };
        },
        now: () => 100,
      },
    );

    expect(result.status).toBe('ok');
    expect(observedTimeoutMs).toBe(240_000);
  });
});
