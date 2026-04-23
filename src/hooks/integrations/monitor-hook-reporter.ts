import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

type HookMonitorEvent = {
  event: string;
  traceId: string;
  runId?: string;
  taskId?: string;
  ruleId?: string;
  gateName?: string;
  riskTags?: string[];
  candidateIds?: string[];
  resultSummary?: string;
  errorReason?: string;
  message?: string;
  payload?: Record<string, unknown>;
};

const LOGS_ROOT = path.resolve(process.cwd(), 'logs', 'runs');
let writeQueue: Promise<void> = Promise.resolve();

function resolveLogFilePath(): string {
  const datePart = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_ROOT, `hooks-${datePart}.jsonl`);
}

export async function emitHookMonitorEvent(input: HookMonitorEvent): Promise<void> {
  const logPath = resolveLogFilePath();
  await mkdir(path.dirname(logPath), { recursive: true });

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    runId: input.runId ?? input.traceId,
    event: input.event,
    data: {
      traceId: input.traceId,
      taskId: input.taskId,
      ruleId: input.ruleId,
      gateName: input.gateName,
      riskTags: input.riskTags ?? [],
      candidateIds: input.candidateIds ?? [],
      resultSummary: input.resultSummary,
      errorReason: input.errorReason,
      message: input.message,
      ...input.payload,
    },
  });

  writeQueue = writeQueue.then(() => appendFile(logPath, `${line}\n`));
  await writeQueue;
}
