import path from 'node:path';
import { config } from '../config.js';
import { withGlobalLock } from '../utils/lock.js';

export type MemoryLoopAlias = 'gemma4' | 'bonsai' | 'openai' | 'bedrock';
export type MemoryLoopTaskKind = 'distillation' | 'evaluation' | 'repair-json' | 'classification';
export type MemoryLoopRiskLevel = 'low' | 'medium' | 'high';

export type MemoryLoopRouteInput = {
  taskKind: MemoryLoopTaskKind;
  retryCount: number;
  riskLevel?: MemoryLoopRiskLevel;
  qualityScore?: number;
  preferredLocalAlias?: Extract<MemoryLoopAlias, 'gemma4' | 'bonsai'>;
  fallbackLocalAlias?: Extract<MemoryLoopAlias, 'gemma4' | 'bonsai'> | null;
  allowCloudFallback?: boolean;
};

export type MemoryLoopRoute = {
  alias: MemoryLoopAlias;
  script: string;
  allowCloud: boolean;
  cloudEnabledForAttempt: boolean;
  reason: string;
};

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
) => SpawnSyncResult | Promise<SpawnSyncResult>;

export type RunPromptOptions = {
  prompt: string;
  taskKind: MemoryLoopTaskKind;
  riskLevel?: MemoryLoopRiskLevel;
  qualityScore?: number;
  preferredLocalAlias?: Extract<MemoryLoopAlias, 'gemma4' | 'bonsai'>;
  fallbackLocalAlias?: Extract<MemoryLoopAlias, 'gemma4' | 'bonsai'> | null;
  allowCloudFallback?: boolean;
  llmScript?: string;
  llmTimeoutMs?: number;
  maxTokens?: number;
};

export type RunPromptDeps = {
  spawnSync?: SpawnSyncFn;
  withLock?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  withSemaphore?: <T>(name: string, concurrency: number, fn: () => Promise<T>) => Promise<T>;
};

import { runLlmProcess } from './llm/spawnControl.js';

const defaultSpawnSync: SpawnSyncFn = (command, args, options) => {
  return runLlmProcess(command, args as string[], {
    env: options.env,
    timeout: options.timeout,
  }) as unknown as SpawnSyncResult;
};

type MemoryLoopRuntimeConfig = {
  allowCloud: boolean;
  cloudProvider: 'openai' | 'bedrock';
  defaultAlias: 'gemma4' | 'bonsai';
  lightAlias: 'gemma4' | 'bonsai';
  maxLocalRetries: number;
  minQualityScore: number;
  scripts: Record<MemoryLoopAlias, string>;
};

export type MemoryLoopRuntimeConfigForTest = MemoryLoopRuntimeConfig;

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isLocalAlias(alias: MemoryLoopAlias): boolean {
  return alias === 'gemma4' || alias === 'bonsai';
}

function shouldForceSafeSeatbeltMlx(
  alias: MemoryLoopAlias,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isLocalAlias(alias)) return false;
  if (env.CODEX_SANDBOX !== 'seatbelt') return false;
  return !isTruthy(env.GNOSIS_MEMORY_LOOP_ALLOW_UNSAFE_MLX_IN_SEATBELT);
}

export function buildMemoryLoopSpawnEnv(
  alias: MemoryLoopAlias,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...sourceEnv };
  if (shouldForceSafeSeatbeltMlx(alias, sourceEnv)) {
    env.LOCAL_LLM_ALLOW_MLX_IN_SEATBELT = '0';
  }
  return env;
}

function toSafeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function buildRuntimeConfig(): MemoryLoopRuntimeConfig {
  const cfg = config as unknown as {
    memoryLoop?: {
      allowCloud?: boolean;
      cloudProvider?: string;
      defaultAlias?: string;
      lightAlias?: string;
      maxLocalRetries?: number;
      minQualityScore?: number;
    };
    gemma4Script?: string;
    bonsaiScript?: string;
    openaiScript?: string;
    bedrockScript?: string;
    llmScript?: string;
  };

  const allowCloud = Boolean(cfg.memoryLoop?.allowCloud);
  const cloudProvider = cfg.memoryLoop?.cloudProvider === 'bedrock' ? 'bedrock' : 'openai';
  const defaultAlias = cfg.memoryLoop?.defaultAlias === 'bonsai' ? 'bonsai' : 'gemma4';
  const lightAlias = cfg.memoryLoop?.lightAlias === 'gemma4' ? 'gemma4' : 'bonsai';
  const maxLocalRetries = Math.max(1, Number(cfg.memoryLoop?.maxLocalRetries ?? 3));
  const minQualityScore = Number.isFinite(cfg.memoryLoop?.minQualityScore)
    ? Number(cfg.memoryLoop?.minQualityScore)
    : 0.5;

  const scripts: Record<MemoryLoopAlias, string> = {
    gemma4:
      toSafeString(cfg.gemma4Script) ||
      toSafeString(cfg.llmScript) ||
      path.resolve(process.cwd(), 'scripts/gemma4'),
    bonsai: toSafeString(cfg.bonsaiScript) || path.resolve(process.cwd(), 'scripts/bonsai'),
    openai: toSafeString(cfg.openaiScript) || path.resolve(process.cwd(), 'scripts/openai'),
    bedrock: toSafeString(cfg.bedrockScript) || path.resolve(process.cwd(), 'scripts/bedrock'),
  };

  return {
    allowCloud,
    cloudProvider,
    defaultAlias,
    lightAlias,
    maxLocalRetries,
    minQualityScore,
    scripts,
  };
}

export function routeMemoryLoopLlm(
  input: MemoryLoopRouteInput,
  runtimeOverride?: MemoryLoopRuntimeConfigForTest,
): MemoryLoopRoute {
  const runtime = runtimeOverride ?? buildRuntimeConfig();
  const allowCloud = runtime.allowCloud && input.allowCloudFallback !== false;
  const localPrimary =
    input.preferredLocalAlias ??
    (input.taskKind === 'classification' || input.taskKind === 'repair-json'
      ? runtime.lightAlias
      : runtime.defaultAlias);
  const localSecondary =
    input.fallbackLocalAlias === null
      ? localPrimary
      : input.fallbackLocalAlias ?? (localPrimary === 'gemma4' ? 'bonsai' : 'gemma4');

  const qualityGateTriggered =
    typeof input.qualityScore === 'number' && input.qualityScore < runtime.minQualityScore;
  const cloudEnabledForAttempt =
    allowCloud &&
    (input.retryCount >= runtime.maxLocalRetries ||
      qualityGateTriggered ||
      input.riskLevel === 'high');

  if (cloudEnabledForAttempt) {
    return {
      alias: runtime.cloudProvider,
      script: runtime.scripts[runtime.cloudProvider],
      allowCloud,
      cloudEnabledForAttempt: true,
      reason: qualityGateTriggered
        ? 'quality-score-below-threshold'
        : input.riskLevel === 'high'
          ? 'high-risk-task'
          : 'local-retries-exceeded',
    };
  }

  const alias = input.retryCount === 0 ? localPrimary : localSecondary;
  return {
    alias,
    script: runtime.scripts[alias],
    allowCloud,
    cloudEnabledForAttempt: false,
    reason: input.retryCount === 0 ? 'primary-local-route' : 'local-fallback-route',
  };
}

function buildPromptArgs(prompt: string, maxTokens?: number): string[] {
  const args = ['--output', 'text'];
  if (maxTokens && Number.isFinite(maxTokens) && maxTokens > 0) {
    args.push('--max-tokens', String(maxTokens));
  }
  args.push('--prompt', prompt);
  return args;
}

export async function runPromptWithMemoryLoopRouter(
  options: RunPromptOptions,
  deps: RunPromptDeps = {},
): Promise<{
  output: string;
  route: MemoryLoopRoute;
  attempts: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}> {
  const spawnSync = deps.spawnSync ?? defaultSpawnSync;
  const timeoutMs =
    options.llmTimeoutMs ?? (config as { llmTimeoutMs?: number }).llmTimeoutMs ?? 90_000;
  const runtime = buildRuntimeConfig();

  // 明示的に llmScript が渡された場合は、ルーターをバイパスして互換動作を優先する。
  if (options.llmScript && options.llmScript.trim().length > 0) {
    const fixedRoute: MemoryLoopRoute = {
      alias: runtime.defaultAlias,
      script: options.llmScript,
      allowCloud: runtime.allowCloud,
      cloudEnabledForAttempt: false,
      reason: 'explicit-llm-script-override',
    };
    const result = await spawnSync(
      fixedRoute.script,
      buildPromptArgs(options.prompt, options.maxTokens),
      {
        encoding: 'utf-8',
        env: buildMemoryLoopSpawnEnv(fixedRoute.alias),
        timeout: timeoutMs,
      },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `LLM route failed alias=${fixedRoute.alias} reason=${fixedRoute.reason} status=${
          result.status
        } stderr=${result.stderr?.trim() ?? ''}`,
      );
    }
    console.info(
      `[MemoryLoopRouter] selectedAlias=${fixedRoute.alias} fallbackAttempt=0 cloudEnabled=${fixedRoute.cloudEnabledForAttempt} reason=${fixedRoute.reason}`,
    );
    return { output: result.stdout?.trim() ?? '', route: fixedRoute, attempts: 1 };
  }

  const allowCloud = runtime.allowCloud && options.allowCloudFallback !== false;
  const maxAttempts = runtime.maxLocalRetries + (allowCloud ? 1 : 0);
  let lastError: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const route = routeMemoryLoopLlm({
      taskKind: options.taskKind,
      retryCount: attempt,
      riskLevel: options.riskLevel,
      qualityScore: options.qualityScore,
      preferredLocalAlias: options.preferredLocalAlias,
      fallbackLocalAlias: options.fallbackLocalAlias,
      allowCloudFallback: options.allowCloudFallback,
    });

    const result = await spawnSync(
      route.script,
      buildPromptArgs(options.prompt, options.maxTokens),
      {
        encoding: 'utf-8',
        env: buildMemoryLoopSpawnEnv(route.alias),
        timeout: timeoutMs,
      },
    );

    if (!result.error && result.status === 0) {
      console.info(
        `[MemoryLoopRouter] selectedAlias=${route.alias} fallbackAttempt=${attempt} cloudEnabled=${route.cloudEnabledForAttempt} reason=${route.reason}`,
      );
      return { output: result.stdout?.trim() ?? '', route, attempts: attempt + 1 };
    }

    const statusLabel = result.error
      ? result.error.message
      : `status=${result.status} stderr=${result.stderr?.trim() ?? ''}`;
    lastError = `attempt=${attempt + 1} alias=${route.alias} reason=${route.reason} ${statusLabel}`;
    console.warn(`[MemoryLoopRouter] ${lastError}`);
  }

  throw new Error(`LLM route failed after ${maxAttempts} attempts. ${lastError ?? ''}`);
}
