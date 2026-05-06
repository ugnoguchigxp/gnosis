import { readFile, readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { desc, sql } from 'drizzle-orm';
import { envBoolean } from '../config.js';
import { GNOSIS_CONSTANTS } from '../constants.js';
import { closeDbPool, db } from '../db/index.js';
import { topicTasks } from '../db/schema.js';
import { parseArgMap, readNumberFlag, readStringFlag } from '../services/knowflow/utils/args';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output';
import { EMBEDDING_SYSTEM_TOPIC } from './monitor-queue-utils.js';

type QueueSnapshot = {
  pending: number;
  running: number;
  deferred: number;
  failed: number;
};

type WorkerSnapshot = {
  lastSuccessTs: number | null;
  lastFailureTs: number | null;
  consecutiveFailures: number;
};

type EvalSnapshot = {
  passRate: number;
  passed: number;
  failed: number;
  updatedAtTs: number | null;
};

type AutomationSnapshot = {
  automationGate: boolean;
  backgroundWorkerGate: boolean;
  localLlmConfigured: boolean;
  localLlmApiBaseUrl: string | null;
};

type KnowFlowSnapshot = {
  lastWorkerTs: number | null;
  lastWorkerSummary: string | null;
  lastSeedTs: number | null;
  lastSeedSummary: string | null;
  lastKeywordSeedTs: number | null;
  lastFailureTs: number | null;
  status: 'idle' | 'healthy' | 'degraded' | 'unknown';
};

type TaskIndexEntry = {
  taskId: string;
  topic: string | null;
  source: string | null;
  status: string;
  updatedAtTs: number | null;
};

type QualityGateState = 'passed' | 'failed' | 'unknown';

type QualityGateRecord = {
  status: QualityGateState;
  updatedAtTs: number | null;
  message: string | null;
};

type QualityGateSnapshot = {
  doctor: QualityGateRecord;
  doctorStrict: QualityGateRecord;
  onboardingSmoke: QualityGateRecord;
  smoke: QualityGateRecord;
  verifyFast: QualityGateRecord;
  verify: QualityGateRecord;
  verifyStrict: QualityGateRecord;
  mcpContract: QualityGateRecord;
};

type MonitorSnapshot = {
  ts: number;
  queue: QueueSnapshot;
  embeddingQueue: QueueSnapshot;
  worker: WorkerSnapshot;
  eval: EvalSnapshot;
  automation: AutomationSnapshot;
  knowflow: KnowFlowSnapshot;
  qualityGates: QualityGateSnapshot;
  taskIndex: TaskIndexEntry[];
};

type RunEventRecord = {
  ts?: string;
  event?: string;
  data?: Record<string, unknown>;
};

const MONITORED_QUEUE_STATUSES = ['pending', 'running', 'deferred', 'failed'] as const;
const FALLBACK_FILE_LIMIT = 40;
const FALLBACK_TASK_INDEX_LIMIT = 300;
const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:7888/gnosis';
const QUALITY_GATE_KEYS = [
  'doctor',
  'doctorStrict',
  'onboardingSmoke',
  'smoke',
  'verifyFast',
  'verify',
  'verifyStrict',
  'mcpContract',
] as const;

const emptyQueueSnapshot = (): QueueSnapshot => ({
  pending: 0,
  running: 0,
  deferred: 0,
  failed: 0,
});

const emptyQualityGateRecord = (): QualityGateRecord => ({
  status: 'unknown',
  updatedAtTs: null,
  message: null,
});

const canReachDatabase = async (timeoutMs = 250): Promise<boolean> => {
  let url: URL;
  try {
    url = new URL(process.env.DATABASE_URL || DEFAULT_DATABASE_URL);
  } catch {
    return false;
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return false;
  }

  const host = !url.hostname || url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
  const port = Number(url.port || 5432);
  if (!Number.isFinite(port)) {
    return false;
  }

  return await new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
};

const toTimestampMs = (raw: unknown): number | null => {
  if (typeof raw !== 'string') {
    return null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const toStringValue = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isKnowFlowTaskType = (taskType: string | null): boolean => {
  return taskType === 'knowflow' || taskType?.startsWith('knowflow_') === true;
};

const parseRunEventRecord = (line: string): RunEventRecord | null => {
  if (line.trim().length === 0) {
    return null;
  }

  try {
    const payload = JSON.parse(line);
    if (!isRecord(payload)) {
      return null;
    }

    const data = isRecord(payload.data) ? payload.data : undefined;
    return {
      ts: typeof payload.ts === 'string' ? payload.ts : undefined,
      event: typeof payload.event === 'string' ? payload.event : undefined,
      data,
    };
  } catch {
    return null;
  }
};

const listRecentRunLogs = async (logsRoot: string, limit: number): Promise<string[]> => {
  try {
    const entries = await readdir(logsRoot, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => join(logsRoot, entry.name));

    const withMtime = await Promise.all(
      files.map(async (filePath) => {
        const stat = await Bun.file(filePath).stat();
        return {
          filePath,
          mtimeMs: stat.mtimeMs,
        };
      }),
    );

    return withMtime
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map((item) => item.filePath);
  } catch {
    return [];
  }
};

const countQueueStatuses = async (): Promise<{
  queue: QueueSnapshot;
  embeddingQueue: QueueSnapshot;
}> => {
  const queue = emptyQueueSnapshot();
  const embeddingQueue = emptyQueueSnapshot();

  let rows: Array<{ status?: unknown; is_embedding?: unknown; count?: unknown }>;
  try {
    const result = await db.execute(
      sql.raw(`
        SELECT
          status,
          (
            (payload ->> 'topic') = '${EMBEDDING_SYSTEM_TOPIC}'
            OR (payload -> 'metadata' -> 'systemTask' ->> 'type') = 'embedding_batch'
          ) AS is_embedding,
          count(*)::int AS count
        FROM topic_tasks
        WHERE status IN ('pending', 'running', 'deferred', 'failed')
        GROUP BY status, is_embedding
      `),
    );
    rows = result.rows as Array<{ status?: unknown; is_embedding?: unknown; count?: unknown }>;
  } catch {
    return { queue, embeddingQueue };
  }

  const parseBoolean = (value: unknown): boolean => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value > 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === 't' || normalized === '1';
    }
    return false;
  };

  for (const row of rows) {
    const status = typeof row.status === 'string' ? row.status : null;
    if (!status) {
      continue;
    }
    const target = parseBoolean(row.is_embedding) ? embeddingQueue : queue;
    const count = toNumber(row.count) ?? 0;
    if (status === 'pending') {
      target.pending = count;
    }
    if (status === 'running') {
      target.running = count;
    }
    if (status === 'deferred') {
      target.deferred = count;
    }
    if (status === 'failed') {
      target.failed = count;
    }
  }

  return { queue, embeddingQueue };
};

const collectTaskIndex = async (limit: number): Promise<TaskIndexEntry[]> => {
  let rows: Array<{
    id: string;
    status: string;
    payload: unknown;
    updatedAt: Date | string | null;
  }>;
  try {
    rows = await db
      .select({
        id: topicTasks.id,
        status: topicTasks.status,
        payload: topicTasks.payload,
        updatedAt: topicTasks.updatedAt,
      })
      .from(topicTasks)
      .orderBy(desc(topicTasks.updatedAt))
      .limit(Math.max(1, limit));
  } catch {
    return [];
  }

  return rows.map((row) => {
    const payload = isRecord(row.payload) ? row.payload : {};
    return {
      taskId: row.id,
      topic: typeof payload.topic === 'string' ? payload.topic : null,
      source: typeof payload.source === 'string' ? payload.source : null,
      status: row.status,
      updatedAtTs:
        row.updatedAt instanceof Date && Number.isFinite(row.updatedAt.getTime())
          ? row.updatedAt.getTime()
          : null,
    };
  });
};

export const collectWorkerEvalAndKnowFlow = async (
  logsRoot: string,
  fileLimit: number,
): Promise<{
  worker: WorkerSnapshot;
  evalResult: EvalSnapshot;
  knowflow: KnowFlowSnapshot;
}> => {
  const worker: WorkerSnapshot = {
    lastSuccessTs: null,
    lastFailureTs: null,
    consecutiveFailures: 0,
  };

  const evalResult: EvalSnapshot = {
    passRate: 0,
    passed: 0,
    failed: 0,
    updatedAtTs: null,
  };

  const knowflow: KnowFlowSnapshot = {
    lastWorkerTs: null,
    lastWorkerSummary: null,
    lastSeedTs: null,
    lastSeedSummary: null,
    lastKeywordSeedTs: null,
    lastFailureTs: null,
    status: 'unknown',
  };

  const files = await listRecentRunLogs(logsRoot, fileLimit);
  let consecutiveCounterDone = false;
  let evalFound = false;

  for (const filePath of files) {
    const raw = await readFile(filePath, 'utf-8');
    const lines = raw.split('\n').reverse();

    for (const line of lines) {
      const record = parseRunEventRecord(line);
      if (!record?.event) {
        continue;
      }

      const ts = toTimestampMs(record.ts);

      if (record.event === 'task.done') {
        if (worker.lastSuccessTs === null && ts !== null) {
          worker.lastSuccessTs = ts;
        }
        if (knowflow.lastWorkerTs === null && ts !== null) {
          knowflow.lastWorkerTs = ts;
          knowflow.lastWorkerSummary =
            toStringValue(record.data?.summary) ?? toStringValue(record.data?.resultSummary);
        }
        if (!consecutiveCounterDone) {
          consecutiveCounterDone = true;
        }
      }

      if (record.event === 'task.failed' || record.event === 'task.deferred') {
        if (worker.lastFailureTs === null && ts !== null) {
          worker.lastFailureTs = ts;
        }
        if (knowflow.lastFailureTs === null && ts !== null) {
          knowflow.lastFailureTs = ts;
        }
        if (!consecutiveCounterDone) {
          worker.consecutiveFailures += 1;
        }
      }

      if (
        (record.event === 'background.task.completed' ||
          record.event === 'background.task.failed') &&
        record.data
      ) {
        const taskType = toStringValue(record.data.taskType);
        const isKnowFlowBackgroundTask = isKnowFlowTaskType(taskType);
        if (
          record.event === 'background.task.failed' &&
          isKnowFlowBackgroundTask &&
          knowflow.lastFailureTs === null &&
          ts !== null
        ) {
          knowflow.lastFailureTs = ts;
        }

        if (
          isKnowFlowBackgroundTask &&
          taskType === 'knowflow' &&
          knowflow.lastWorkerTs === null &&
          ts !== null
        ) {
          knowflow.lastWorkerTs = ts;
          knowflow.lastWorkerSummary = toStringValue(record.data.summary);
        }

        if (taskType === 'knowflow_keyword_seed' && knowflow.lastSeedTs === null && ts !== null) {
          knowflow.lastSeedTs = ts;
          knowflow.lastSeedSummary = toStringValue(record.data.summary);
        }

        if (
          taskType === 'knowflow_keyword_seed' &&
          knowflow.lastKeywordSeedTs === null &&
          ts !== null
        ) {
          knowflow.lastKeywordSeedTs = ts;
        }
      }

      if (record.event === 'knowflow.phrase_scout.completed' && record.data) {
        if (knowflow.lastSeedTs === null && ts !== null) {
          knowflow.lastSeedTs = ts;
          knowflow.lastSeedSummary = `phrase scout: sources=${
            toNumber(record.data.sources) ?? 0
          } phrases=${toNumber(record.data.phrases) ?? 0} enqueued=${
            toNumber(record.data.enqueued) ?? 0
          }`;
        }
        if (knowflow.lastKeywordSeedTs === null && ts !== null) {
          knowflow.lastKeywordSeedTs = ts;
        }
      }

      if (record.event === 'cli.result' && record.data?.command === 'seed-phrases') {
        if (knowflow.lastSeedTs === null && ts !== null) {
          knowflow.lastSeedTs = ts;
          knowflow.lastSeedSummary = 'manual seed-phrases run';
        }
      }

      if (!evalFound && record.event === 'cli.result' && record.data) {
        if (record.data.command === 'eval-run' && isRecord(record.data.result)) {
          const result = record.data.result;
          const passRate = toNumber(result.passRate);
          const passedCount = toNumber(result.passedCount);
          const failedCount = toNumber(result.failedCount);
          evalResult.passed = passedCount ?? 0;
          evalResult.failed = failedCount ?? 0;
          const total = evalResult.passed + evalResult.failed;
          evalResult.passRate =
            passRate ?? (total > 0 ? Number(((evalResult.passed / total) * 100).toFixed(2)) : 0);
          evalResult.updatedAtTs = ts;
          evalFound = true;
        }
      }

      const hasWorkerSnapshot = worker.lastSuccessTs !== null && worker.lastFailureTs !== null;
      const hasKnowFlowSeedSnapshot =
        knowflow.lastSeedTs !== null || knowflow.lastKeywordSeedTs !== null;
      if (hasWorkerSnapshot && consecutiveCounterDone && evalFound && hasKnowFlowSeedSnapshot) {
        break;
      }
    }

    const hasWorkerSnapshot = worker.lastSuccessTs !== null && worker.lastFailureTs !== null;
    const hasKnowFlowSeedSnapshot =
      knowflow.lastSeedTs !== null || knowflow.lastKeywordSeedTs !== null;
    if (hasWorkerSnapshot && consecutiveCounterDone && evalFound && hasKnowFlowSeedSnapshot) {
      break;
    }
  }

  if (
    knowflow.lastFailureTs !== null &&
    knowflow.lastWorkerTs === null &&
    knowflow.lastSeedTs === null
  ) {
    knowflow.status = 'degraded';
  } else if (knowflow.lastWorkerTs !== null || knowflow.lastSeedTs !== null) {
    knowflow.status =
      knowflow.lastFailureTs !== null &&
      Math.max(knowflow.lastWorkerTs ?? 0, knowflow.lastSeedTs ?? 0) < knowflow.lastFailureTs
        ? 'degraded'
        : 'healthy';
  } else {
    knowflow.status = 'idle';
  }

  return {
    worker,
    evalResult,
    knowflow,
  };
};

const collectAutomation = (): AutomationSnapshot => ({
  automationGate: envBoolean(
    process.env.GNOSIS_ENABLE_AUTOMATION,
    GNOSIS_CONSTANTS.AUTOMATION_ENABLED_DEFAULT,
  ),
  backgroundWorkerGate: envBoolean(
    process.env.GNOSIS_BACKGROUND_WORKER_ENABLED,
    GNOSIS_CONSTANTS.BACKGROUND_WORKER_ENABLED_DEFAULT,
  ),
  localLlmConfigured: Boolean(process.env.LOCAL_LLM_API_BASE_URL?.trim()),
  localLlmApiBaseUrl: process.env.LOCAL_LLM_API_BASE_URL?.trim() || null,
});

const collectQualityGates = async (rootDir: string): Promise<QualityGateSnapshot> => {
  const snapshot = Object.fromEntries(
    QUALITY_GATE_KEYS.map((key) => [key, emptyQualityGateRecord()]),
  ) as QualityGateSnapshot;
  const filePath = join(rootDir, 'logs', 'quality-gates.json');

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf-8'));
  } catch {
    return snapshot;
  }

  if (!isRecord(parsed)) {
    return snapshot;
  }

  for (const key of QUALITY_GATE_KEYS) {
    const record = parsed[key];
    if (!isRecord(record)) continue;
    const status =
      record.status === 'passed' || record.status === 'failed' || record.status === 'unknown'
        ? record.status
        : 'unknown';
    snapshot[key] = {
      status,
      updatedAtTs: toTimestampMs(record.updatedAt),
      message: toStringValue(record.message),
    };
  }

  return snapshot;
};

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);
  const logsRootArg = readStringFlag(args, 'logs-root');
  const rootDir = process.cwd();
  const logsRoot = logsRootArg ? resolve(logsRootArg) : resolve(rootDir, 'logs', 'runs');
  const fileLimit = readNumberFlag(args, 'file-limit') ?? FALLBACK_FILE_LIMIT;
  const taskIndexLimit = readNumberFlag(args, 'task-index-limit') ?? FALLBACK_TASK_INDEX_LIMIT;

  const databaseReachable = await canReachDatabase();
  const { queue, embeddingQueue } = databaseReachable
    ? await countQueueStatuses()
    : { queue: emptyQueueSnapshot(), embeddingQueue: emptyQueueSnapshot() };
  const { worker, evalResult, knowflow } = await collectWorkerEvalAndKnowFlow(
    logsRoot,
    Math.max(1, fileLimit),
  );
  const taskIndex = databaseReachable ? await collectTaskIndex(taskIndexLimit) : [];

  const payload: MonitorSnapshot = {
    ts: Date.now(),
    queue,
    embeddingQueue,
    worker,
    eval: evalResult,
    automation: collectAutomation(),
    knowflow,
    qualityGates: await collectQualityGates(rootDir),
    taskIndex,
  };

  process.stdout.write(renderOutput(payload, outputFormat));
};

if (import.meta.main) {
  run()
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDbPool();
    });
}
