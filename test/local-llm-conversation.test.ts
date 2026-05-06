import { describe, expect, test } from 'bun:test';
import { acceptAssistantResponse, runConversationTurn } from '../src/scripts/llmConversation.js';

describe('local LLM conversation helpers', () => {
  test('does not rewrite model text with tag sanitizers', () => {
    expect(acceptAssistantResponse('hello <think>noise</think> world')).toBe(
      'hello <think>noise</think> world',
    );
  });

  test('runs a native structured tool loop and records the conversation history', async () => {
    const history = [{ role: 'system', content: 'system prompt' } as const];
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let calls = 0;

    const service = {
      async generateMessagesStructured() {
        calls += 1;
        if (calls === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'call-1', name: 'search_web', arguments: { query: 'gnosis' } }],
            rawAssistantContent: { tool_calls: [{ id: 'call-1' }] },
          };
        }
        return { text: '最終回答です。', toolCalls: [] };
      },
      async generate() {
        return '最終回答です。';
      },
    };

    const response = await runConversationTurn(history as never, 'gnosisについて教えて', service, {
      maxTokens: 1024,
      temperature: 0,
      allowTools: true,
      toolClient: {
        async callTool(name: string, args: Record<string, unknown>) {
          toolCalls.push({ name, args });
          return 'tool result';
        },
      },
    });

    expect(response).toBe('最終回答です。');
    expect(toolCalls).toEqual([{ name: 'search_web', args: { query: 'gnosis' } }]);
    expect(history.map((message) => message.role as string)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'system',
      'assistant',
    ]);
    expect((history[2] as { rawAssistantContent?: unknown }).rawAssistantContent).toEqual({
      tool_calls: [{ id: 'call-1' }],
    });
  });

  test('falls back to generate() when generateMessages is unavailable', async () => {
    const history = [{ role: 'system', content: 'system prompt' } as const];
    let seenPrompt = '';

    const service = {
      async generate(prompt: string) {
        seenPrompt = prompt;
        return 'plain answer';
      },
    };

    const response = await runConversationTurn(history as never, 'hello world', service, {
      maxTokens: 128,
      temperature: 0,
      allowTools: false,
    });

    expect(response).toBe('plain answer');
    expect(seenPrompt).toBe('hello world');
    expect(history.map((message) => message.role as string)).toEqual([
      'system',
      'user',
      'assistant',
    ]);
  });

  test('preserves JSON when forceJson is enabled', async () => {
    const history = [{ role: 'system', content: 'system prompt' } as const];

    const service = {
      async generateMessages() {
        return '{"ok":true}';
      },
      async generate() {
        return '{"ok":true}';
      },
    };

    const response = await runConversationTurn(history as never, 'return json', service, {
      maxTokens: 128,
      temperature: 0,
      allowTools: false,
      forceJson: true,
    });

    expect(response).toBe('{"ok":true}');
  });

  test('rejects fenced JSON instead of extracting it', async () => {
    const history = [{ role: 'system', content: 'system prompt' } as const];

    const service = {
      async generateMessages() {
        return '```json\n{"ok":true}\n```';
      },
      async generate() {
        return '```json\n{"ok":true}\n```';
      },
    };

    await expect(
      runConversationTurn(history as never, 'return json', service, {
        maxTokens: 128,
        temperature: 0,
        allowTools: false,
        forceJson: true,
      }),
    ).rejects.toThrow();
  });
});
