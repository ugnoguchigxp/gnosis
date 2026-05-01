import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockGetReviewLlmService = mock();

mock.module('../../src/services/review/llm/reviewer.js', () => ({
  getReviewLLMService: mockGetReviewLlmService,
}));

import { AgenticSearchLlmAdapter } from '../../src/services/agenticSearch/llmAdapter.js';

describe('AgenticSearchLlmAdapter', () => {
  beforeEach(() => {
    mockGetReviewLlmService.mockReset();
  });

  it('throws tool_calling_unsupported for non-cloud provider', async () => {
    mockGetReviewLlmService.mockResolvedValue({
      provider: 'local',
      generate: mock(async () => ''),
    });
    const adapter = new AgenticSearchLlmAdapter();
    await expect(
      adapter.generate([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
      ]),
    ).rejects.toThrow('tool_calling_unsupported');
  });

  it('reuses resolved llm service between calls', async () => {
    const generateMessagesStructured = mock(async () => ({ text: 'ok', toolCalls: [] }));
    mockGetReviewLlmService.mockResolvedValue({
      provider: 'cloud',
      generate: mock(async () => ''),
      generateMessagesStructured,
    });
    const adapter = new AgenticSearchLlmAdapter();
    await adapter.generate([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q1' },
    ]);
    await adapter.generate([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q2' },
    ]);
    expect(mockGetReviewLlmService).toHaveBeenCalledTimes(1);
    expect(generateMessagesStructured).toHaveBeenCalledTimes(2);
  });

  it('passes tool-role message to structured API', async () => {
    const generateMessagesStructured = mock(async () => ({ text: 'ok', toolCalls: [] }));
    mockGetReviewLlmService.mockResolvedValue({
      provider: 'cloud',
      generate: mock(async () => ''),
      generateMessagesStructured,
    });
    const adapter = new AgenticSearchLlmAdapter();
    await adapter.generate([
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: '', toolCalls: [], raw: { tool_calls: [{ id: 'c1' }] } },
      { role: 'tool', toolCallId: 'c1', toolName: 'fetch', content: '{"ok":true}' },
      { role: 'user', content: 'next' },
    ]);
    const firstCall = generateMessagesStructured.mock.calls[0] as unknown as [Array<Record<string, unknown>>];
    const messages = firstCall[0];
    const toolMsg = messages.find((m) => m.role === 'tool');
    expect(toolMsg?.toolCallId).toBe('c1');
    expect(toolMsg?.content).toBe('{"ok":true}');
  });
});
