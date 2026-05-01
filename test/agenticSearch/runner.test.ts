import { describe, expect, it, mock } from 'bun:test';
import { AgenticSearchRunner } from '../../src/services/agenticSearch/runner.js';

describe('AgenticSearchRunner', () => {
  it('returns direct final answer when no tool calls', async () => {
    const adapter = {
      generate: mock(async () => ({ text: 'final answer', toolCalls: [] })),
    };
    const runner = new AgenticSearchRunner(adapter as never, {
      knowledge_search: async () => ({}),
      brave_search: async () => ({}),
      fetch: async () => ({}),
    });
    const result = await runner.run({ userRequest: 'q' });
    expect(result.answer).toBe('final answer');
    expect(result.toolTrace.toolCalls.length).toBe(0);
  });

  it('executes tool call then returns next answer', async () => {
    const adapter = {
      generate: mock()
        .mockResolvedValueOnce({
          text: '',
          toolCalls: [{ id: 'c1', name: 'knowledge_search', arguments: { query: 'x', type: 'rule' } }],
        })
        .mockResolvedValueOnce({ text: 'done', toolCalls: [] }),
    };
    const runner = new AgenticSearchRunner(adapter as never, {
      knowledge_search: async () => ({ items: [{ id: '1' }] }),
      brave_search: async () => ({}),
      fetch: async () => ({}),
    });
    const result = await runner.run({ userRequest: 'q' });
    expect(result.answer).toBe('done');
    expect(result.toolTrace.toolCalls.length).toBe(1);
    expect(result.toolTrace.toolCalls[0]?.toolName).toBe('knowledge_search');
  });

  it('executes brave_search then fetch then returns final answer', async () => {
    const adapter = {
      generate: mock()
        .mockResolvedValueOnce({
          text: '',
          toolCalls: [{ id: 'c1', name: 'brave_search', arguments: { query: 'latest bun test docs', count: 3 } }],
        })
        .mockResolvedValueOnce({
          text: '',
          toolCalls: [{ id: 'c2', name: 'fetch', arguments: { url: 'https://example.com/doc' } }],
        })
        .mockResolvedValueOnce({ text: 'Use bun test --watch for local TDD.', toolCalls: [] }),
    };
    const runner = new AgenticSearchRunner(adapter as never, {
      knowledge_search: async () => ({}),
      brave_search: async () => ({ results: [{ url: 'https://example.com/doc' }] }),
      fetch: async () => ({ text: 'bun test --watch ...' }),
    });
    const result = await runner.run({ userRequest: 'bun test の最新Tips' });
    expect(result.answer).toContain('bun test --watch');
    expect(result.toolTrace.toolCalls.length).toBe(2);
    expect(result.toolTrace.toolCalls[0]?.toolName).toBe('brave_search');
    expect(result.toolTrace.toolCalls[1]?.toolName).toBe('fetch');
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
    const runner = new AgenticSearchRunner(adapter as never, {
      knowledge_search: async () => ({ items: [] }),
      brave_search: async () => ({}),
      fetch: async () => ({}),
    });
    await runner.run({ userRequest: 'q' });
    const secondTurnRoles = seenMessageRoles[1] ?? [];
    const tail = secondTurnRoles.slice(-3);
    expect(tail).toEqual(['tool', 'tool', 'system']);
  });
});
