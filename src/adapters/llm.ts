import { exec, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { type LlmClientConfig, LlmClientConfigSchema, config } from '../config.js';
import { GNOSIS_CONSTANTS } from '../constants.js';
import {
  type LlmTaskName,
  LlmTaskNameSchema,
  type LlmTaskOutputMap,
  getTaskOutputHint,
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

// 全LLM経路で同一セマフォを使い、同時実行上限を1系統で強制する。
const LLM_QUEUE_NAME = 'llm-pool';
const LLM_QUEUE_MAX_CONCURRENCY = parsePositiveEnvInt(
  process.env.KNOWFLOW_LLM_MAX_CONCURRENCY,
  config.llm.concurrencyLimit,
);
const LLM_QUEUE_TIMEOUT_MS = parsePositiveEnvInt(
  process.env.KNOWFLOW_LLM_QUEUE_TIMEOUT_MS,
  Math.max(GNOSIS_CONSTANTS.LLM_QUEUE_TIMEOUT_MS_DEFAULT, config.knowflow.llm.timeoutMs * 4),
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
              content: 'You are a concise assistant. Return plain text only.',
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

const unwrapModelEnvelope = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"response"')) return trimmed;
  const responseMatch = trimmed.match(/"response"\s*:\s*"([\s\S]*)"\s*\}\s*$/);
  if (!responseMatch?.[1]) return trimmed;
  try {
    const parsed = JSON.parse(`"${responseMatch[1]}"`);
    return typeof parsed === 'string' ? parsed : trimmed;
  } catch {
    return trimmed;
  }
};

const splitTextLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const extractUrls = (text: string): string[] => {
  const matches = text.match(/https?:\/\/[^\s)"'<>\]]+/g) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of matches) {
    const url = raw.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
};

const clamp01 = (value: number, fallback = 0): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
};

const extractScore = (line: string, fallback = 0.5): number => {
  const match = line.match(/(?:score|priority|confidence)\s*[:=]\s*([01](?:\.\d+)?)/i);
  if (!match?.[1]) return fallback;
  return clamp01(Number(match[1]), fallback);
};

// Backward-compatible export for callers/tests that still import this symbol.
// JSON厳格運用は廃止したため、ここでは単純に生テキストを返す。
export const extractJsonCandidate = (text: string): string | undefined => {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const parseLlmTaskOutputText = <T extends LlmTaskName>(
  task: T,
  text: string,
): LlmTaskOutputMap[T] => {
  const plain = unwrapModelEnvelope(text);
  const trimmed = plain.trim();
  const lines = splitTextLines(plain);
  const firstLine = lines[0] ?? '';
  const bulletValues = lines
    .map((line) => line.match(/^[-*]\s+(.+)$/)?.[1]?.trim() ?? '')
    .filter((line) => line.length > 0);

  switch (task) {
    case 'query_generation': {
      // Backward compatibility: if a JSON payload comes back, read queries from it.
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed) as { queries?: unknown };
          if (Array.isArray(parsed.queries)) {
            const queries = parsed.queries
              .filter((item): item is string => typeof item === 'string')
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
              .slice(0, 5);
            if (queries.length > 0) {
              return { queries } as LlmTaskOutputMap[T];
            }
          }
        } catch {
          // fall through to plain-text parsing
        }
      }
      const queries = (bulletValues.length > 0 ? bulletValues : lines)
        .map((line) => line.replace(/^(query|q)\s*[:\-]\s*/i, '').trim())
        .filter((line) => line.length > 0)
        .slice(0, 5);
      return { queries: queries.length > 0 ? queries : ['topic overview'] } as LlmTaskOutputMap[T];
    }
    case 'search_result_selection': {
      const selected = extractUrls(plain)
        .slice(0, 5)
        .map((url) => ({
          url,
          reason: 'Selected from plain-text output.',
          priority: 0.6,
        }));
      return { selected } as LlmTaskOutputMap[T];
    }
    case 'page_usefulness_evaluation': {
      const merged = lines.join(' ').toLowerCase();
      const useful =
        /\b(useful|relevant|valuable|high signal|contains evidence)\b/i.test(merged) &&
        !/\b(not useful|irrelevant|off-topic|thin)\b/i.test(merged);
      const score = extractScore(
        lines.find((line) => /score|priority|confidence/i.test(line)) ?? '',
        useful ? 0.75 : 0.2,
      );
      const shouldFetchAnother =
        /\b(fetch another|need another|too thin|off-topic|insufficient)\b/i.test(merged);
      return {
        useful,
        score,
        reason: firstLine || 'Parsed from plain-text evaluation output.',
        shouldFetchAnother,
      } as LlmTaskOutputMap[T];
    }
    case 'emergent_topic_extraction': {
      const items = (bulletValues.length > 0 ? bulletValues : lines)
        .slice(0, 5)
        .map((line) => ({
          topic: line.replace(/^(topic)\s*[:\-]\s*/i, '').trim(),
          whyResearch: 'Extracted from plain-text emergent topic output.',
          relationType: 'expands' as const,
          score: extractScore(line, 0.65),
        }))
        .filter((item) => item.topic.length > 0);
      return { items } as LlmTaskOutputMap[T];
    }
    case 'hypothesis': {
      const hypotheses = (bulletValues.length > 0 ? bulletValues : lines)
        .slice(0, 5)
        .map((line, index) => ({
          id: `h${index + 1}`,
          hypothesis: line,
          rationale: 'Extracted from plain-text output.',
          priority: extractScore(line, 0.6),
        }));
      return { hypotheses } as LlmTaskOutputMap[T];
    }
    case 'gap_detection': {
      const gaps = (bulletValues.length > 0 ? bulletValues : lines).slice(0, 5).map((line) => ({
        type: 'uncertain' as const,
        description: line,
        priority: extractScore(line, 0.6),
      }));
      return { gaps } as LlmTaskOutputMap[T];
    }
    case 'gap_planner': {
      const steps = (bulletValues.length > 0 ? bulletValues : lines).slice(0, 5).map((line) => ({
        title: line,
        reason: 'Derived from plain-text gap planning output.',
        queries: [line],
      }));
      return { steps } as LlmTaskOutputMap[T];
    }
    case 'frontier_selection': {
      const selected = (bulletValues.length > 0 ? bulletValues : lines)
        .slice(0, 5)
        .map((line) => {
          const entityId = line.match(/\b[a-z_]+\/[A-Za-z0-9._:-]+\b/)?.[0] ?? line;
          return {
            entityId,
            score: extractScore(line, 0.6),
            reason: 'Selected from plain-text frontier output.',
          };
        })
        .filter((item) => item.entityId.length > 0);
      return { selected } as LlmTaskOutputMap[T];
    }
    case 'summarize': {
      return {
        summary: firstLine || 'Summary generated from plain-text output.',
        findings: (bulletValues.length > 0 ? bulletValues : lines.slice(1)).slice(0, 8),
      } as LlmTaskOutputMap[T];
    }
    case 'extract_evidence': {
      const claims = (bulletValues.length > 0 ? bulletValues : lines).slice(0, 10).map((line) => ({
        text: line,
        confidence: extractScore(line, 0.6),
      }));
      return { claims, relations: [] } as unknown as LlmTaskOutputMap[T];
    }
    case 'registration_decision': {
      const merged = lines.join(' ').toLowerCase();
      const allow =
        /\b(allow|approve|register|store|accept)\b/i.test(merged) &&
        !/\b(reject|deny|skip|hold|defer|insufficient)\b/i.test(merged);
      const confidence = extractScore(
        lines.find((line) => /confidence|score/i.test(line)) ?? '',
        allow ? 0.6 : 0.75,
      );
      return {
        allow,
        reason: firstLine || 'Parsed from plain-text registration decision output.',
        confidence,
      } as LlmTaskOutputMap[T];
    }
    default:
      return {} as LlmTaskOutputMap[T];
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
  frontier_selection: (context) => {
    const candidates = Array.isArray(context.candidates) ? context.candidates : [];
    const maxTopics =
      typeof context.maxTopics === 'number' && Number.isFinite(context.maxTopics)
        ? Math.max(1, Math.trunc(context.maxTopics))
        : 5;
    return {
      selected: candidates
        .map((item) => {
          if (typeof item !== 'object' || item === null) return undefined;
          const entityId = (item as { entityId?: unknown }).entityId;
          const score = (item as { score?: unknown }).score;
          return typeof entityId === 'string' && entityId.trim().length > 0
            ? {
                entityId: entityId.trim(),
                score: typeof score === 'number' && Number.isFinite(score) ? score : 0.1,
                reason: 'Fallback selected from deterministic frontier ranking.',
              }
            : undefined;
        })
        .filter((item): item is { entityId: string; score: number; reason: string } =>
          Boolean(item),
        )
        .slice(0, maxTopics),
    };
  },
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
  registration_decision: () => ({
    allow: false,
    reason: 'Registration decision degraded due to LLM output failure.',
    confidence: 0.9,
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
