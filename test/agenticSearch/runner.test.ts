import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockSaveAgenticAnswer = mock(async () => 'mem-1');
const emptyFirewallContext = () => ({
  shouldUse: false,
  reason: 'skip',
  riskSignals: [] as string[],
  changedFiles: [] as string[],
  lessonCandidates: [] as unknown[],
  goldenPathCandidates: [] as unknown[],
  failurePatternCandidates: [] as unknown[],
  suggestedUse: 'skip',
  degradedReasons: [] as string[],
});
const mockLookupFailureFirewallContext = mock(async (): Promise<unknown> => emptyFirewallContext());
mock.module('../../src/services/agenticSearch/saveAnswer.js', () => ({
  saveAgenticAnswer: mockSaveAgenticAnswer,
}));

import { AgenticSearchRunner } from '../../src/services/agenticSearch/runner.js';

describe('AgenticSearchRunner', () => {
  beforeEach(() => {
    mockSaveAgenticAnswer.mockClear();
    mockLookupFailureFirewallContext.mockClear();
    mockLookupFailureFirewallContext.mockResolvedValue(emptyFirewallContext());
  });

  it('returns direct final answer when no tool calls', async () => {
    const adapter = {
      generate: mock(async () => ({ text: 'final answer', toolCalls: [] })),
    };
    const runner = new AgenticSearchRunner(
      adapter as never,
      {
        knowledge_search: async () => ({}),
        brave_search: async () => ({}),
        fetch: async () => ({}),
      },
      6,
      mockLookupFailureFirewallContext as never,
    );
    const result = await runner.run({ userRequest: 'q' });
    expect(result.answer).toBe('final answer');
    expect(result.toolTrace.toolCalls.length).toBe(2);
    expect(mockSaveAgenticAnswer).toHaveBeenCalledTimes(1);
  });

  it('executes tool call then returns next answer', async () => {
    const adapter = {
      generate: mock()
        .mockResolvedValueOnce({
          text: '',
          toolCalls: [
            { id: 'c1', name: 'knowledge_search', arguments: { query: 'x', type: 'rule' } },
          ],
        })
        .mockResolvedValueOnce({ text: 'done', toolCalls: [] }),
    };
    const runner = new AgenticSearchRunner(
      adapter as never,
      {
        knowledge_search: async () => ({ items: [{ id: '1' }] }),
        brave_search: async () => ({}),
        fetch: async () => ({}),
      },
      6,
      mockLookupFailureFirewallContext as never,
    );
    const result = await runner.run({ userRequest: 'q' });
    expect(result.answer).toBe('done');
    expect(result.toolTrace.toolCalls.length).toBe(3);
    expect(result.toolTrace.toolCalls[2]?.toolName).toBe('knowledge_search');
  });

  it('executes brave_search then fetch then returns final answer', async () => {
    const adapter = {
      generate: mock()
        .mockResolvedValueOnce({
          text: '',
          toolCalls: [
            {
              id: 'c1',
              name: 'brave_search',
              arguments: { query: 'latest bun test docs', count: 3 },
            },
          ],
        })
        .mockResolvedValueOnce({
          text: '',
          toolCalls: [{ id: 'c2', name: 'fetch', arguments: { url: 'https://example.com/doc' } }],
        })
        .mockResolvedValueOnce({ text: 'Use bun test --watch for local TDD.', toolCalls: [] }),
    };
    const runner = new AgenticSearchRunner(
      adapter as never,
      {
        knowledge_search: async () => ({}),
        brave_search: async () => ({ results: [{ url: 'https://example.com/doc' }] }),
        fetch: async () => ({ text: 'bun test --watch ...' }),
      },
      6,
      mockLookupFailureFirewallContext as never,
    );
    const result = await runner.run({ userRequest: 'bun test の最新Tips' });
    expect(result.answer).toContain('bun test --watch');
    expect(result.toolTrace.toolCalls.length).toBe(4);
    expect(result.toolTrace.toolCalls[2]?.toolName).toBe('brave_search');
    expect(result.toolTrace.toolCalls[3]?.toolName).toBe('fetch');
  });

  it('appends all tool messages before followup system context', async () => {
    const seenMessageRoles: string[][] = [];
    const adapter = {
      generate: mock(async (messages) => {
        seenMessageRoles.push(messages.map((m: { role: string }) => m.role));
        if (seenMessageRoles.length === 1) {
          return {
            text: '',
            toolCalls: [
              { id: 'c1', name: 'knowledge_search', arguments: { query: 'x', type: 'rule' } },
              { id: 'c2', name: 'knowledge_search', arguments: { query: 'y', type: 'procedure' } },
            ],
          };
        }
        return { text: 'done', toolCalls: [] };
      }),
    };
    const runner = new AgenticSearchRunner(
      adapter as never,
      {
        knowledge_search: async () => ({ items: [] }),
        brave_search: async () => ({}),
        fetch: async () => ({}),
      },
      6,
      mockLookupFailureFirewallContext as never,
    );
    await runner.run({ userRequest: 'q' });
    const secondTurnRoles = seenMessageRoles[1] ?? [];
    const tail = secondTurnRoles.slice(-3);
    expect(tail).toEqual(['tool', 'tool', 'system']);
  });

  it('executes knowledge and web prefetch in first round', async () => {
    const knowledgeSearch = mock(async () => ({ items: [] }));
    const braveSearch = mock(async () => ({ results: [] }));
    const fetchTool = mock(async () => ({}));
    const adapter = {
      generate: mock(async () => ({ text: 'done', toolCalls: [] })),
    };
    const runner = new AgenticSearchRunner(
      adapter as never,
      {
        knowledge_search: knowledgeSearch,
        brave_search: braveSearch,
        fetch: fetchTool,
      },
      6,
      mockLookupFailureFirewallContext as never,
    );
    await runner.run({ userRequest: 'q' });
    expect(knowledgeSearch).toHaveBeenCalledTimes(1);
    expect(braveSearch).toHaveBeenCalledTimes(1);
    expect(fetchTool).not.toHaveBeenCalled();
  });

  it('passes prefetch results as compact context instead of tool messages', async () => {
    const seenMessages: Array<Array<{ role: string; content: string }>> = [];
    const adapter = {
      generate: mock(async (messages) => {
        seenMessages.push(messages);
        return { text: 'done', toolCalls: [] };
      }),
    };
    const runner = new AgenticSearchRunner(
      adapter as never,
      {
        knowledge_search: async () => ({
          items: [
            {
              id: 'rule-1',
              type: 'rule',
              title: 'Keep MCP primary surface small',
              content: 'Do not add primary MCP tools for internal helper flows.',
              score: 0.91,
            },
          ],
        }),
        brave_search: async () => ({ results: [{ title: 'Result', url: 'https://example.com' }] }),
        fetch: async () => ({}),
      },
      6,
      mockLookupFailureFirewallContext as never,
    );

    await runner.run({ userRequest: 'q' });

    const firstTurn = seenMessages[0] ?? [];
    expect(firstTurn.some((message) => message.role === 'tool')).toBe(false);
    expect(
      firstTurn.some(
        (message) =>
          message.role === 'system' &&
          message.content.includes('Prefetched Gnosis knowledge') &&
          message.content.includes('Keep MCP primary surface small'),
      ),
    ).toBe(true);
  });

  it('withholds stale lifecycle knowledge from compact context', async () => {
    const seenMessages: Array<Array<{ role: string; content: string }>> = [];
    const adapter = {
      generate: mock(async (messages) => {
        seenMessages.push(messages);
        return { text: 'done', toolCalls: [] };
      }),
    };
    const runner = new AgenticSearchRunner(
      adapter as never,
      {
        knowledge_search: async () => ({
          items: [
            {
              id: 'old-1',
              type: 'procedure',
              title: 'Old startup flow',
              content: 'Call activate_project before searching.',
              score: 0.99,
            },
          ],
        }),
        brave_search: async () => ({ results: [] }),
        fetch: async () => ({}),
      },
      6,
      mockLookupFailureFirewallContext as never,
    );

    const result = await runner.run({ userRequest: 'Gnosis tool flow' });

    const firstTurnText = (seenMessages[0] ?? []).map((message) => message.content).join('\n');
    expect(firstTurnText).toContain('Withheld stale Gnosis knowledge');
    expect(firstTurnText).not.toContain('activate_project');
    expect(result.toolTrace.staleKnowledge?.withheldCount).toBe(1);
  });

  it('keeps graceful prefetch degraded details in compact context', async () => {
    const seenMessages: Array<Array<{ role: string; content: string }>> = [];
    const adapter = {
      generate: mock(async (messages) => {
        seenMessages.push(messages);
        return { text: 'done', toolCalls: [] };
      }),
    };
    const runner = new AgenticSearchRunner(
      adapter as never,
      {
        knowledge_search: async () => ({ items: [] }),
        brave_search: async () => ({
          results: [],
          degraded: { code: 'BRAVE_API_KEY_MISSING', message: 'BRAVE_SEARCH_API_KEY not set' },
        }),
        fetch: async () => ({}),
      },
      6,
      mockLookupFailureFirewallContext as never,
    );

    await runner.run({ userRequest: 'q' });

    const firstTurn = seenMessages[0] ?? [];
    expect(
      firstTurn.some(
        (message) =>
          message.role === 'system' &&
          message.content.includes('Prefetch degraded') &&
          message.content.includes('BRAVE_API_KEY_MISSING'),
      ),
    ).toBe(true);
  });

  it('adds Failure Firewall context to the first LLM turn when relevant lessons exist', async () => {
    mockLookupFailureFirewallContext.mockResolvedValueOnce({
      shouldUse: true,
      reason: 'Matched raw lesson evidence for risk signals: auth',
      riskSignals: ['auth'],
      changedFiles: ['src/auth/middleware.ts'],
      lessonCandidates: [
        {
          id: 'note/auth-lesson',
          title: 'Keep auth guard boundaries explicit',
          kind: 'lesson',
          content: 'Preserve authorization checks when middleware changes.',
          tags: ['auth'],
          files: ['src/auth/middleware.ts'],
          evidence: [],
          riskSignals: ['auth'],
          score: 0.9,
          reason: 'risk_signal_overlap=1.00',
          source: 'entity',
          blocking: false,
        },
      ],
      goldenPathCandidates: [],
      failurePatternCandidates: [],
      suggestedUse: 'review_reference',
      degradedReasons: [],
    });
    const adapter = {
      generate: mock(async (messages) => {
        expect(
          messages.some(
            (message: { role: string; content: string }) =>
              message.role === 'system' && message.content.includes('note/auth-lesson'),
          ),
        ).toBe(true);
        return { text: 'done', toolCalls: [] };
      }),
    };
    const runner = new AgenticSearchRunner(
      adapter as never,
      {
        knowledge_search: async () => ({ items: [] }),
        brave_search: async () => ({ results: [] }),
        fetch: async () => ({}),
      },
      6,
      mockLookupFailureFirewallContext as never,
    );

    const result = await runner.run({
      userRequest: 'Review auth middleware change',
      files: ['src/auth/middleware.ts'],
      changeTypes: ['auth'],
      intent: 'review',
    });

    expect(result.answer).toBe('done');
    expect(result.toolTrace.toolCalls.length).toBe(2);
    expect(mockLookupFailureFirewallContext).toHaveBeenCalledTimes(1);
  });

  it('does not fail even when answer persistence fails', async () => {
    mockSaveAgenticAnswer.mockImplementationOnce(async () => {
      throw new Error('save failed');
    });
    const adapter = {
      generate: mock(async () => ({ text: 'final answer', toolCalls: [] })),
    };
    const runner = new AgenticSearchRunner(
      adapter as never,
      {
        knowledge_search: async () => ({ items: [] }),
        brave_search: async () => ({ results: [] }),
        fetch: async () => ({}),
      },
      6,
      mockLookupFailureFirewallContext as never,
    );
    const result = await runner.run({ userRequest: 'q' });
    expect(result.answer).toBe('final answer');
    expect(result.savedMemoryId).toBeUndefined();
  });

  it('rejects final answers that mention deprecated lifecycle tools', async () => {
    const adapter = {
      generate: mock(async () => ({
        text: 'Use activate_project before agentic_search.',
        toolCalls: [],
      })),
    };
    const runner = new AgenticSearchRunner(
      adapter as never,
      {
        knowledge_search: async () => ({ items: [] }),
        brave_search: async () => ({ results: [] }),
        fetch: async () => ({}),
      },
      6,
      mockLookupFailureFirewallContext as never,
    );

    const result = await runner.run({ userRequest: 'Gnosis tool flow' });

    expect(result.answer).toContain('Gnosis の主導線は agentic_search');
    expect(result.answer).not.toContain('activate_project');
    expect(result.degraded?.code).toBe('STALE_PUBLIC_SURFACE_ANSWER');
    expect(result.toolTrace.staleKnowledge?.finalAnswerRejected).toBe(true);
    expect(mockSaveAgenticAnswer).not.toHaveBeenCalled();
  });

  it('returns knowledge fallback when LLM finalization fails after prefetch', async () => {
    const adapter = {
      generate: mock(async () => {
        throw new Error('tool_calling_unsupported');
      }),
    };
    const runner = new AgenticSearchRunner(
      adapter as never,
      {
        knowledge_search: async () => ({
          items: [
            {
              id: 'note-1',
              type: 'lesson',
              title: 'Azure OpenAI is the default reviewer',
              content: 'review_task should resolve provider openai to Azure OpenAI.',
              score: 0.9,
              retrievalSource: 'vector',
            },
          ],
        }),
        brave_search: async () => ({
          results: [],
          degraded: { code: 'BRAVE_API_KEY_MISSING', message: 'BRAVE_SEARCH_API_KEY not set' },
        }),
        fetch: async () => ({}),
      },
      6,
      mockLookupFailureFirewallContext as never,
    );
    const result = await runner.run({ userRequest: 'review_task provider policy' });
    expect(result.answer).toContain('Gnosis knowledge には関連候補があります');
    expect(result.answer).toContain('Azure OpenAI is the default reviewer');
    expect(result.answer).toContain('BRAVE_API_KEY_MISSING');
    expect(result.degraded?.code).toBe('TOOL_CALLING_UNSUPPORTED');
    expect(result.degraded?.message).toContain('tool_calling_unsupported');
    expect(mockSaveAgenticAnswer).not.toHaveBeenCalled();
  });
});
