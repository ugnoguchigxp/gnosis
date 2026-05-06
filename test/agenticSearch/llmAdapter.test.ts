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

  it('throws tool_calling_unsupported when provider lacks structured tool calls', async () => {
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

  it('allows local providers that expose structured tool calls', async () => {
    const generateMessagesStructured = mock(async () => ({ text: 'ok', toolCalls: [] }));
    mockGetReviewLlmService.mockResolvedValue({
      provider: 'local',
      generate: mock(async () => ''),
      generateMessagesStructured,
    });
    const adapter = new AgenticSearchLlmAdapter();
    const result = await adapter.generate([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
    ]);
    expect(result.text).toBe('ok');
    expect(generateMessagesStructured).toHaveBeenCalledTimes(1);
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
    const firstCall = generateMessagesStructured.mock.calls[0] as unknown as [
      Array<Record<string, unknown>>,
    ];
    const messages = firstCall[0];
    const toolMsg = messages.find((m) => m.role === 'tool');
    expect(toolMsg?.toolCallId).toBe('c1');
    expect(toolMsg?.content).toBe('{"ok":true}');
  });

  it('rejects orphan tool-role messages before provider call', async () => {
    const generateMessagesStructured = mock(async () => ({ text: 'ok', toolCalls: [] }));
    mockGetReviewLlmService.mockResolvedValue({
      provider: 'cloud',
      generate: mock(async () => ''),
      generateMessagesStructured,
    });
    const adapter = new AgenticSearchLlmAdapter();

    await expect(
      adapter.generate([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
        {
          role: 'tool',
          toolCallId: 'prefetch-knowledge',
          toolName: 'knowledge_search',
          content: '{}',
        },
      ]),
    ).rejects.toThrow('invalid_agentic_tool_message_sequence');

    expect(mockGetReviewLlmService).not.toHaveBeenCalled();
    expect(generateMessagesStructured).not.toHaveBeenCalled();
  });

  it('synthesizes assistant raw tool_calls when only structured calls are present', async () => {
    const generateMessagesStructured = mock(async () => ({ text: 'ok', toolCalls: [] }));
    mockGetReviewLlmService.mockResolvedValue({
      provider: 'cloud',
      generate: mock(async () => ''),
      generateMessagesStructured,
    });
    const adapter = new AgenticSearchLlmAdapter();

    await adapter.generate([
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'knowledge_search', arguments: { query: 'x' } }],
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'knowledge_search', content: '{"ok":true}' },
    ]);

    const firstCall = generateMessagesStructured.mock.calls[0] as unknown as [
      Array<Record<string, unknown>>,
    ];
    const assistantMsg = firstCall[0].find((m) => m.role === 'assistant');
    const raw = assistantMsg?.rawAssistantContent as { tool_calls?: unknown[] } | undefined;
    expect(raw?.tool_calls?.length).toBe(1);
  });
});
