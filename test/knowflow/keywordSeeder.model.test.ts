import { describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';

mock.module('../../src/config.js', () => ({
  config: {
    gemma4Script: '/mock/scripts/gemma4',
    bonsaiScript: '/mock/scripts/bonsai',
    bedrockScript: '/mock/scripts/bedrock',
    openaiScript: '/mock/scripts/openai',
  },
  KeywordEvalAliasSchema: z.enum(['bonsai', 'gemma4', 'bedrock', 'openai']),
}));

import {
  type SpawnSyncFn,
  parseJsonFromLlmText,
  runPromptWithAlias,
} from '../../src/services/knowflow/cron/llmRouter.js';

describe('keyword model router', () => {
  it('routes prompt to gemma4 script', async () => {
    const commands: string[] = [];
    const spawn: SpawnSyncFn = (command) => {
      commands.push(command);
      return {
        status: 0,
        stdout: '{"items":[{"topic":"gemma4-topic"}]}',
        stderr: '',
      };
    };

    const result = await runPromptWithAlias(
      'prompt-text',
      { alias: 'gemma4' },
      { spawnSync: spawn },
    );

    expect(result.aliasUsed).toBe('gemma4');
    expect(commands[0]).toBe('/mock/scripts/gemma4');

    const parsed = parseJsonFromLlmText<{ items: Array<{ topic: string }> }>(result.output);
    expect(parsed.items[0]?.topic).toBe('gemma4-topic');
  });

  it('routes prompt to openai script', async () => {
    const commands: string[] = [];
    const spawn: SpawnSyncFn = (command) => {
      commands.push(command);
      return {
        status: 0,
        stdout: '{"items":[{"topic":"openai-topic"}]}',
        stderr: '',
      };
    };

    const result = await runPromptWithAlias(
      'prompt-text',
      { alias: 'openai' },
      { spawnSync: spawn },
    );

    expect(result.aliasUsed).toBe('openai');
    expect(commands[0]).toBe('/mock/scripts/openai');

    const parsed = parseJsonFromLlmText<{ items: Array<{ topic: string }> }>(result.output);
    expect(parsed.items[0]?.topic).toBe('openai-topic');
  });

  it('falls back to openai when primary alias fails', async () => {
    const commands: string[] = [];
    let count = 0;
    const spawn: SpawnSyncFn = (command) => {
      commands.push(command);
      count += 1;
      if (count === 1) {
        return {
          status: 1,
          stdout: '',
          stderr: 'primary failed',
        };
      }
      return {
        status: 0,
        stdout: '{"items":[]}',
        stderr: '',
      };
    };

    const result = await runPromptWithAlias(
      'prompt-text',
      { alias: 'gemma4', fallbackAlias: 'openai' },
      { spawnSync: spawn },
    );

    expect(result.aliasUsed).toBe('openai');
    expect(commands).toHaveLength(2);
    expect(commands[0]).toBe('/mock/scripts/gemma4');
    expect(commands[1]).toBe('/mock/scripts/openai');
  });
});
