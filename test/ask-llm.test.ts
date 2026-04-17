import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../src/scripts/ask-llm.js';

describe('cloud CLI argument parsing', () => {
  test('defaults to bedrock and enables MCP by default', () => {
    const args = parseArgs([]);
    expect(args.provider).toBe('bedrock');
    expect(args.enableMcp).toBe(true);
    expect(args.output).toBe('text');
    expect(args.mode).toBe('single');
  });

  test('parses openai interactive mode and session flags', () => {
    const args = parseArgs([
      '--provider',
      'openai',
      '--interactive',
      '--session-id',
      'sess_123456',
      '--session-dir',
      '/tmp/sessions',
      '--no-session',
      '--no-mcp',
      '--prompt',
      'hello',
    ]);

    expect(args.provider).toBe('openai');
    expect(args.mode).toBe('single');
    expect(args.sessionId).toBe('sess_123456');
    expect(args.sessionDir).toBe('/tmp/sessions');
    expect(args.noSession).toBe(true);
    expect(args.enableMcp).toBe(false);
    expect(args.prompt).toBe('hello');
  });

  test('allows explicit mcp override and positional prompt input', () => {
    const args = parseArgs(['--mcp', '--output', 'json', 'what', 'is', 'gnosis']);

    expect(args.enableMcp).toBe(true);
    expect(args.output).toBe('json');
    expect(args.prompt).toBe('what is gnosis');
  });

  test('does not treat option values as positional prompts', () => {
    const args = parseArgs(['--model', 'custom-model', '--session-id', 'sess_123456', 'hello']);

    expect(args.model).toBe('custom-model');
    expect(args.sessionId).toBe('sess_123456');
    expect(args.prompt).toBe('hello');
  });

  test('parses bedrock-specific options', () => {
    const args = parseArgs([
      '--provider',
      'bedrock',
      '--region',
      'ap-northeast-1',
      '--model-id',
      'anthropic.claude-3-5-sonnet-20240620-v1:0',
      '--inference-profile-id',
      'jp.anthropic.claude-3-5-sonnet-20240620-v1:0',
    ]);

    expect(args.provider).toBe('bedrock');
    expect(args.region).toBe('ap-northeast-1');
    expect(args.modelId).toBe('anthropic.claude-3-5-sonnet-20240620-v1:0');
    expect(args.inferenceProfileId).toBe('jp.anthropic.claude-3-5-sonnet-20240620-v1:0');
  });
});
