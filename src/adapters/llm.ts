import { exec, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { type LlmClientConfig, LlmClientConfigSchema, config } from '../config.js';
import {
  type LlmTaskName,
  LlmTaskNameSchema,
  type LlmTaskOutputMap,
  getTaskOutputHint,
  parseLlmTaskOutput,
} from '../services/knowflow/schemas/llm.js';
import { withGlobalSemaphore } from '../utils/lock.js';
import { sleep } from '../utils/time.js';

const execAsync = promisify(exec);

export type LlmBackend = 'api' | 'cli';

export type RunLlmTaskInput<T extends LlmTaskName> = {
  task: T;
  context: Record<string, unknown>;
  requestId?: string;
};

export type RunLlmTaskResult<T extends LlmTaskName> = {
  task: T;
  output: LlmTaskOutputMap[T];
  backend: LlmBackend;
  degraded: boolean;
  warnings: string[];
};

export type LlmLogEvent = {
  event:
    | 'llm.task.start'
    | 'llm.task.attempt'
    | 'llm.task.success'
    | 'llm.task.retry'
    | 'llm.task.degraded'
    | 'llm.task.raw_response'
    | 'gap_planner.enqueued'
    | 'gap_planner.fallback_enqueued'
    | 'gap_planner.error'
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
  invokeApi: (prompt: string, config: LlmClientConfig, signal?: AbortSignal) => Promise<string>;
  invokeCli: (prompt: string, config: LlmClientConfig, signal?: AbortSignal) => Promise<string>;
  loadPromptTemplate: (task: LlmTaskName) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  logger: (event: LlmLogEvent) => void;
};

const defaultLogger = (event: LlmLogEvent): void => {
  const payload = {
    ts: new Date().toISOString(),
    ...event,
  };
  console.error(JSON.stringify(payload));
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const parsePositiveEnvInt = (value: string | undefined, fallback: number): number => {
  if (!value || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const LLM_QUEUE_NAME = process.env.KNOWFLOW_LLM_QUEUE_NAME?.trim() || 'llm-pool';
const LLM_QUEUE_MAX_CONCURRENCY = parsePositiveEnvInt(
  process.env.KNOWFLOW_LLM_MAX_CONCURRENCY,
  config.llm.concurrencyLimit,
);
const LLM_QUEUE_TIMEOUT_MS = parsePositiveEnvInt(
  process.env.KNOWFLOW_LLM_QUEUE_TIMEOUT_MS,
  Math.max(15 * 60 * 1000, config.knowflow.llm.timeoutMs * 4),
);

const withKnowflowLlmQueue = async <T>(fn: () => Promise<T>): Promise<T> =>
  withGlobalSemaphore(LLM_QUEUE_NAME, LLM_QUEUE_MAX_CONCURRENCY, fn, LLM_QUEUE_TIMEOUT_MS);

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
): Promise<string> => {
  if (signal?.aborted) {
    throw new Error('LLM task aborted by caller before queueing');
  }
  return await withKnowflowLlmQueue(async () => {
    const url = resolveApiUrl(config.apiBaseUrl, config.apiPath);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    // 外部からの signal が aborted の場合は即座に終了
    if (signal?.aborted) {
      clearTimeout(timeoutId);
      throw new Error('LLM task aborted by caller before start');
    }

    // 外部の signal を abortController にマージする
    const abortListener = () => {
      controller.abort();
    };
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
          messages: [
            {
              role: 'system',
              content: 'You are a structured assistant. Return only JSON object output.',
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
  });
};

const defaultInvokeCli = async (
  prompt: string,
  llmClientConfig: LlmClientConfig,
  signal?: AbortSignal,
): Promise<string> => {
  if (signal?.aborted) {
    throw new Error('LLM task aborted by caller before queueing');
  }
  return await withKnowflowLlmQueue(async () => {
    let command = llmClientConfig.cliCommand;
    let stdin: string | undefined;

    if (command.includes(llmClientConfig.cliPromptPlaceholder)) {
      command = command.split(llmClientConfig.cliPromptPlaceholder).join(shellQuote(prompt));
    } else if (llmClientConfig.cliPromptMode === 'arg') {
      command = `${command} ${shellQuote(prompt)}`;
    } else {
      stdin = prompt;
    }

    const { stdout, stderr } = stdin
      ? await runCommandWithStdin(command, stdin, llmClientConfig.timeoutMs, signal)
      : await execAsync(command, {
          timeout: llmClientConfig.timeoutMs,
          maxBuffer: config.llm.maxBuffer,
          signal,
        });

    const output = stdout.trim();
    if (output.length === 0) {
      throw new Error(`CLI returned empty output. stderr=${stderr}`);
    }

    return output;
  });
};

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

const defaultLoadPromptTemplate = async (task: LlmTaskName): Promise<string> => {
  const templateUrl = new URL(`../services/knowflow/prompts/${task}.md`, import.meta.url);
  return readFile(templateUrl, 'utf-8');
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertContextRecord = (value: unknown): Record<string, unknown> => {
  if (!isPlainRecord(value)) {
    throw new Error('LLM task context must be a plain JSON object.');
  }
  return value;
};

const resolveLlmClientConfig = (override: Partial<LlmClientConfig> = {}): LlmClientConfig =>
  LlmClientConfigSchema.parse({
    ...config.knowflow.llm,
    ...override,
  });

export const extractJsonCandidate = (text: string): string | undefined => {
  const trimmed = text.trim();

  // 1. Markdown code block check (most common in well-behaved LLMs)
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    const fenced = fenceMatch[1].trim();
    if (fenced.startsWith('{') && fenced.endsWith('}')) {
      return fenced;
    }
    // Deep check inside fence (e.g. text before/after JSON inside a fence)
    const inner = extractJsonCandidate(fenced);
    if (inner) return inner;
  }

  // 2. Finding boundaries with priority to outer most braces
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');

  if (firstBrace >= 0) {
    // If no closing brace, or closing brace is before opening brace
    if (lastBrace <= firstBrace) {
      // Possible truncated output: return from first brace to end
      return trimmed.slice(firstBrace);
    }
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return undefined;
};

/**
 * 不完全なJSON（切り捨てられた出力など）を修復する試み
 */
function repairJson(json: string): string {
  let repaired = json.trim();

  // 末尾がカンマで終わっている場合、削除する（不完全なオブジェクト/配列の要素の後のカンマ）
  repaired = repaired.replace(/,\s*$/, '');

  // 文字列が閉じられていない場合の処理
  // エスケープされたクォート \" を除外してカウント
  const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    repaired += '"';
  }

  // 括弧のバランスを取る
  const stack: string[] = [];
  let inString = false;
  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];
    // 文字列の中かどうかを判定（エスケープされていないクォートで切り替え）
    if (char === '"' && (i === 0 || repaired[i - 1] !== '\\')) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === char) {
        stack.pop();
      }
    }
  }

  // 足りない閉じ括弧を逆順に追加
  while (stack.length > 0) {
    repaired += stack.pop();
  }

  return repaired;
}

export const parseLlmTaskOutputText = <T extends LlmTaskName>(
  task: T,
  text: string,
): LlmTaskOutputMap[T] => {
  const jsonCandidate = extractJsonCandidate(text);
  if (!jsonCandidate) {
    throw new Error(`Failed to find JSON object in LLM output. (Text length: ${text.length})`);
  }

  // 1. そのままパースを試みる
  try {
    return parseLlmTaskOutput(task, JSON.parse(jsonCandidate));
  } catch (error) {
    // 2. ロバストな修復を試みる
    try {
      const repaired = repairJson(jsonCandidate);
      if (repaired !== jsonCandidate) {
        return parseLlmTaskOutput(task, JSON.parse(repaired));
      }
    } catch {
      // ignore
    }

    // 3. 従来の固定サフィックスによる修復（後方互換性のため）
    if (jsonCandidate.startsWith('{')) {
      // Basic heuristic: append closing characters until it parses or we reach a limit
      const repairSuffixes = ['}', ']}', ' ] }', ']]}', '}]}', '}}', '}}}'];
      for (const suffix of repairSuffixes) {
        try {
          return parseLlmTaskOutput(task, JSON.parse(jsonCandidate + suffix));
        } catch {
          // continue
        }
      }
    }
    const snippet =
      jsonCandidate.length > 100 ? `${jsonCandidate.slice(0, 100)}...` : jsonCandidate;
    const rawSnippet = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    throw new Error(
      `Incomplete or malformed JSON from LLM: ${snippet}. Raw output: ${rawSnippet}. Original error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const degradedOutputBuilders: {
  [K in LlmTaskName]: (context: Record<string, unknown>) => LlmTaskOutputMap[K];
} = {
  hypothesis: (context) => {
    const topic =
      typeof context.topic === 'string' && context.topic.trim().length > 0
        ? context.topic.trim()
        : 'unknown topic';
    return {
      hypotheses: [
        {
          id: 'fallback-1',
          hypothesis: `Investigate baseline facts about ${topic}`,
          rationale: 'Fallback output due to repeated parse/inference failures.',
          priority: 0.1,
        },
      ],
    };
  },
  query_generation: (context) => {
    const topic =
      typeof context.topic === 'string' && context.topic.trim().length > 0
        ? context.topic.trim()
        : 'unknown topic';
    return {
      queries: [`${topic} overview`],
    };
  },
  gap_detection: () => ({
    gaps: [
      {
        type: 'uncertain',
        description: 'Gap detection degraded due to LLM output failure.',
        priority: 0.1,
      },
    ],
  }),
  search_result_selection: (context) => {
    const results = Array.isArray(context.results) ? context.results : [];
    const maxPages =
      typeof context.max_pages === 'number' && Number.isFinite(context.max_pages)
        ? Math.max(1, Math.trunc(context.max_pages))
        : 5;
    return {
      selected: results
        .map((item) => {
          if (typeof item !== 'object' || item === null) return undefined;
          const url = (item as { url?: unknown }).url;
          return typeof url === 'string' && url.trim().length > 0
            ? { url: url.trim(), reason: 'Fallback selected from search order.', priority: 0.1 }
            : undefined;
        })
        .filter((item): item is { url: string; reason: string; priority: number } => Boolean(item))
        .slice(0, maxPages),
    };
  },
  page_usefulness_evaluation: () => ({
    useful: false,
    score: 0,
    reason: 'Usefulness evaluation degraded due to LLM output failure.',
    shouldFetchAnother: true,
  }),
  emergent_topic_extraction: () => ({
    items: [],
  }),
  gap_planner: (context) => {
    const topic =
      typeof context.topic === 'string' && context.topic.trim().length > 0
        ? context.topic.trim()
        : 'unknown topic';
    return {
      steps: [
        {
          title: 'Fallback plan',
          reason: 'Planner degraded due to LLM output failure.',
          queries: [`${topic} latest documentation`],
        },
      ],
    };
  },
  summarize: () => ({
    summary: 'Summary degraded due to LLM output failure.',
    findings: [],
  }),
  extract_evidence: () => ({
    claims: [],
    relations: [],
  }),
};

const degradeTaskOutput = <T extends LlmTaskName>(
  task: T,
  context: Record<string, unknown>,
): LlmTaskOutputMap[T] => {
  return degradedOutputBuilders[task](context);
};

const renderPrompt = (
  template: string,
  task: LlmTaskName,
  context: Record<string, unknown>,
): string => {
  let rendered = template
    .replaceAll('{{task_name}}', task)
    .replaceAll('{{context_json}}', JSON.stringify(context, null, 2))
    .replaceAll('{{output_hint}}', getTaskOutputHint(task));

  for (const [key, value] of Object.entries(context)) {
    rendered = rendered.replaceAll(`{{${key}}}`, String(value));
  }
  return rendered;
};

const attemptBackend = async <T extends LlmTaskName>(
  input: RunLlmTaskInput<T>,
  backend: LlmBackend,
  prompt: string,
  config: LlmClientConfig,
  deps: AdapterDependencies,
  signal?: AbortSignal,
): Promise<{ output: LlmTaskOutputMap[T]; attempt: number }> => {
  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
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
          ? await deps.invokeApi(prompt, config, signal)
          : await deps.invokeCli(prompt, config, signal);

      deps.logger({
        event: 'llm.task.raw_response',
        task: input.task,
        backend,
        attempt,
        requestId: input.requestId,
        rawOutput: raw.slice(0, 2000), // 長すぎるとログが溢れるため切り詰め
        level: 'debug',
      });

      const output = parseLlmTaskOutputText(input.task, raw);
      return { output, attempt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger({
        event: 'llm.task.retry',
        task: input.task,
        backend,
        attempt,
        requestId: input.requestId,
        message,
      });

      if (attempt < config.maxRetries) {
        await deps.sleep(config.retryDelayMs);
      }
    }
  }

  throw new Error(`All ${backend} attempts failed.`);
};

export const runLlmTask = async <T extends LlmTaskName>(
  input: RunLlmTaskInput<T>,
  options?: {
    config?: Partial<LlmClientConfig>;
    deps?: Partial<AdapterDependencies>;
    signal?: AbortSignal;
  },
): Promise<RunLlmTaskResult<T>> => {
  LlmTaskNameSchema.parse(input.task);
  const task = input.task;
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

    return {
      task,
      output: apiResult.output,
      backend: 'api',
      degraded: false,
      warnings,
    };
  } catch (error) {
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

      return {
        task,
        output: cliResult.output,
        backend: 'cli',
        degraded: false,
        warnings,
      };
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  const degraded = degradeTaskOutput(task, context);
  deps.logger({
    event: 'llm.task.degraded',
    task,
    backend: llmConfig.enableCliFallback ? 'cli' : 'api',
    requestId: input.requestId,
    message: warnings.join(' | '),
  });

  return {
    task,
    output: degraded,
    backend: llmConfig.enableCliFallback ? 'cli' : 'api',
    degraded: true,
    warnings,
  };
};
