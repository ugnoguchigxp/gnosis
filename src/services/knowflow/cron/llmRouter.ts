import {
  type SpawnSyncOptionsWithStringEncoding,
  spawnSync as nodeSpawnSync,
} from 'node:child_process';
import path from 'node:path';
import { extractJsonCandidate } from '../../../adapters/llm.js';
import { type KeywordEvalAlias, config } from '../../../config.js';
import { buildMemoryLoopSpawnEnv } from '../../memoryLoopLlmRouter.js';

export type SpawnSyncResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
};

export type SpawnSyncFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: { encoding: 'utf-8'; env?: NodeJS.ProcessEnv; timeout?: number },
) => SpawnSyncResult;

export type PromptRouteResult = {
  aliasUsed: KeywordEvalAlias;
  output: string;
};

const defaultSpawnSync: SpawnSyncFn = (command, args, options) =>
  nodeSpawnSync(command, args, options as SpawnSyncOptionsWithStringEncoding);

const resolveAliasScript = (alias: KeywordEvalAlias): string => {
  switch (alias) {
    case 'gemma4':
      return config.gemma4Script;
    case 'bonsai':
      return config.bonsaiScript;
    case 'openai':
      return config.openaiScript;
    case 'bedrock':
      return config.bedrockScript;
    default:
      return path.resolve(process.cwd(), `scripts/${alias}`);
  }
};

const runAliasPrompt = async (
  alias: KeywordEvalAlias,
  prompt: string,
  options: {
    timeoutMs?: number;
    maxTokens?: number;
    spawnSync?: SpawnSyncFn;
  },
): Promise<string> => {
  const spawnSync = options.spawnSync ?? defaultSpawnSync;
  const script = resolveAliasScript(alias);
  const args = ['--output', 'text'];
  if (options.maxTokens && Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
    args.push('--max-tokens', String(options.maxTokens));
  }
  args.push('--prompt', prompt);

  const result = spawnSync(script, args, {
    encoding: 'utf-8',
    env: buildMemoryLoopSpawnEnv(alias),
    timeout: options.timeoutMs,
  });

  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `status=${result.status}`;
    throw new Error(`Keyword LLM route failed alias=${alias}: ${detail}`);
  }

  const output = result.stdout?.trim() ?? '';
  if (!output) {
    throw new Error(`Keyword LLM route failed alias=${alias}: empty output`);
  }
  return output;
};

export const parseJsonFromLlmText = <T>(text: string): T => {
  const jsonCandidate = extractJsonCandidate(text);
  if (!jsonCandidate) {
    throw new Error('LLM response does not contain JSON object');
  }
  return JSON.parse(jsonCandidate) as T;
};

export const runPromptWithAlias = async (
  prompt: string,
  input: {
    alias: KeywordEvalAlias;
    fallbackAlias?: KeywordEvalAlias;
    timeoutMs?: number;
    maxTokens?: number;
  },
  deps: { spawnSync?: SpawnSyncFn } = {},
): Promise<PromptRouteResult> => {
  try {
    const output = await runAliasPrompt(input.alias, prompt, {
      timeoutMs: input.timeoutMs,
      maxTokens: input.maxTokens,
      spawnSync: deps.spawnSync,
    });
    return { aliasUsed: input.alias, output };
  } catch (error) {
    const fallback = input.fallbackAlias;
    if (!fallback || fallback === input.alias) {
      throw error;
    }

    const output = await runAliasPrompt(fallback, prompt, {
      timeoutMs: input.timeoutMs,
      maxTokens: input.maxTokens,
      spawnSync: deps.spawnSync,
    });
    return { aliasUsed: fallback, output };
  }
};
