import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { topicTasks } from '../db/schema.js';
import { parseArgMap, readNumberFlag, readStringFlag } from '../services/knowflow/utils/args';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output';

type DetailLogSnippet = {
  ts: number;
  kind: string;
  runId: string | null;
  taskId: string | null;
  summary: string | null;
  error: string | null;
  message: string | null;
};

type TaskDetailPayload = {
  taskId: string;
  runId: string | null;
  topic: string | null;
  source: string | null;
  status: string | null;
  resultSummary: string | null;
  errorReason: string | null;
  logs: DetailLogSnippet[];
};

type RawRunEvent = {
  ts?: string;
  runId?: string;
  event?: string;
  data?: Record<string, unknown>;
};

const FALLBACK_FILE_LIMIT = 50;
const FALLBACK_SNIPPET_LIMIT = 30;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const toTimestampMs = (raw: unknown): number | null => {
  if (typeof raw !== 'string') return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseRunEvent = (line: string): RawRunEvent | null => {
  if (line.trim().length === 0) return null;

  try {
    const payload = JSON.parse(line);
    if (!isRecord(payload)) return null;

    return {
      ts: typeof payload.ts === 'string' ? payload.ts : undefined,
      runId: typeof payload.runId === 'string' ? payload.runId : undefined,
      event: typeof payload.event === 'string' ? payload.event : undefined,
      data: isRecord(payload.data) ? payload.data : undefined,
    };
  } catch {
    return null;
  }
};

export const isTaskLogMatch = (data: Record<string, unknown>, taskId: string): boolean => {
  return typeof data.taskId === 'string' && data.taskId === taskId;
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

const collectLogSnippets = async (options: {
  taskId: string;
  logsRoot: string;
  fileLimit: number;
  snippetLimit: number;
}): Promise<DetailLogSnippet[]> => {
  const files = await listRecentRunLogs(options.logsRoot, options.fileLimit);
  const snippets: DetailLogSnippet[] = [];

  for (const filePath of files) {
    const raw = await readFile(filePath, 'utf-8');
    const lines = raw.split('\n').reverse();

    for (const line of lines) {
      const record = parseRunEvent(line);
      if (!record?.event) continue;

      const data = record.data ?? {};
      const taskId = typeof data.taskId === 'string' ? data.taskId : null;
      const recordRunId = record.runId ?? null;

      if (!isTaskLogMatch(data, options.taskId)) {
        continue;
      }

      snippets.push({
        ts: toTimestampMs(record.ts) ?? Date.now(),
        kind: record.event,
        runId: recordRunId,
        taskId,
        summary:
          typeof data.summary === 'string'
            ? data.summary
            : typeof data.resultSummary === 'string'
              ? data.resultSummary
              : null,
        error:
          typeof data.error === 'string'
            ? data.error
            : typeof data.errorReason === 'string'
              ? data.errorReason
              : null,
        message: typeof data.message === 'string' ? data.message : null,
      });

      if (snippets.length >= options.snippetLimit) {
        return snippets.sort((a, b) => b.ts - a.ts);
      }
    }
  }

  return snippets.sort((a, b) => b.ts - a.ts);
};

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);

  const taskId = readStringFlag(args, 'task-id');
  if (!taskId) {
    throw new Error('--task-id is required');
  }

  const logsRootArg = readStringFlag(args, 'logs-root');
  const logsRoot = logsRootArg ? resolve(logsRootArg) : resolve(process.cwd(), 'logs', 'runs');
  const fileLimit = readNumberFlag(args, 'file-limit') ?? FALLBACK_FILE_LIMIT;
  const snippetLimit = readNumberFlag(args, 'snippet-limit') ?? FALLBACK_SNIPPET_LIMIT;

  const rows = await db
    .select({
      id: topicTasks.id,
      status: topicTasks.status,
      payload: topicTasks.payload,
    })
    .from(topicTasks)
    .where(eq(topicTasks.id, taskId))
    .orderBy(desc(topicTasks.updatedAt))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`task not found: ${taskId}`);
  }

  const row = rows[0];
  const payload = isRecord(row.payload) ? row.payload : {};

  const resultSummary =
    typeof payload.resultSummary === 'string'
      ? payload.resultSummary
      : typeof payload.summary === 'string'
        ? payload.summary
        : null;

  const errorReason =
    typeof payload.errorReason === 'string'
      ? payload.errorReason
      : typeof payload.error === 'string'
        ? payload.error
        : null;

  const logs = await collectLogSnippets({
    taskId,
    logsRoot,
    fileLimit: Math.max(1, fileLimit),
    snippetLimit: Math.max(1, snippetLimit),
  });

  const latestRunId = logs.find((item) => item.runId)?.runId ?? null;

  const detail: TaskDetailPayload = {
    taskId,
    runId: latestRunId ?? null,
    topic: typeof payload.topic === 'string' ? payload.topic : null,
    source: typeof payload.source === 'string' ? payload.source : null,
    status: row.status,
    resultSummary,
    errorReason,
    logs,
  };

  process.stdout.write(renderOutput(detail, outputFormat));
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
