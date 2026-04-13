import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { desc, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { topicTasks } from '../db/schema.js';
import { parseArgMap, readNumberFlag, readStringFlag } from '../services/knowflow/utils/args';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output';

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
  degradedRate: number;
  passed: number;
  failed: number;
  updatedAtTs: number | null;
};

type TaskIndexEntry = {
  taskId: string;
  topic: string | null;
  source: string | null;
  status: string;
  updatedAtTs: number | null;
};

type MonitorSnapshot = {
  ts: number;
  queue: QueueSnapshot;
  worker: WorkerSnapshot;
  eval: EvalSnapshot;
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

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

const countQueueStatuses = async (): Promise<QueueSnapshot> => {
  const initial: QueueSnapshot = {
    pending: 0,
    running: 0,
    deferred: 0,
    failed: 0,
  };

  const rows = await db
    .select({
      status: topicTasks.status,
      count: sql<number>`count(*)::int`,
    })
    .from(topicTasks)
    .where(inArray(topicTasks.status, [...MONITORED_QUEUE_STATUSES]))
    .groupBy(topicTasks.status)
    .orderBy(desc(topicTasks.status));

  for (const row of rows) {
    if (row.status === 'pending') {
      initial.pending = row.count;
    }
    if (row.status === 'running') {
      initial.running = row.count;
    }
    if (row.status === 'deferred') {
      initial.deferred = row.count;
    }
    if (row.status === 'failed') {
      initial.failed = row.count;
    }
  }

  return initial;
};

const collectTaskIndex = async (limit: number): Promise<TaskIndexEntry[]> => {
  const rows = await db
    .select({
      id: topicTasks.id,
      status: topicTasks.status,
      payload: topicTasks.payload,
      updatedAt: topicTasks.updatedAt,
    })
    .from(topicTasks)
    .orderBy(desc(topicTasks.updatedAt))
    .limit(Math.max(1, limit));

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

const collectWorkerAndEval = async (
  logsRoot: string,
  fileLimit: number,
): Promise<{ worker: WorkerSnapshot; evalResult: EvalSnapshot }> => {
  const worker: WorkerSnapshot = {
    lastSuccessTs: null,
    lastFailureTs: null,
    consecutiveFailures: 0,
  };

  const evalResult: EvalSnapshot = {
    degradedRate: 0,
    passed: 0,
    failed: 0,
    updatedAtTs: null,
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
        if (!consecutiveCounterDone) {
          consecutiveCounterDone = true;
        }
      }

      if (record.event === 'task.failed' || record.event === 'task.deferred') {
        if (worker.lastFailureTs === null && ts !== null) {
          worker.lastFailureTs = ts;
        }
        if (!consecutiveCounterDone) {
          worker.consecutiveFailures += 1;
        }
      }

      if (!evalFound && record.event === 'cli.result' && record.data) {
        if (record.data.command === 'eval-run' && isRecord(record.data.result)) {
          const result = record.data.result;
          const degradedRate = toNumber(result.degradedRate);
          const passedCount = toNumber(result.passedCount);
          const failedCount = toNumber(result.failedCount);
          evalResult.degradedRate = degradedRate ?? 0;
          evalResult.passed = passedCount ?? 0;
          evalResult.failed = failedCount ?? 0;
          evalResult.updatedAtTs = ts;
          evalFound = true;
        }
      }

      const hasWorkerSnapshot = worker.lastSuccessTs !== null && worker.lastFailureTs !== null;
      if (hasWorkerSnapshot && consecutiveCounterDone && evalFound) {
        break;
      }
    }

    const hasWorkerSnapshot = worker.lastSuccessTs !== null && worker.lastFailureTs !== null;
    if (hasWorkerSnapshot && consecutiveCounterDone && evalFound) {
      break;
    }
  }

  return {
    worker,
    evalResult,
  };
};

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);
  const logsRootArg = readStringFlag(args, 'logs-root');
  const logsRoot = logsRootArg ? resolve(logsRootArg) : resolve(process.cwd(), 'logs', 'runs');
  const fileLimit = readNumberFlag(args, 'file-limit') ?? FALLBACK_FILE_LIMIT;
  const taskIndexLimit = readNumberFlag(args, 'task-index-limit') ?? FALLBACK_TASK_INDEX_LIMIT;

  const queue = await countQueueStatuses();
  const { worker, evalResult } = await collectWorkerAndEval(logsRoot, Math.max(1, fileLimit));
  const taskIndex = await collectTaskIndex(taskIndexLimit);

  const payload: MonitorSnapshot = {
    ts: Date.now(),
    queue,
    worker,
    eval: evalResult,
    taskIndex,
  };

  process.stdout.write(renderOutput(payload, outputFormat));
};

if (import.meta.main) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
