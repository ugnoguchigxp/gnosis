import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runLlmTask } from '../../../adapters/llm.js';
import type { LlmLogEvent } from '../../../adapters/llm.js';
import type { LlmClientConfig } from '../../../config.js';
import { type LlmTaskName, LlmTaskNameSchema } from '../schemas/llm.js';

type EvalCase = {
  id: string;
  task: LlmTaskName;
  context: Record<string, unknown>;
};

type EvalSuite = {
  name: string;
  description?: string;
  cases: EvalCase[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseEvalCase = (input: unknown, index: number): EvalCase => {
  if (!isRecord(input)) {
    throw new Error(`Invalid eval suite: cases[${index}] must be an object`);
  }
  if (typeof input.id !== 'string' || input.id.trim().length === 0) {
    throw new Error(`Invalid eval suite: cases[${index}].id must be a non-empty string`);
  }
  if (typeof input.task !== 'string') {
    throw new Error(`Invalid eval suite: cases[${index}].task must be a string`);
  }
  if (!isRecord(input.context)) {
    throw new Error(`Invalid eval suite: cases[${index}].context must be a JSON object`);
  }

  const parsedTask = LlmTaskNameSchema.safeParse(input.task);
  if (!parsedTask.success) {
    throw new Error(`Invalid eval suite: cases[${index}].task is not supported: ${input.task}`);
  }

  return {
    id: input.id,
    task: parsedTask.data,
    context: input.context,
  };
};

const parseEvalSuite = (input: unknown): EvalSuite => {
  if (!isRecord(input)) {
    throw new Error('Invalid eval suite: suite root must be an object');
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new Error('Invalid eval suite: name must be a non-empty string');
  }
  if (!Array.isArray(input.cases)) {
    throw new Error('Invalid eval suite: cases must be an array');
  }

  return {
    name: input.name,
    description: typeof input.description === 'string' ? input.description : undefined,
    cases: input.cases.map((item, index) => parseEvalCase(item, index)),
  };
};

const calcPercent = (num: number, den: number): number => {
  if (den <= 0) return 0;
  return Number(((num / den) * 100).toFixed(2));
};

const calcP95 = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[index] ?? 0;
};

export type EvalCaseResult = {
  id: string;
  task: LlmTaskName;
  ok: boolean;
  degraded: boolean;
  backend?: 'api' | 'cli';
  warnings: string[];
  latencyMs: number;
  error?: string;
};

export type EvalRunResult = {
  suite: string;
  description?: string;
  caseCount: number;
  passedCount: number;
  failedCount: number;
  degradedCount: number;
  degradedRate: number;
  schemaValidRate: number;
  warningCaseRate: number;
  latency: {
    minMs: number;
    avgMs: number;
    p95Ms: number;
    maxMs: number;
  };
  backends: {
    api: number;
    cli: number;
  };
  cases: EvalCaseResult[];
};

export type EvalRunMode = 'live' | 'mock';

export type RunEvalSuiteDeps = {
  readSuiteFile?: (suiteName: string) => Promise<string>;
  runLlmTask?: typeof runLlmTask;
};

export const runEvalSuite = async (
  options: {
    suiteName: string;
    llmConfig?: Partial<LlmClientConfig>;
    requestPrefix?: string;
    llmLogger?: (event: LlmLogEvent) => void;
    maxDegradedRate?: number;
    mode?: EvalRunMode;
  },
  deps: RunEvalSuiteDeps = {},
): Promise<EvalRunResult> => {
  if (
    options.maxDegradedRate !== undefined &&
    (!Number.isFinite(options.maxDegradedRate) ||
      options.maxDegradedRate < 0 ||
      options.maxDegradedRate > 100)
  ) {
    throw new Error('--max-degraded-rate must be between 0 and 100');
  }

  const suitePath = resolve(process.cwd(), 'eval', 'suites', `${options.suiteName}.json`);
  const raw = await (deps.readSuiteFile
    ? deps.readSuiteFile(options.suiteName)
    : readFile(suitePath, 'utf-8'));
  const suite = parseEvalSuite(JSON.parse(raw));
  const mode = options.mode ?? 'live';

  const cases: EvalCaseResult[] = [];
  for (const item of suite.cases) {
    const startedAt = Date.now();
    const requestId = `${options.requestPrefix ?? 'eval'}:${options.suiteName}:${item.id}`;
    if (mode === 'mock') {
      const latencyMs = Date.now() - startedAt;
      cases.push({
        id: item.id,
        task: item.task,
        ok: true,
        degraded: false,
        backend: 'cli',
        warnings: [],
        latencyMs,
      });
      continue;
    }

    try {
      const _runLlmTask = deps.runLlmTask ?? runLlmTask;
      const result = await _runLlmTask(
        {
          task: item.task,
          context: item.context,
          requestId,
        },
        {
          config: options.llmConfig,
          deps: options.llmLogger ? { logger: options.llmLogger } : undefined,
        },
      );
      const latencyMs = Date.now() - startedAt;
      cases.push({
        id: item.id,
        task: item.task,
        ok: true,
        degraded: result.degraded,
        backend: result.backend,
        warnings: result.warnings,
        latencyMs,
      });
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      cases.push({
        id: item.id,
        task: item.task,
        ok: false,
        degraded: false,
        warnings: [],
        latencyMs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const caseCount = cases.length;
  const passedCount = cases.filter((item) => item.ok).length;
  const failedCount = caseCount - passedCount;
  const degradedCount = cases.filter((item) => item.ok && item.degraded).length;
  const warningCaseCount = cases.filter((item) => item.warnings.length > 0).length;
  const latencyValues = cases.map((item) => item.latencyMs);
  const sumLatency = latencyValues.reduce((sum, value) => sum + value, 0);

  const result: EvalRunResult = {
    suite: suite.name,
    description: suite.description,
    caseCount,
    passedCount,
    failedCount,
    degradedCount,
    degradedRate: calcPercent(degradedCount, caseCount),
    schemaValidRate: calcPercent(passedCount, caseCount),
    warningCaseRate: calcPercent(warningCaseCount, caseCount),
    latency: {
      minMs: latencyValues.length > 0 ? Math.min(...latencyValues) : 0,
      avgMs: latencyValues.length > 0 ? Number((sumLatency / latencyValues.length).toFixed(2)) : 0,
      p95Ms: calcP95(latencyValues),
      maxMs: latencyValues.length > 0 ? Math.max(...latencyValues) : 0,
    },
    backends: {
      api: cases.filter((item) => item.backend === 'api').length,
      cli: cases.filter((item) => item.backend === 'cli').length,
    },
    cases,
  };

  if (options.maxDegradedRate !== undefined && result.degradedRate > options.maxDegradedRate) {
    throw new Error(
      `Eval degraded rate ${result.degradedRate}% exceeded threshold ${options.maxDegradedRate}% (${result.degradedCount}/${result.caseCount})`,
    );
  }

  return result;
};
