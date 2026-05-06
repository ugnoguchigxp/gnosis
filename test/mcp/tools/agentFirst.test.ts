import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const mockAgenticSearchRun = mock();
const mockMemorySearchRun = mock();
const mockMemoryFetchRun = mock();
const mockReviewTaskRun = mock();

import { GNOSIS_CONSTANTS } from '../../../src/constants.js';
import {
  agentFirstTools,
  resetAgenticSearchRunnerForTest,
  resetMemoryFetchRunnerForTest,
  resetMemorySearchRunnerForTest,
  resetReviewTaskRunnerForTest,
  resolveMcpReviewTimeoutMs,
  runReviewTaskForMcp,
  setAgenticSearchRunnerForTest,
  setMemoryFetchRunnerForTest,
  setMemorySearchRunnerForTest,
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
    mockMemorySearchRun.mockReset();
    mockMemoryFetchRun.mockReset();
    mockReviewTaskRun.mockReset();
    setAgenticSearchRunnerForTest({ run: mockAgenticSearchRun as never });
    setMemorySearchRunnerForTest(mockMemorySearchRun as never);
    setMemoryFetchRunnerForTest(mockMemoryFetchRun as never);
    setReviewTaskRunnerForTest(mockReviewTaskRun as never);
  });

  afterEach(() => {
    process.env.GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS = undefined;
    resetAgenticSearchRunnerForTest();
    resetMemorySearchRunnerForTest();
    resetMemoryFetchRunnerForTest();
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

  it('memory_search delegates to vibe memory search and returns JSON without raw metadata', async () => {
    mockMemorySearchRun.mockResolvedValue({
      items: [
        {
          id: 'memory-1',
          sessionId: 'session-1',
          createdAt: '2026-05-06T00:00:00.000Z',
          source: 'like',
          matchSources: ['like'],
          score: 1,
          snippet: 'compressed context',
        },
      ],
      retrieval: {
        query: 'context',
        mode: 'like',
        vectorHitCount: 0,
        likeHitCount: 1,
        returnedCount: 1,
        embeddingStatus: 'not_attempted',
      },
    });
    const handler = getHandler('memory_search');
    const result = await handler({ query: ' context ', mode: 'like' });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      items?: Array<Record<string, unknown>>;
    };

    expect(mockMemorySearchRun).toHaveBeenCalledWith({ query: 'context', mode: 'like' });
    expect(payload.items?.[0]?.id).toBe('memory-1');
    expect(payload.items?.[0]).not.toHaveProperty('metadata');
  });

  it('memory_fetch delegates to vibe memory partial fetch', async () => {
    mockMemoryFetchRun.mockResolvedValue({
      id: 'memory-1',
      sessionId: 'session-1',
      createdAt: '2026-05-06T00:00:00.000Z',
      range: { start: 10, end: 20, totalChars: 100, source: 'explicit_range' },
      excerpts: [{ text: '0123456789', matched: false, start: 10, end: 20 }],
      text: '0123456789',
      truncated: true,
    });
    const handler = getHandler('memory_fetch');
    const result = await handler({ id: ' memory-1 ', start: 10, end: 20 });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(mockMemoryFetchRun).toHaveBeenCalledWith({ id: 'memory-1', start: 10, end: 20 });
    expect(payload.text).toBe('0123456789');
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
