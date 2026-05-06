import { exec, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { type LlmClientConfig, LlmClientConfigSchema, config } from '../config.js';
import { GNOSIS_CONSTANTS } from '../constants.js';
import { withGlobalSemaphore } from '../utils/lock.js';
import { sleep } from '../utils/time.js';

const execAsync = promisify(exec);

export type LlmBackend = 'api' | 'cli';
export type LlmTaskName = string;
export type LlmRequestPriority = 'high' | 'normal' | 'low';

export type RunLlmTaskInput = {
  task: LlmTaskName;
  context: Record<string, unknown>;
  requestId?: string;
  priority?: LlmRequestPriority;
};

export type RunLlmTaskResult = {
  task: LlmTaskName;
  text: string;
  backend: LlmBackend;
  warnings: string[];
};

export type LlmLogEvent = {
  event:
    | 'llm.task.start'
    | 'llm.task.attempt'
    | 'llm.task.success'
    | 'llm.task.retry'
    | 'llm.task.failed'
    | 'llm.task.raw_response'
    | 'ops.evidence_extractor.done';
  task: LlmTaskName;
  backend?: LlmBackend;
  attempt?: number;
  requestId?: string;
  message?: string;
  rawOutput?: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  [key: string]: unknown;
};

type AdapterDependencies = {
  invokeApi: (
    prompt: string,
    config: LlmClientConfig,
    signal?: AbortSignal,
    priority?: LlmRequestPriority,
  ) => Promise<string>;
  invokeCli: (prompt: string, config: LlmClientConfig, signal?: AbortSignal) => Promise<string>;
  loadPromptTemplate: (task: LlmTaskName) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  logger: (event: LlmLogEvent) => void;
};

const defaultLogger = (event: LlmLogEvent): void => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      ...event,
    }),
  );
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const parsePositiveEnvInt = (value: string | undefined, fallback: number): number => {
  if (!value || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const LLM_QUEUE_NAME = 'llm-pool';
const LLM_QUEUE_MAX_CONCURRENCY = parsePositiveEnvInt(
  process.env.KNOWFLOW_LLM_MAX_CONCURRENCY,
  config.llm.concurrencyLimit,
);
const EFFECTIVE_LLM_QUEUE_MAX_CONCURRENCY = Math.min(
  LLM_QUEUE_MAX_CONCURRENCY,
  config.llm.concurrencyLimit,
);
const LLM_QUEUE_TIMEOUT_MS = parsePositiveEnvInt(
  process.env.KNOWFLOW_LLM_QUEUE_TIMEOUT_MS,
  Math.max(GNOSIS_CONSTANTS.LLM_QUEUE_TIMEOUT_MS_DEFAULT, config.knowflow.llm.timeoutMs * 4),
);
const LLM_MAX_TOKENS = parsePositiveEnvInt(process.env.LOCAL_LLM_MAX_TOKENS, 256);

const withKnowflowLlmQueue = async <T>(fn: () => Promise<T>): Promise<T> =>
  withGlobalSemaphore(
    LLM_QUEUE_NAME,
    EFFECTIVE_LLM_QUEUE_MAX_CONCURRENCY,
    fn,
    LLM_QUEUE_TIMEOUT_MS,
  );

type OpenAiCompatibleResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

const extractLlmText = (content: unknown): string | undefined => {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((item) => {
      if (typeof item === 'object' && item !== null && 'text' in item) {
        const value = (item as { text?: unknown }).text;
        return typeof value === 'string' ? value : '';
      }
      return '';
    })
    .join('\n')
    .trim();

  return text.length > 0 ? text : undefined;
};

const resolveApiUrl = (base: string, path: string): string =>
  new URL(path, base.endsWith('/') ? base : `${base}/`).toString();

const defaultInvokeApi = async (
  prompt: string,
  config: LlmClientConfig,
  signal?: AbortSignal,
  priority: LlmRequestPriority = 'normal',
): Promise<string> => {
  if (signal?.aborted) {
    throw new Error('LLM task aborted by caller before queueing');
  }

  const url = resolveApiUrl(config.apiBaseUrl, config.apiPath);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  if (signal?.aborted) {
    clearTimeout(timeoutId);
    throw new Error('LLM task aborted by caller before start');
  }

  const abortListener = () => controller.abort();
  signal?.addEventListener('abort', abortListener, { once: true });

  try {
    const apiKey = process.env[config.apiKeyEnv];
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        max_tokens: LLM_MAX_TOKENS,
        priority,
        messages: [
          {
            role: 'system',
            content:
              'You are a concise assistant. Return final plain text only. Do not emit hidden reasoning, <think>, <|channel>, or tool-call tags.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API request failed: ${response.status} ${text}`);
    }

    const payload = (await response.json()) as OpenAiCompatibleResponse;
    const text = extractLlmText(payload.choices?.[0]?.message?.content);
    if (!text) {
      throw new Error('API response does not include message content.');
    }
    return text;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortListener);
  }
};

const runCliWithSemaphore = async (
  command: string,
  stdin: string | undefined,
  llmClientConfig: LlmClientConfig,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> =>
  withKnowflowLlmQueue(async () => {
    if (stdin) {
      return runCommandWithStdin(command, stdin, llmClientConfig.timeoutMs, signal);
    }

    return execAsync(command, {
      timeout: llmClientConfig.timeoutMs,
      maxBuffer: config.llm.maxBuffer,
      signal,
    });
  });

const runCommandWithStdin = (
  command: string,
  stdin: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      reject(new Error(`CLI command timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`CLI command failed with exit code ${code}: ${stderr || stdout}`));
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });

const defaultInvokeCli = async (
  prompt: string,
  llmClientConfig: LlmClientConfig,
  signal?: AbortSignal,
): Promise<string> => {
  if (signal?.aborted) {
    throw new Error('LLM task aborted by caller before queueing');
  }

  let command = llmClientConfig.cliCommand;
  let stdin: string | undefined;

  if (command.includes(llmClientConfig.cliPromptPlaceholder)) {
    command = command.split(llmClientConfig.cliPromptPlaceholder).join(shellQuote(prompt));
  } else if (llmClientConfig.cliPromptMode === 'arg') {
    command = `${command} ${shellQuote(prompt)}`;
  } else {
    stdin = prompt;
  }

  const { stdout, stderr } = await runCliWithSemaphore(command, stdin, llmClientConfig, signal);

  const output = stdout.trim();
  if (output.length === 0) {
    throw new Error(`CLI returned empty output. stderr=${stderr}`);
  }
  return output;
};

const defaultLoadPromptTemplate = async (task: LlmTaskName): Promise<string> => {
  const templateUrl = new URL(`../services/knowflow/prompts/${task}.md`, import.meta.url);
  return readFile(templateUrl, 'utf-8');
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertContextRecord = (value: unknown): Record<string, unknown> => {
  if (!isPlainRecord(value)) {
    throw new Error('LLM task context must be a plain object.');
  }
  return value;
};

const resolveLlmClientConfig = (override: Partial<LlmClientConfig> = {}): LlmClientConfig =>
  LlmClientConfigSchema.parse({
    ...config.knowflow.llm,
    ...override,
  });

const unwrapModelEnvelope = (text: string): string => {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isPlainRecord(parsed) && typeof parsed.response === 'string') {
      return parsed.response.trim();
    }
    return trimmed;
  } catch {
    return trimmed;
  }
};

const MODEL_CONTROL_PARSE_FAILURE_PREFIX =
  '[System] Tool call or think block was generated but failed to parse.';
const MODEL_CONTROL_PARSE_FAILURE_MESSAGE =
  'LLM backend returned a tool/think block parse failure.';

class LlmBackendAttemptsError extends Error {
  readonly backend: LlmBackend;
  readonly attemptMessages: string[];

  constructor(backend: LlmBackend, attemptMessages: string[]) {
    const details = attemptMessages.length > 0 ? `: ${attemptMessages.join(' | ')}` : '';
    super(`All ${backend} attempts failed${details}`);
    this.name = 'LlmBackendAttemptsError';
    this.backend = backend;
    this.attemptMessages = attemptMessages;
  }
}

const assertModelText = (text: string): string => {
  if (text.startsWith(MODEL_CONTROL_PARSE_FAILURE_PREFIX)) {
    throw new Error(MODEL_CONTROL_PARSE_FAILURE_MESSAGE);
  }
  return text;
};

const isModelControlParseFailure = (text: string): boolean =>
  text.startsWith(MODEL_CONTROL_PARSE_FAILURE_PREFIX);

const isModelControlParseFailureMessage = (message: string): boolean =>
  message.includes(MODEL_CONTROL_PARSE_FAILURE_MESSAGE);

const didBackendFailOnlyWithControlParse = (error: unknown): boolean =>
  error instanceof LlmBackendAttemptsError &&
  error.attemptMessages.length > 0 &&
  error.attemptMessages.every(isModelControlParseFailureMessage);

const EMPTY_OUTPUT_ALLOWED_AFTER_CONTROL_FAILURE_TASKS = new Set<LlmTaskName>([
  'phrase_scout',
  'research_note',
]);
const LOCAL_LLM_EMPTY_OUTPUT_SENTINELS = new Set([
  '回答を生成できませんでした。',
  '上限に達しました。',
]);

const isEmptyOutputAllowedTask = (task: LlmTaskName): boolean =>
  EMPTY_OUTPUT_ALLOWED_AFTER_CONTROL_FAILURE_TASKS.has(task);

const isLocalLlmEmptyOutputSentinel = (text: string): boolean =>
  LOCAL_LLM_EMPTY_OUTPUT_SENTINELS.has(text.trim());

const canAcceptEmptyAfterControlParseFailure = (
  task: LlmTaskName,
  warnings: string[],
  controlParseFailureBackendCount: number,
): boolean =>
  isEmptyOutputAllowedTask(task) &&
  warnings.length > 0 &&
  controlParseFailureBackendCount > 0 &&
  warnings.length === controlParseFailureBackendCount;

const buildPlainTextRetryPrompt = (prompt: string): string =>
  [
    prompt,
    '',
    'Retry instruction:',
    'Your previous response contained only hidden thought/tool syntax and no usable final answer.',
    'Return final plain text only. Do not include <think>, <|channel>, tool-call tags, analysis, bullets unless the original task asks for bullets, or explanations.',
  ].join('\n');

const renderPrompt = (
  template: string,
  task: LlmTaskName,
  context: Record<string, unknown>,
): string => {
  let rendered = template
    .replaceAll('{{task_name}}', task)
    .replaceAll('{{context_json}}', JSON.stringify(context, null, 2));

  for (const [key, value] of Object.entries(context)) {
    rendered = rendered.replaceAll(`{{${key}}}`, String(value));
  }
  return rendered;
};

const attemptBackend = async (
  input: RunLlmTaskInput,
  backend: LlmBackend,
  prompt: string,
  llmConfig: LlmClientConfig,
  deps: AdapterDependencies,
  signal?: AbortSignal,
): Promise<{ text: string; attempt: number }> => {
  let promptForAttempt = prompt;
  const attemptMessages: string[] = [];

  for (let attempt = 1; attempt <= llmConfig.maxRetries; attempt += 1) {
    if (signal?.aborted) {
      throw new Error('LLM task aborted by signal during retry loop');
    }

    deps.logger({
      event: 'llm.task.attempt',
      task: input.task,
      backend,
      attempt,
      requestId: input.requestId,
    });

    try {
      const raw =
        backend === 'api'
          ? await deps.invokeApi(promptForAttempt, llmConfig, signal, input.priority ?? 'normal')
          : await deps.invokeCli(promptForAttempt, llmConfig, signal);

      deps.logger({
        event: 'llm.task.raw_response',
        task: input.task,
        backend,
        attempt,
        requestId: input.requestId,
        rawOutput: raw.slice(0, 2000),
        level: 'debug',
      });

      const unwrapped = unwrapModelEnvelope(raw).trim();
      if (isModelControlParseFailure(unwrapped) && attempt < llmConfig.maxRetries) {
        promptForAttempt = buildPlainTextRetryPrompt(prompt);
      }
      const text = assertModelText(unwrapped).trim();
      if (isEmptyOutputAllowedTask(input.task) && isLocalLlmEmptyOutputSentinel(text)) {
        return { text: '', attempt };
      }
      if (text.length === 0) {
        throw new Error(`LLM ${input.task} output is empty.`);
      }
      return { text, attempt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attemptMessages.push(message);
      deps.logger({
        event: 'llm.task.retry',
        task: input.task,
        backend,
        attempt,
        requestId: input.requestId,
        message,
      });

      if (attempt < llmConfig.maxRetries) {
        await deps.sleep(llmConfig.retryDelayMs);
      }
    }
  }

  throw new LlmBackendAttemptsError(backend, attemptMessages);
};

export const runLlmTextTask = async (
  input: RunLlmTaskInput,
  options?: {
    config?: Partial<LlmClientConfig>;
    deps?: Partial<AdapterDependencies>;
    signal?: AbortSignal;
  },
): Promise<RunLlmTaskResult> => {
  const task = input.task.trim();
  if (!task) {
    throw new Error('LLM task name must be non-empty.');
  }

  const context = assertContextRecord(input.context);
  const llmConfig = resolveLlmClientConfig(options?.config ?? {});
  const deps: AdapterDependencies = {
    invokeApi: options?.deps?.invokeApi ?? defaultInvokeApi,
    invokeCli: options?.deps?.invokeCli ?? defaultInvokeCli,
    loadPromptTemplate: options?.deps?.loadPromptTemplate ?? defaultLoadPromptTemplate,
    sleep: options?.deps?.sleep ?? sleep,
    logger: options?.deps?.logger ?? defaultLogger,
  };

  deps.logger({
    event: 'llm.task.start',
    task,
    requestId: input.requestId,
  });

  const warnings: string[] = [];
  let controlParseFailureBackendCount = 0;
  const template = await deps.loadPromptTemplate(task);
  const prompt = renderPrompt(template, task, context);

  try {
    const apiResult = await attemptBackend(input, 'api', prompt, llmConfig, deps, options?.signal);
    deps.logger({
      event: 'llm.task.success',
      task,
      backend: 'api',
      attempt: apiResult.attempt,
      requestId: input.requestId,
    });
    return { task, text: apiResult.text, backend: 'api', warnings };
  } catch (error) {
    if (didBackendFailOnlyWithControlParse(error)) {
      controlParseFailureBackendCount += 1;
    }
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  if (llmConfig.enableCliFallback) {
    try {
      const cliResult = await attemptBackend(
        input,
        'cli',
        prompt,
        llmConfig,
        deps,
        options?.signal,
      );
      deps.logger({
        event: 'llm.task.success',
        task,
        backend: 'cli',
        attempt: cliResult.attempt,
        requestId: input.requestId,
      });
      return { task, text: cliResult.text, backend: 'cli', warnings };
    } catch (error) {
      if (didBackendFailOnlyWithControlParse(error)) {
        controlParseFailureBackendCount += 1;
      }
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (canAcceptEmptyAfterControlParseFailure(task, warnings, controlParseFailureBackendCount)) {
    deps.logger({
      event: 'llm.task.success',
      task,
      backend: llmConfig.enableCliFallback ? 'cli' : 'api',
      requestId: input.requestId,
      message: 'empty output accepted after repeated tool/think block parse failure',
      level: 'warn',
    });
    return {
      task,
      text: '',
      backend: llmConfig.enableCliFallback ? 'cli' : 'api',
      warnings,
    };
  }

  deps.logger({
    event: 'llm.task.failed',
    task,
    backend: llmConfig.enableCliFallback ? 'cli' : 'api',
    requestId: input.requestId,
    message: warnings.join(' | '),
    level: 'error',
  });

  throw new Error(
    warnings.length > 0
      ? `LLM task failed: ${warnings.join(' | ')}`
      : 'LLM task failed without detailed warnings.',
  );
};

export const runLlmTask = runLlmTextTask;
