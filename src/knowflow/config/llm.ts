import { z } from 'zod';

export const CliPromptModeSchema = z.enum(['stdin', 'arg']);

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

export type CliPromptMode = z.infer<typeof CliPromptModeSchema>;
export type LlmClientConfig = z.infer<typeof LlmClientConfigSchema>;

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

export const loadLlmClientConfigFromEnv = (
  override: Partial<LlmClientConfig> = {},
): LlmClientConfig => {
  const config = {
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
    ...override,
  };

  return LlmClientConfigSchema.parse(config);
};
