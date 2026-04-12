import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const envBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

const envNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const CliPromptModeSchema = z.enum(['stdin', 'arg']);
export type CliPromptMode = z.infer<typeof CliPromptModeSchema>;

export const LlmClientConfigSchema = z
  .object({
    apiBaseUrl: z.string().url(),
    apiPath: z.string().min(1),
    apiKeyEnv: z.string().min(1),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2),
    timeoutMs: z.number().int().positive(),
    maxRetries: z.number().int().positive(),
    retryDelayMs: z.number().int().nonnegative(),
    enableCliFallback: z.boolean(),
    cliCommand: z.string().min(1),
    cliPromptMode: CliPromptModeSchema,
    cliPromptPlaceholder: z.string().min(1),
  })
  .strict();

export type LlmClientConfig = z.infer<typeof LlmClientConfigSchema>;

export const BudgetConfigSchema = z
  .object({
    userBudget: z.number().int().positive(),
    cronBudget: z.number().int().positive(),
    cronRunBudget: z.number().int().positive(),
  })
  .strict();

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

export const WorkerConfigSchema = z
  .object({
    taskTimeoutMs: z.number().int().positive(),
    pollIntervalMs: z.number().int().positive(),
    maxConsecutiveErrors: z.number().int().positive(),
    maxQueriesPerTask: z.number().int().positive(),
    cronRunWindowMs: z.number().int().positive(),
  })
  .strict();

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

/**
 * プロジェクト全体の設定管理
 */
export const config = {
  // LLM スクリプトのパス (gemma4, bonsai 等に使用)
  llmScript: process.env.GNOSIS_LLM_SCRIPT || 'gemma4',

  // localLlm プロジェクトのルートパス (MCP Retriever用)
  localLlmPath: process.env.GNOSIS_LOCAL_LLM_PATH || '',

  // エンティティ抽出/マージ時のタイムアウト (ms)
  llmTimeoutMs: envNumber(process.env.GNOSIS_LLM_TIMEOUT_MS, 90_000),

  // 埋め込みベクトルの生成コマンド
  embedCommand: process.env.GNOSIS_EMBED_COMMAND || 'embed',
  embedTimeoutMs: Math.max(1, envNumber(process.env.GNOSIS_EMBED_TIMEOUT_MS, 30_000)),

  // Bun バイナリのパス
  bunCommand: process.env.GNOSIS_BUN_COMMAND || 'bun',

  // ベクトルの次元数
  embeddingDimension: envNumber(process.env.GNOSIS_EMBEDDING_DIMENSION, 384),

  // 自動デデュープ（重複排除）の類似度閾値
  dedupeThreshold: envNumber(process.env.GNOSIS_DEDUPE_THRESHOLD, 0.9),

  // 各種ログのディレクトリパス
  claudeLogDir: process.env.GNOSIS_CLAUDE_LOG_DIR || '',
  antigravityLogDir: process.env.GNOSIS_ANTIGRAVITY_LOG_DIR || '',

  // 自己省察のバッチサイズ
  synthesisBatchSize: 10,

  // 連想検索の最大ホップ数
  maxPathHops: 5,

  // データベース接続情報 (Drizzle用)
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:7888/gnosis',

  knowflow: {
    llm: LlmClientConfigSchema.parse({
      apiBaseUrl: process.env.LOCAL_LLM_API_BASE_URL ?? 'http://127.0.0.1:44448',
      apiPath: process.env.LOCAL_LLM_API_PATH ?? '/v1/chat/completions',
      apiKeyEnv: process.env.LOCAL_LLM_API_KEY_ENV ?? 'LOCAL_LLM_API_KEY',
      model: process.env.LOCAL_LLM_MODEL ?? 'gemma-4-e4b-it',
      temperature: envNumber(process.env.LOCAL_LLM_TEMPERATURE, 0),
      timeoutMs: envNumber(process.env.LOCAL_LLM_TIMEOUT_MS, 60_000),
      maxRetries: Math.max(1, envNumber(process.env.LOCAL_LLM_MAX_RETRIES, 2)),
      retryDelayMs: Math.max(0, envNumber(process.env.LOCAL_LLM_RETRY_DELAY_MS, 300)),
      enableCliFallback: envBoolean(process.env.LOCAL_LLM_ENABLE_CLI_FALLBACK, true),
      cliCommand:
        process.env.LOCAL_LLM_CLI_COMMAND ??
        `${process.env.GNOSIS_LLM_SCRIPT || 'gemma4'} --prompt {{prompt}}`,
      cliPromptMode: process.env.LOCAL_LLM_CLI_PROMPT_MODE === 'stdin' ? 'stdin' : 'arg',
      cliPromptPlaceholder: process.env.LOCAL_LLM_CLI_PROMPT_PLACEHOLDER ?? '{{prompt}}',
    }),
    budget: BudgetConfigSchema.parse({
      userBudget: envNumber(process.env.USER_BUDGET, 12),
      cronBudget: envNumber(process.env.CRON_BUDGET, 6),
      cronRunBudget: envNumber(process.env.CRON_RUN_BUDGET, 30),
    }),
    worker: WorkerConfigSchema.parse({
      taskTimeoutMs: envNumber(process.env.KNOWFLOW_WORKER_TASK_TIMEOUT_MS, 600_000),
      pollIntervalMs: envNumber(process.env.KNOWFLOW_WORKER_POLL_INTERVAL_MS, 1_000),
      maxConsecutiveErrors: envNumber(process.env.KNOWFLOW_WORKER_MAX_CONSECUTIVE_ERRORS, 5),
      maxQueriesPerTask: envNumber(process.env.KNOWFLOW_WORKER_MAX_QUERIES_PER_TASK, 10),
      cronRunWindowMs: envNumber(process.env.KNOWFLOW_WORKER_CRON_RUN_WINDOW_MS, 3_600_000),
    }),
    healthCheck: {
      timeoutMs: envNumber(process.env.KNOWFLOW_HEALTH_CHECK_TIMEOUT_MS, 5_000),
    },
  },

  graph: {
    similarityThreshold: envNumber(process.env.GNOSIS_GRAPH_SIMILARITY_THRESHOLD, 0.8),
    maxPathHops: envNumber(process.env.GNOSIS_GRAPH_MAX_PATH_HOPS, 5),
  },

  memory: {
    retries: envNumber(process.env.GNOSIS_MEMORY_RETRIES, 3),
    retryWaitMultiplier: envNumber(process.env.GNOSIS_MEMORY_RETRY_WAIT_MULTIPLIER, 1000),
  },

  llm: {
    maxBuffer: envNumber(process.env.GNOSIS_LLM_MAX_BUFFER_BYTES, 10 * 1024 * 1024),
    defaultTimeoutMs: envNumber(process.env.GNOSIS_LLM_DEFAULT_TIMEOUT_MS, 45_000),
  },

  llmharness: {
    defaultApiBaseUrl: process.env.LOCAL_LLM_API_BASE_URL || 'http://localhost:8000',
    defaultApiPath: process.env.LOCAL_LLM_API_PATH || '/v1/chat/completions',
    defaultApiKeyEnv: process.env.LOCAL_LLM_API_KEY_ENV || 'LOCAL_LLM_API_KEY',
    defaultModel: process.env.LOCAL_LLM_MODEL || 'gemma4-default',
  },

  guidance: {
    sessionId: process.env.GUIDANCE_SESSION_ID || 'guidance-registry',
    inboxDir:
      process.env.GUIDANCE_INBOX_DIR || path.resolve(process.cwd(), 'imports/guidance/inbox'),
    processedDir:
      process.env.GUIDANCE_PROCESSED_DIR ||
      path.resolve(process.cwd(), 'imports/guidance/processed'),
    failedDir:
      process.env.GUIDANCE_FAILED_DIR || path.resolve(process.cwd(), 'imports/guidance/failed'),
    maxFilesPerZip: Math.max(1, envNumber(process.env.GUIDANCE_MAX_FILES_PER_ZIP, 500)),
    maxZipSizeBytes: Math.max(1, envNumber(process.env.GUIDANCE_MAX_ZIP_SIZE_BYTES, 50_000_000)),
    maxChunkChars: Math.max(200, envNumber(process.env.GUIDANCE_MAX_CHUNK_CHARS, 2000)),
    maxFileChars: Math.max(200, envNumber(process.env.GUIDANCE_MAX_FILE_CHARS, 120_000)),
    alwaysLimit: Math.max(1, envNumber(process.env.GUIDANCE_ALWAYS_LIMIT, 4)),
    onDemandLimit: Math.max(1, envNumber(process.env.GUIDANCE_ON_DEMAND_LIMIT, 5)),
    maxPromptChars: Math.max(200, envNumber(process.env.GUIDANCE_MAX_PROMPT_CHARS, 3000)),
    minSimilarity: envNumber(process.env.GUIDANCE_MIN_SIMILARITY, 0.72),
    enabled: envBoolean(process.env.GUIDANCE_ENABLED, true),
    project: process.env.GUIDANCE_PROJECT,
    priorityHigh: 100,
    priorityMid: 80,
    priorityLow: 50,
    maxZips: envNumber(process.env.GUIDANCE_MAX_ZIPS, 1000),
  },
};
