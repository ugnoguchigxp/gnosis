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
import { withGlobalLock } from '../utils/lock.js';
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
    | 'llm.task.degraded';
  task: LlmTaskName;
  backend?: LlmBackend;
  attempt?: number;
  requestId?: string;
  message?: string;
};

type AdapterDependencies = {
  invokeApi: (prompt: string, config: LlmClientConfig) => Promise<string>;
  invokeCli: (prompt: string, config: LlmClientConfig) => Promise<string>;
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

const defaultInvokeApi = async (prompt: string, config: LlmClientConfig): Promise<string> => {
  const url = resolveApiUrl(config.apiBaseUrl, config.apiPath);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

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
    clearTimeout(timeout);
  }
};

const defaultInvokeCli = async (
  prompt: string,
  llmClientConfig: LlmClientConfig,
): Promise<string> => {
  return await withGlobalLock('local-llm', async () => {
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
      ? await runCommandWithStdin(command, stdin, llmClientConfig.timeoutMs)
      : await execAsync(command, {
          timeout: llmClientConfig.timeoutMs,
          maxBuffer: config.llm.maxBuffer,
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
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
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
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    const fenced = fenceMatch[1].trim();
    if (fenced.startsWith('{') && fenced.endsWith('}')) {
      return fenced;
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return undefined;
};

export const parseLlmTaskOutputText = <T extends LlmTaskName>(
  task: T,
  text: string,
): LlmTaskOutputMap[T] => {
  const jsonCandidate = extractJsonCandidate(text);
  if (!jsonCandidate) {
    throw new Error('Response does not contain JSON object.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch (error) {
    throw new Error(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return parseLlmTaskOutput(task, parsed);
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
  return template
    .replaceAll('{{task_name}}', task)
    .replaceAll('{{context_json}}', JSON.stringify(context, null, 2))
    .replaceAll('{{output_hint}}', getTaskOutputHint(task));
};

const attemptBackend = async <T extends LlmTaskName>(
  input: RunLlmTaskInput<T>,
  backend: LlmBackend,
  prompt: string,
  config: LlmClientConfig,
  deps: AdapterDependencies,
): Promise<{ output: LlmTaskOutputMap[T]; attempt: number }> => {
  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
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
          ? await deps.invokeApi(prompt, config)
          : await deps.invokeCli(prompt, config);
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
    const apiResult = await attemptBackend(input, 'api', prompt, llmConfig, deps);
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
      const cliResult = await attemptBackend(input, 'cli', prompt, llmConfig, deps);
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
