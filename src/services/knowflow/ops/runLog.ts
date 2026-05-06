import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LlmLogEvent } from '../../../adapters/llm.js';
import type { StructuredLogEvent, StructuredLogLevel, StructuredLogger } from './logger';

const levelWeight: Record<StructuredLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const shouldEmit = (level: StructuredLogLevel, verbose: boolean): boolean => {
  return verbose;
};

export type RunLogEvent = {
  ts: string;
  runId: string;
  event: string;
  data?: Record<string, unknown>;
};

export type RunLogger = {
  runId: string;
  logPath: string;
  log: (event: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
  createStructuredLogger: (options?: { verbose?: boolean }) => StructuredLogger;
  createLlmLogger: (options?: { verbose?: boolean }) => (event: LlmLogEvent) => void;
};

const resolveRunId = (input?: string): string => {
  if (input && input.trim().length > 0) {
    return input.trim();
  }
  return `${new Date().toISOString().replace(/[:.]/g, '')}-${randomUUID().slice(0, 8)}`;
};

export const createRunLogger = async (options: {
  runId?: string;
  logsRootDir?: string;
}): Promise<RunLogger> => {
  const runId = resolveRunId(options.runId);
  const logsRootDir = options.logsRootDir ?? join(process.cwd(), 'logs', 'runs');
  const logPath = join(logsRootDir, `${runId}.jsonl`);
  await mkdir(dirname(logPath), { recursive: true });

  let writeQueue: Promise<void> = Promise.resolve();
  let writeFailed = false;

  const enqueueWrite = (line: string): void => {
    writeQueue = writeQueue
      .then(() => appendFile(logPath, line))
      .catch((error) => {
        if (!writeFailed) {
          writeFailed = true;
          process.stderr.write(
            `run-log write failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      });
  };

  const log = (event: string, data?: Record<string, unknown>): void => {
    const payload: RunLogEvent = {
      ts: new Date().toISOString(),
      runId,
      event,
      data,
    };
    enqueueWrite(`${JSON.stringify(payload)}\n`);
  };

  const createStructuredLogger =
    (loggerOptions?: { verbose?: boolean }): StructuredLogger =>
    (event: StructuredLogEvent): void => {
      const level = event.level ?? 'info';
      log(event.event, {
        kind: 'structured',
        level,
        ...event,
      });

      if (!shouldEmit(level, loggerOptions?.verbose === true)) {
        return;
      }

      const payload = {
        ts: new Date().toISOString(),
        runId,
        ...event,
        level,
      };
      process.stderr.write(`${JSON.stringify(payload)}\n`);
    };

  const createLlmLogger =
    (loggerOptions?: { verbose?: boolean }) =>
    (event: LlmLogEvent): void => {
      const level: StructuredLogLevel =
        event.event === 'llm.task.failed' ||
        event.event === 'llm.task.retry' ||
        event.event === 'llm.task.degraded'
          ? 'warn'
          : 'info';

      log(event.event, {
        kind: 'llm',
        level,
        ...event,
      });

      if (!shouldEmit(level, loggerOptions?.verbose === true)) {
        return;
      }

      const payload = {
        ts: new Date().toISOString(),
        runId,
        level,
        ...event,
      };
      process.stderr.write(`${JSON.stringify(payload)}\n`);
    };

  return {
    runId,
    logPath,
    log,
    flush: async () => {
      await writeQueue;
    },
    createStructuredLogger,
    createLlmLogger,
  };
};
