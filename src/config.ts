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

/**
 * プロジェクト全体の設定管理
 */
export const config = {
  // LLM スクリプトのパス
  llmScript:
    process.env.GNOSIS_LLM_SCRIPT || path.join(os.homedir(), 'Code/localLlm/scripts/gemma4'),

  // localLlm プロジェクトのルートパス (MCP Retriever用)
  localLlmPath: process.env.GNOSIS_LOCAL_LLM_PATH || path.join(os.homedir(), 'Code/localLlm'),

  // エンティティ抽出/マージ時のタイムアウト (ms)
  llmTimeoutMs: envNumber(process.env.GNOSIS_LLM_TIMEOUT_MS, 90_000),

  // 埋め込みベクトルの生成コマンド
  embedCommand: process.env.GNOSIS_EMBED_COMMAND || path.join(os.homedir(), '.local/bin/embed'),
  embedTimeoutMs: Math.max(1, envNumber(process.env.GNOSIS_EMBED_TIMEOUT_MS, 30_000)),

  // Bun バイナリのパス (fallback を含む解決)
  bunCommand: process.env.GNOSIS_BUN_COMMAND || 'bun',
  bunFallbackPath: path.join(os.homedir(), '.bun/bin/bun'),

  // ベクトルの次元数
  embeddingDimension: envNumber(process.env.GNOSIS_EMBEDDING_DIMENSION, 384),

  // 自動デデュープ（重複排除）の類似度閾値
  dedupeThreshold: envNumber(process.env.GNOSIS_DEDUPE_THRESHOLD, 0.9),

  // 各種ログのディレクトリパス
  claudeLogDir: process.env.GNOSIS_CLAUDE_LOG_DIR || path.join(os.homedir(), '.claude/projects'),
  antigravityLogDir:
    process.env.GNOSIS_ANTIGRAVITY_LOG_DIR || path.join(os.homedir(), '.gemini/antigravity/brain'),

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
      cliCommand: process.env.LOCAL_LLM_CLI_COMMAND ?? 'gemma4 --prompt {{prompt}}',
      cliPromptMode: process.env.LOCAL_LLM_CLI_PROMPT_MODE === 'stdin' ? 'stdin' : 'arg',
      cliPromptPlaceholder: process.env.LOCAL_LLM_CLI_PROMPT_PLACEHOLDER ?? '{{prompt}}',
    }),
    budget: BudgetConfigSchema.parse({
      userBudget: envNumber(process.env.USER_BUDGET, 12),
      cronBudget: envNumber(process.env.CRON_BUDGET, 6),
      cronRunBudget: envNumber(process.env.CRON_RUN_BUDGET, 30),
    }),
  },
};
