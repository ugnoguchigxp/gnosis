#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GNOSIS_CONSTANTS } from '../constants.js';
import { withGlobalSemaphore } from '../utils/lock.js';

export type LocalLlmAlias = 'gemma4' | 'qwen' | 'bonsai' | 'openai' | 'bedrock';
export type LauncherPlan = {
  command: string;
  args: string[];
};

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUN = process.env.GNOSIS_BUN_COMMAND ?? 'bun';

const DEFAULT_GEMMA4_MODEL = process.env.GEMMA4_MODEL ?? 'mlx-community/gemma-4-e4b-it-4bit';
const DEFAULT_QWEN_MODEL = process.env.QWEN_MODEL ?? 'mlx-community/Qwen3-14B-4bit';
const DEFAULT_BONSAI_MODEL = process.env.BONSAI_MODEL ?? 'prism-ml/Ternary-Bonsai-8B-mlx-2bit';
const resolveRuntimeCommand = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (path.isAbsolute(trimmed)) return trimmed;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('.')) {
    return path.resolve(ROOT_DIR, trimmed);
  }
  return trimmed;
};
const GEMMA4_COMMAND = resolveRuntimeCommand(
  process.env.GNOSIS_GEMMA4_SCRIPT ?? GNOSIS_CONSTANTS.LLM_SCRIPT_DEFAULT,
);
const QWEN_COMMAND = resolveRuntimeCommand(
  process.env.GNOSIS_QWEN_SCRIPT ?? GNOSIS_CONSTANTS.QWEN_SCRIPT_DEFAULT,
);
const BONSAI_COMMAND = resolveRuntimeCommand(
  process.env.GNOSIS_BONSAI_SCRIPT ?? GNOSIS_CONSTANTS.BONSAI_SCRIPT_DEFAULT,
);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveLocalLlmConcurrencyLimit(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(
    GNOSIS_CONSTANTS.LLM_CONCURRENCY_LIMIT_MAX,
    parsePositiveInt(
      env.GNOSIS_LLM_CONCURRENCY_LIMIT,
      GNOSIS_CONSTANTS.LLM_CONCURRENCY_LIMIT_DEFAULT,
    ),
  );
}

const getArgValue = (argv: string[], key: string): string | undefined => {
  const index = argv.indexOf(key);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
};

export function parseAlias(argv: string[]): LocalLlmAlias {
  const alias = getArgValue(argv, '--alias') ?? argv[0];
  if (
    alias === 'gemma4' ||
    alias === 'qwen' ||
    alias === 'bonsai' ||
    alias === 'openai' ||
    alias === 'bedrock'
  ) {
    return alias;
  }
  return 'gemma4';
}

export function resolveLauncherPlan(alias: LocalLlmAlias, argv: string[]): LauncherPlan {
  const forwardedArgs = argv.filter((value, index) => {
    if (value === '--alias') return false;
    const aliasIndex = argv.indexOf('--alias');
    if (aliasIndex >= 0 && (index === aliasIndex || index === aliasIndex + 1)) return false;
    return true;
  });
  const hasModelArg = forwardedArgs.includes('--model');
  const withDefaultModel = (defaultModel: string): string[] =>
    hasModelArg ? forwardedArgs : ['--model', defaultModel, ...forwardedArgs];

  switch (alias) {
    case 'gemma4':
      return {
        command: GEMMA4_COMMAND,
        args: withDefaultModel(DEFAULT_GEMMA4_MODEL),
      };
    case 'qwen':
      return {
        command: QWEN_COMMAND,
        args: withDefaultModel(DEFAULT_QWEN_MODEL),
      };
    case 'bonsai':
      return {
        command: BONSAI_COMMAND,
        args: withDefaultModel(DEFAULT_BONSAI_MODEL),
      };
    case 'openai':
      return {
        command: BUN,
        args: [
          'run',
          path.join(ROOT_DIR, 'src/scripts/ask-llm.ts'),
          '--provider',
          getArgValue(forwardedArgs, '--provider') ?? 'openai',
          ...forwardedArgs,
        ],
      };
    case 'bedrock':
      return {
        command: BUN,
        args: [
          'run',
          path.join(ROOT_DIR, 'src/scripts/ask-llm.ts'),
          '--provider',
          getArgValue(forwardedArgs, '--provider') ?? 'bedrock',
          ...forwardedArgs,
        ],
      };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const alias = parseAlias(argv);
  const plan = resolveLauncherPlan(alias, argv);

  const limit = resolveLocalLlmConcurrencyLimit();
  const semaphoreName = 'llm-pool';

  await withGlobalSemaphore(semaphoreName, limit, async () => {
    const child = spawn(plan.command, plan.args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: process.env.HOME ?? os.homedir(),
      },
    });

    child.stdout?.on('data', (data) => {
      process.stdout.write(data);
    });

    child.stderr?.on('data', (data) => {
      process.stderr.write(data);
    });

    return new Promise<void>((resolve, reject) => {
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else process.exit(code ?? 1);
      });
      child.on('error', (error) => {
        console.error(error);
        process.exit(1);
      });
    });
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
