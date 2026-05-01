import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockSearchKnowledgeV2 = mock();
const mockResolveStaleMetadataSignal = mock();
const mockBuildDoctorRuntimeHealth = mock();
const mockRecordTaskNote = mock();
const mockGetReviewLlmService = mock();

mock.module('../../../src/services/review/llm/reviewer.js', () => ({
  getReviewLLMService: mockGetReviewLlmService,
}));

mock.module('../../../src/services/agentFirst.js', () => ({
  searchKnowledgeV2: mockSearchKnowledgeV2,
  resolveStaleMetadataSignal: mockResolveStaleMetadataSignal,
  buildDoctorRuntimeHealth: mockBuildDoctorRuntimeHealth,
  recordTaskNote: mockRecordTaskNote,
}));

import { agentFirstTools } from '../../../src/mcp/tools/agentFirst.js';

const getHandler = (name: string) => {
  const tool = agentFirstTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool.handler;
};

describe('agent-first MCP tools', () => {
  beforeEach(() => {
    mockGetReviewLlmService.mockReset();
    mockSearchKnowledgeV2.mockReset();
    mockResolveStaleMetadataSignal.mockReset();
    mockBuildDoctorRuntimeHealth.mockReset();
    mockRecordTaskNote.mockReset();
  });

  it('agentic_search delegates to AgenticSearchRunner', async () => {
    mockGetReviewLlmService.mockResolvedValue({
      provider: 'cloud',
      generate: mock(async () => ''),
      generateMessagesStructured: mock(async () => ({
        text: 'Runner answer',
        toolCalls: [],
      })),
    });
    const handler = getHandler('agentic_search');
    const result = await handler({ userRequest: 'Find guidance' });
    expect(result.content[0]?.text).toBe('Runner answer');
    expect(mockGetReviewLlmService).toHaveBeenCalledTimes(1);
  });
});
