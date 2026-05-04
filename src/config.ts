import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { GNOSIS_CONSTANTS } from './constants';

export const envBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

export const envNumber = (value: string | undefined, fallback: number): number => {
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

export const WorkerConfigSchema = z
  .object({
    taskTimeoutMs: z.number().int().positive(),
    pollIntervalMs: z.number().int().positive(),
    postTaskDelayMs: z.number().int().nonnegative(),
    parallelism: z.number().int().positive(),
    maxConsecutiveErrors: z.number().int().positive(),
    maxQueriesPerTask: z.number().int().positive(),
    cronRunWindowMs: z.number().int().positive(),
  })
  .strict();

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const KeywordCronConfigSchema = z
  .object({
    enabled: z.boolean(),
    maxTopics: z.number().int().positive(),
    lookbackHours: z.number().int().positive(),
  })
  .strict();

export type KeywordCronConfig = z.infer<typeof KeywordCronConfigSchema>;

export const MemoryLoopConfigSchema = z
  .object({
    allowCloud: z.boolean(),
    cloudProvider: z.enum(['openai', 'bedrock']),
    defaultAlias: z.enum(['gemma4', 'bonsai']),
    lightAlias: z.enum(['gemma4', 'bonsai']),
    intervalMs: z.number().int().positive(),
    maxLocalRetries: z.number().int().min(1),
    minQualityScore: z.number().min(0).max(1),
    idleBackoffMultiplier: z.number().int().min(1),
    maxIntervalMs: z.number().int().positive(),
    enableDailyAudit: z.boolean(),
    enableWeeklyAudit: z.boolean(),
  })
  .strict();

export type MemoryLoopConfig = z.infer<typeof MemoryLoopConfigSchema>;

function memoryLoopAlias(
  value: string | undefined,
  fallback: string,
  defaultAlias: 'gemma4' | 'bonsai',
): 'gemma4' | 'bonsai' {
  const alias = value ?? fallback;
  if (alias === 'gemma4' || alias === 'bonsai') return alias;
  return defaultAlias;
}

/**
 * プロジェクト全体の設定管理
 */
export const config = {
  // localLlm プロジェクトのルートパス (MCP Retriever用)
  localLlmPath:
    process.env.GNOSIS_LOCAL_LLM_PATH ||
    path.resolve(process.cwd(), GNOSIS_CONSTANTS.LOCAL_LLM_PATH_DEFAULT),

  // LLM スクリプトのフルパス (個別コマンド)
  gemma4Script: process.env.GNOSIS_GEMMA4_SCRIPT || path.resolve(process.cwd(), 'scripts/gemma4'),
  bonsaiScript: process.env.GNOSIS_BONSAI_SCRIPT || path.resolve(process.cwd(), 'scripts/bonsai'),
  openaiScript: process.env.GNOSIS_OPENAI_SCRIPT || path.resolve(process.cwd(), 'scripts/openai'),
  bedrockScript:
    process.env.GNOSIS_BEDROCK_SCRIPT || path.resolve(process.cwd(), 'scripts/bedrock'),

  // 現在使用する LLM スクリプト (デフォルト: gemma4)
  llmScript:
    process.env.GNOSIS_LLM_SCRIPT ||
    path.resolve(process.cwd(), GNOSIS_CONSTANTS.LLM_SCRIPT_DEFAULT),

  // モックRetrieverを使用するかどうか
  mockRetriever: envBoolean(process.env.GNOSIS_MOCK_RETRIEVER, false),

  // エンティティ抽出/マージ時のタイムアウト (ms)
  llmTimeoutMs: envNumber(process.env.GNOSIS_LLM_TIMEOUT_MS, 90_000),

  // 埋め込みベクトルの生成コマンド (フルパス)
  embedCommand:
    process.env.GNOSIS_EMBED_COMMAND ||
    path.resolve(process.cwd(), GNOSIS_CONSTANTS.EMBED_COMMAND_DEFAULT),
  embedTimeoutMs: Math.max(
    1,
    envNumber(process.env.GNOSIS_EMBED_TIMEOUT_MS, GNOSIS_CONSTANTS.EMBED_TIMEOUT_MS_DEFAULT),
  ),

  // Bun バイナリのパス
  bunCommand: process.env.GNOSIS_BUN_COMMAND || 'bun',

  // ベクトルの次元数
  embeddingDimension: envNumber(
    process.env.GNOSIS_EMBEDDING_DIMENSION,
    GNOSIS_CONSTANTS.EMBEDDING_DIMENSION_DEFAULT,
  ),

  // 自動デデュープ（重複排除）の類似度閾値
  dedupeThreshold: envNumber(
    process.env.GNOSIS_DEDUPE_THRESHOLD,
    GNOSIS_CONSTANTS.DEDUPE_THRESHOLD_DEFAULT,
  ),

  // 各種ログのディレクトリパス
  claudeLogDir: process.env.GNOSIS_CLAUDE_LOG_DIR || '',
  antigravityLogDir: process.env.GNOSIS_ANTIGRAVITY_LOG_DIR || '',
  agenticSearchLogFile: process.env.GNOSIS_AGENTIC_SEARCH_LOG_FILE || '',
  llmUsageLogFile: process.env.GNOSIS_LLM_USAGE_LOG_FILE || '',
  agenticSearchPreferCloud: envBoolean(process.env.GNOSIS_AGENTIC_SEARCH_PREFER_CLOUD, false),
  codexSessionDir:
    process.env.GNOSIS_CODEX_SESSION_DIR || path.join(os.homedir(), '.codex', 'sessions'),
  codexArchivedSessionDir:
    process.env.GNOSIS_CODEX_ARCHIVED_SESSION_DIR ||
    path.join(os.homedir(), '.codex', 'archived_sessions'),

  // 自己省察のバッチサイズ
  synthesisBatchSize: 10,

  // 連想検索の最大ホップ数
  maxPathHops: 5,

  // データベース接続情報 (Drizzle用)
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:7888/gnosis',

  knowflow: {
    llm: LlmClientConfigSchema.parse({
      apiBaseUrl:
        process.env.LOCAL_LLM_API_BASE_URL ?? GNOSIS_CONSTANTS.LOCAL_LLM_API_BASE_URL_DEFAULT,
      apiPath: process.env.LOCAL_LLM_API_PATH ?? GNOSIS_CONSTANTS.LOCAL_LLM_API_PATH_DEFAULT,
      apiKeyEnv: process.env.LOCAL_LLM_API_KEY_ENV ?? 'LOCAL_LLM_API_KEY',
      model: process.env.LOCAL_LLM_MODEL ?? GNOSIS_CONSTANTS.LOCAL_LLM_MODEL_DEFAULT,
      temperature: envNumber(process.env.LOCAL_LLM_TEMPERATURE, 0),
      timeoutMs: envNumber(
        process.env.LOCAL_LLM_TIMEOUT_MS,
        GNOSIS_CONSTANTS.LOCAL_LLM_TIMEOUT_MS_DEFAULT,
      ),
      maxRetries: Math.max(
        1,
        envNumber(
          process.env.LOCAL_LLM_MAX_RETRIES,
          GNOSIS_CONSTANTS.LOCAL_LLM_MAX_RETRIES_DEFAULT,
        ),
      ),
      retryDelayMs: Math.max(
        0,
        envNumber(
          process.env.LOCAL_LLM_RETRY_DELAY_MS,
          GNOSIS_CONSTANTS.LOCAL_LLM_RETRY_DELAY_MS_DEFAULT,
        ),
      ),
      enableCliFallback: envBoolean(
        process.env.LOCAL_LLM_ENABLE_CLI_FALLBACK,
        GNOSIS_CONSTANTS.LOCAL_LLM_ENABLE_CLI_FALLBACK_DEFAULT,
      ),
      cliCommand:
        process.env.LOCAL_LLM_CLI_COMMAND ??
        `${
          process.env.GNOSIS_LLM_SCRIPT || GNOSIS_CONSTANTS.LLM_SCRIPT_DEFAULT
        } --prompt {{prompt}}`,
      cliPromptMode: process.env.LOCAL_LLM_CLI_PROMPT_MODE === 'stdin' ? 'stdin' : 'arg',
      cliPromptPlaceholder: process.env.LOCAL_LLM_CLI_PROMPT_PLACEHOLDER ?? '{{prompt}}',
    }),
    worker: WorkerConfigSchema.parse({
      taskTimeoutMs: envNumber(
        process.env.KNOWFLOW_WORKER_TASK_TIMEOUT_MS,
        GNOSIS_CONSTANTS.WORKER_TASK_TIMEOUT_MS_DEFAULT,
      ),
      pollIntervalMs: envNumber(
        process.env.KNOWFLOW_WORKER_POLL_INTERVAL_MS,
        GNOSIS_CONSTANTS.WORKER_POLL_INTERVAL_MS_DEFAULT,
      ),
      postTaskDelayMs: envNumber(
        process.env.KNOWFLOW_WORKER_POST_TASK_DELAY_MS,
        GNOSIS_CONSTANTS.WORKER_POST_TASK_DELAY_MS_DEFAULT,
      ),
      parallelism: Math.max(
        1,
        envNumber(
          process.env.KNOWFLOW_WORKER_PARALLELISM,
          GNOSIS_CONSTANTS.WORKER_PARALLELISM_DEFAULT,
        ),
      ),
      maxConsecutiveErrors: envNumber(
        process.env.KNOWFLOW_WORKER_MAX_CONSECUTIVE_ERRORS,
        GNOSIS_CONSTANTS.WORKER_MAX_CONSECUTIVE_ERRORS_DEFAULT,
      ),
      maxQueriesPerTask: envNumber(
        process.env.KNOWFLOW_WORKER_MAX_QUERIES_PER_TASK,
        GNOSIS_CONSTANTS.WORKER_MAX_QUERIES_PER_TASK_DEFAULT,
      ),
      cronRunWindowMs: envNumber(
        process.env.KNOWFLOW_WORKER_CRON_RUN_WINDOW_MS,
        GNOSIS_CONSTANTS.WORKER_CRON_RUN_WINDOW_MS_DEFAULT,
      ),
    }),
    keywordCron: KeywordCronConfigSchema.parse({
      enabled: envBoolean(process.env.KNOWFLOW_KEYWORD_CRON_ENABLED, true),
      maxTopics: Math.max(1, envNumber(process.env.KNOWFLOW_KEYWORD_CRON_MAX_TOPICS, 10)),
      lookbackHours: Math.max(1, envNumber(process.env.KNOWFLOW_KEYWORD_CRON_LOOKBACK_HOURS, 168)),
    }),
    healthCheck: {
      timeoutMs: envNumber(
        process.env.KNOWFLOW_HEALTH_CHECK_TIMEOUT_MS,
        GNOSIS_CONSTANTS.HEALTH_CHECK_TIMEOUT_MS_DEFAULT,
      ),
    },
  },

  graph: {
    similarityThreshold: envNumber(
      process.env.GNOSIS_GRAPH_SIMILARITY_THRESHOLD,
      GNOSIS_CONSTANTS.GRAPH_SIMILARITY_THRESHOLD_DEFAULT,
    ),
    maxPathHops: envNumber(
      process.env.GNOSIS_GRAPH_MAX_PATH_HOPS,
      GNOSIS_CONSTANTS.GRAPH_MAX_PATH_HOPS_DEFAULT,
    ),
  },

  memory: {
    retries: envNumber(process.env.GNOSIS_MEMORY_RETRIES, GNOSIS_CONSTANTS.MEMORY_RETRIES_DEFAULT),
    retryWaitMultiplier: envNumber(
      process.env.GNOSIS_MEMORY_RETRY_WAIT_MULTIPLIER,
      GNOSIS_CONSTANTS.MEMORY_RETRY_WAIT_MULTIPLIER_DEFAULT,
    ),
  },

  llm: {
    maxBuffer: envNumber(
      process.env.GNOSIS_LLM_MAX_BUFFER_BYTES,
      GNOSIS_CONSTANTS.LLM_MAX_BUFFER_BYTES_DEFAULT,
    ),
    defaultTimeoutMs: envNumber(
      process.env.GNOSIS_LLM_DEFAULT_TIMEOUT_MS,
      GNOSIS_CONSTANTS.LLM_DEFAULT_TIMEOUT_MS_DEFAULT,
    ),
    concurrencyLimit: envNumber(
      process.env.GNOSIS_LLM_CONCURRENCY_LIMIT,
      GNOSIS_CONSTANTS.LLM_CONCURRENCY_LIMIT_DEFAULT,
    ),
  },

  memoryLoop: MemoryLoopConfigSchema.parse({
    allowCloud: envBoolean(
      process.env.MEMORY_LOOP_ALLOW_CLOUD,
      GNOSIS_CONSTANTS.MEMORY_LOOP_ALLOW_CLOUD_DEFAULT,
    ),
    cloudProvider: process.env.MEMORY_LOOP_CLOUD_PROVIDER === 'bedrock' ? 'bedrock' : 'openai',
    defaultAlias: memoryLoopAlias(
      process.env.MEMORY_LOOP_DEFAULT_ALIAS,
      GNOSIS_CONSTANTS.MEMORY_LOOP_DEFAULT_ALIAS_DEFAULT,
      'gemma4',
    ),
    lightAlias: memoryLoopAlias(
      process.env.MEMORY_LOOP_LIGHT_ALIAS,
      GNOSIS_CONSTANTS.MEMORY_LOOP_LIGHT_ALIAS_DEFAULT,
      'bonsai',
    ),
    intervalMs: envNumber(
      process.env.MEMORY_LOOP_INTERVAL_MS,
      GNOSIS_CONSTANTS.MEMORY_LOOP_INTERVAL_MS_DEFAULT,
    ),
    maxLocalRetries: Math.max(
      1,
      envNumber(
        process.env.MEMORY_LOOP_MAX_LOCAL_RETRIES,
        GNOSIS_CONSTANTS.MEMORY_LOOP_MAX_LOCAL_RETRIES_DEFAULT,
      ),
    ),
    minQualityScore: envNumber(
      process.env.MEMORY_LOOP_MIN_QUALITY_SCORE,
      GNOSIS_CONSTANTS.MEMORY_LOOP_MIN_QUALITY_SCORE_DEFAULT,
    ),
    idleBackoffMultiplier: Math.max(
      1,
      envNumber(
        process.env.MEMORY_LOOP_IDLE_BACKOFF_MULTIPLIER,
        GNOSIS_CONSTANTS.MEMORY_LOOP_IDLE_BACKOFF_MULTIPLIER_DEFAULT,
      ),
    ),
    maxIntervalMs: envNumber(
      process.env.MEMORY_LOOP_MAX_INTERVAL_MS,
      GNOSIS_CONSTANTS.MEMORY_LOOP_MAX_INTERVAL_MS_DEFAULT,
    ),
    enableDailyAudit: envBoolean(process.env.MEMORY_LOOP_ENABLE_DAILY_AUDIT, true),
    enableWeeklyAudit: envBoolean(process.env.MEMORY_LOOP_ENABLE_WEEKLY_AUDIT, true),
  }),

  backgroundWorker: {
    enabled: envBoolean(
      process.env.GNOSIS_BACKGROUND_WORKER_ENABLED,
      GNOSIS_CONSTANTS.BACKGROUND_WORKER_ENABLED_DEFAULT,
    ),
    intervalMs: envNumber(process.env.GNOSIS_BACKGROUND_WORKER_INTERVAL_MS, 300_000), // 5 min
    minRawCount: envNumber(process.env.GNOSIS_BACKGROUND_WORKER_MIN_RAW_COUNT, 5),
    maxConcurrency: envNumber(
      process.env.GNOSIS_BACKGROUND_WORKER_MAX_CONCURRENCY,
      GNOSIS_CONSTANTS.BACKGROUND_WORKER_MAX_CONCURRENCY_DEFAULT,
    ),
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
    maxChunkChars: Math.max(
      200,
      envNumber(
        process.env.GUIDANCE_MAX_CHUNK_CHARS,
        GNOSIS_CONSTANTS.GUIDANCE_MAX_CHUNK_CHARS_DEFAULT,
      ),
    ),
    maxFileChars: Math.max(
      200,
      envNumber(
        process.env.GUIDANCE_MAX_FILE_CHARS,
        GNOSIS_CONSTANTS.GUIDANCE_MAX_FILE_CHARS_DEFAULT,
      ),
    ),
    alwaysLimit: Math.max(1, envNumber(process.env.GUIDANCE_ALWAYS_LIMIT, 4)),
    onDemandLimit: Math.max(1, envNumber(process.env.GUIDANCE_ON_DEMAND_LIMIT, 5)),
    maxPromptChars: Math.max(200, envNumber(process.env.GUIDANCE_MAX_PROMPT_CHARS, 3000)),
    minSimilarity: envNumber(
      process.env.GUIDANCE_MIN_SIMILARITY,
      GNOSIS_CONSTANTS.GUIDANCE_MIN_SIMILARITY_DEFAULT,
    ),
    enabled: envBoolean(process.env.GUIDANCE_ENABLED, true),
    project: process.env.GUIDANCE_PROJECT,
    priorityHigh: 100,
    priorityMid: 80,
    priorityLow: 50,
    maxZips: envNumber(process.env.GUIDANCE_MAX_ZIPS, GNOSIS_CONSTANTS.GUIDANCE_MAX_ZIPS_DEFAULT),
  },
};
