import { describe, expect, it, mock } from 'bun:test';
import {
  parseAgenticSearchCliArgs,
  runAgenticSearchCli,
} from '../src/scripts/agentic-search.js';

describe('agentic-search CLI', () => {
  it('parses repeated flags and json mode', () => {
    const parsed = parseAgenticSearchCliArgs([
      '--request',
      'test request',
      '--repo',
      '/tmp/repo',
      '--file',
      'a.ts',
      '--file',
      'b.ts',
      '--change-type',
      'mcp',
      '--technology',
      'bun',
      '--intent',
      'plan',
      '--json',
    ]);
    expect(parsed.userRequest).toBe('test request');
    expect(parsed.repoPath).toBe('/tmp/repo');
    expect(parsed.files).toEqual(['a.ts', 'b.ts']);
    expect(parsed.changeTypes).toEqual(['mcp']);
    expect(parsed.technologies).toEqual(['bun']);
    expect(parsed.intent).toBe('plan');
    expect(parsed.asJson).toBe(true);
  });

  it('throws when request is missing', () => {
    expect(() => parseAgenticSearchCliArgs([])).toThrow('--request is required');
  });

  it('prints answer and trace in text mode', async () => {
    const writes: string[] = [];
    const runner = {
      run: mock(async () => ({
        answer: 'answer',
        toolTrace: {
          toolCalls: [{ toolCallId: '1', toolName: 'fetch' as const, arguments: {}, ok: true }],
          loopCount: 2,
        },
      })),
    };
    await runAgenticSearchCli(['--request', 'q'], {
      runner,
      write: (line) => writes.push(line),
    });
    expect(writes[0]).toBe('answer');
    expect(writes[1]).toContain('loops=2');
    expect(writes[1]).toContain('tool_calls=1');
  });

  it('prints JSON only in json mode', async () => {
    const writes: string[] = [];
    const runner = {
      run: mock(async () => ({
        answer: 'json-answer',
        toolTrace: { toolCalls: [], loopCount: 1 },
      })),
    };
    await runAgenticSearchCli(['--request', 'q', '--json'], {
      runner,
      write: (line) => writes.push(line),
    });
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('"answer": "json-answer"');
  });
});
