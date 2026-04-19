import { spawn } from 'node:child_process';
import path from 'node:path';
import { extractJsonCandidate } from '../../../adapters/llm.js';
import { type KeywordEvalAlias, config } from '../../../config.js';
import { buildMemoryLoopSpawnEnv } from '../../memoryLoopLlmRouter.js';

export type SpawnResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
};

export type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: { env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<SpawnResult>;

export type PromptRouteResult = {
  aliasUsed: KeywordEvalAlias;
  output: string;
};

const defaultSpawn: SpawnFn = (command, args, options) => {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env,
    });

    let stdout = '';
    let stderr = '';
    let error: Error | undefined;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      error = err;
    });

    const timeoutTrigger = options.timeout
      ? setTimeout(() => {
          child.kill('SIGTERM');
          error = new Error(`Process timed out after ${options.timeout}ms`);
        }, options.timeout)
      : null;

    child.on('close', (code) => {
      if (timeoutTrigger) clearTimeout(timeoutTrigger);
      resolve({ stdout, stderr, status: code, error });
    });
  });
};

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
    spawn?: SpawnFn;
  },
): Promise<string> => {
  const spawnFn = options.spawn ?? defaultSpawn;
  const script = resolveAliasScript(alias);
  const args = ['--output', 'text'];
  if (options.maxTokens && Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
    args.push('--max-tokens', String(options.maxTokens));
  }
  args.push('--prompt', prompt);

  const result = await spawnFn(script, args, {
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
    // 予備の抽出試行: 最外周の { } を探す
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        // 失敗した場合は下のエラーへ
      }
    }
    throw new Error('LLM response does not contain valid JSON object');
  }
  return JSON.parse(jsonCandidate) as T;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const runPromptWithAlias = async (
  prompt: string,
  input: {
    alias: KeywordEvalAlias;
    fallbackAlias?: KeywordEvalAlias;
    timeoutMs?: number;
    maxTokens?: number;
    maxRetries?: number;
  },
  deps: { spawn?: SpawnFn } = {},
): Promise<PromptRouteResult> => {
  const maxRetries = input.maxRetries ?? config.knowflow.keywordCron.maxRetries;
  let lastError: unknown;

  // メインのエイリアスでの試行（リトライ含む）
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const backoff = Math.min(1000 * 2 ** attempt, 10000);
        await delay(backoff);
      }
      const output = await runAliasPrompt(input.alias, prompt, {
        timeoutMs: input.timeoutMs,
        maxTokens: input.maxTokens,
        spawn: deps.spawn,
      });
      return { aliasUsed: input.alias, output };
    } catch (error) {
      lastError = error;
      console.warn(`Attempt ${attempt + 1} failed for alias=${input.alias}:`, error);
    }
  }

  // フォールバックの試行
  const fallback = input.fallbackAlias;
  if (fallback && fallback !== input.alias) {
    console.info(`Switching to fallback alias=${fallback}`);
    try {
      const output = await runAliasPrompt(fallback, prompt, {
        timeoutMs: input.timeoutMs,
        maxTokens: input.maxTokens,
        spawn: deps.spawn,
      });
      return { aliasUsed: fallback, output };
    } catch (fallbackError) {
      throw new Error(
        `Keyword LLM route failed both primary and fallback. Primary error: ${lastError}. Fallback error: ${fallbackError}`,
      );
    }
  }

  throw lastError;
};
