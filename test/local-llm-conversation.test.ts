import { describe, expect, test } from 'bun:test';
import {
  parseToolCall,
  runConversationTurn,
  sanitizeAssistantResponse,
} from '../src/scripts/llmConversation.js';

describe('local LLM conversation helpers', () => {
  test('parses tool call syntax from model output', () => {
    expect(parseToolCall('<|tool_call|>call:search_web{query:"bun test"}<tool_call|>')).toEqual({
      name: 'search_web',
      arguments: { query: 'bun test' },
    });

    expect(
      parseToolCall(
        '<tool_call>{"name":"fetch_content","arguments":{"url":"https://example.com"}}</tool_call>',
      ),
    ).toEqual({
      name: 'fetch_content',
      arguments: { url: 'https://example.com' },
    });
  });

  test('sanitizes tool tags and preserves plain text', () => {
    expect(sanitizeAssistantResponse('hello <think>noise</think> world')).toBe('hello  world');
  });

  test('runs a tool loop and records the conversation history', async () => {
    const history = [{ role: 'system', content: 'system prompt' } as const];
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    const service = {
      async generateMessages(messages: Array<{ role: string; content: string }>) {
        if (messages.filter((message) => message.role === 'user').length === 1) {
          return '<|tool_call|>call:web_search{query:"gnosis"}<tool_call|>';
        }
        return '最終回答です。';
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
    expect(toolCalls).toEqual([{ name: 'web_search', args: { query: 'gnosis' } }]);
    expect(history.map((message) => message.role as string)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
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
        return '```json\n{"ok":true}\n```';
      },
      async generate() {
        return '```json\n{"ok":true}\n```';
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
});
