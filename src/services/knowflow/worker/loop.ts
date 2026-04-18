import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../../../config.js';
import type { TopicTask } from '../domain/task';
import { type StructuredLogger, defaultStructuredLogger } from '../ops/logger';
import type { QueueRepository } from '../queue/repository';
import { decideFailureAction } from '../scheduler/policy';

const CIRCUIT_BREAKER_BACKOFF_MULTIPLIER = 10;
const CRITICAL_ERROR_BACKOFF_MULTIPLIER = 2;

export type TaskExecutionResult =
  | {
      ok: true;
      summary?: string;
    }
  | {
      ok: false;
      error: string;
      retryable?: boolean;
    };

export type TaskHandler = (task: TopicTask, signal?: AbortSignal) => Promise<TaskExecutionResult>;

export type WorkerOptions = {
  workerId?: string;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  taskTimeoutMs?: number;
  now?: () => number;
  logger?: StructuredLogger;
  sleep?: (ms: number) => Promise<void>;
  createTaskTimeout?: (
    timeoutMs: number,
    abortController: AbortController,
  ) => {
    promise: Promise<TaskExecutionResult>;
    cancel: () => void;
  };
};

export type RunOnceResult =
  | {
      processed: false;
    }
  | {
      processed: true;
      taskId: string;
      status: 'done' | 'deferred' | 'failed';
      error?: string;
    };

export const defaultTaskHandler: TaskHandler = async (task) => ({
  ok: true,
  summary: `Processed topic=${task.topic}`,
});

function createTaskTimeout(
  timeoutMs: number,
  abortController: AbortController,
): {
  promise: Promise<TaskExecutionResult>;
  cancel: () => void;
} {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return {
    promise: new Promise<TaskExecutionResult>((resolve) => {
      timeoutId = setTimeout(() => {
        abortController.abort();
        resolve({ ok: false, error: `Task execution timed out after ${timeoutMs}ms` });
      }, timeoutMs);
    }),
    cancel: () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    },
  };
}

export const runWorkerOnce = async (
  repository: QueueRepository,
  handler: TaskHandler = defaultTaskHandler,
  options: WorkerOptions = {},
): Promise<RunOnceResult> => {
  const workerId = options.workerId ?? `worker-${process.pid}`;
  const logger = options.logger ?? defaultStructuredLogger;
  const now = options.now?.() ?? Date.now();
  const task = await repository.dequeueAndLock(workerId, now);

  if (!task) {
    logger({
      event: 'task.dequeue.empty',
      workerId,
      level: 'debug',
    });
    return { processed: false };
  }

  logger({
    event: 'task.dequeue.locked',
    workerId,
    taskId: task.id,
    topic: task.topic,
    source: task.source,
    attempts: task.attempts,
    level: 'info',
  });

  const abortController = new AbortController();
  const timeoutMs = options.taskTimeoutMs ?? config.knowflow.worker.taskTimeoutMs;
  const timeoutController = (options.createTaskTimeout ?? createTaskTimeout)(
    timeoutMs,
    abortController,
  );

  const handleResult = async (result: TaskExecutionResult) => {
    const currentNow = options.now?.() ?? Date.now();

    if (result.ok) {
      await repository.markDone(task.id, result.summary, currentNow);
      logger({
        event: 'task.done',
        workerId,
        taskId: task.id,
        summary: result.summary,
        level: 'info',
      });
      return { processed: true, taskId: task.id, status: 'done' as const };
    }

    const error = result.error;
    const action = decideFailureAction(task, error, {
      now: currentNow,
      maxAttempts: options.maxAttempts,
      baseBackoffMs: options.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
    });

    await repository.applyFailureAction(task.id, action, currentNow);
    logger({
      event: action.kind === 'fail' ? 'task.failed' : 'task.deferred',
      workerId,
      taskId: task.id,
      error,
      attempts: action.attempts,
      nextRunAt: action.kind === 'defer' ? action.nextRunAt : undefined,
      level: action.kind === 'fail' ? 'error' : 'warn',
    });

    return {
      processed: true,
      taskId: task.id,
      status: action.kind === 'fail' ? ('failed' as const) : ('deferred' as const),
      error,
    };
  };

  try {
    const result = await Promise.race([
      handler(task, abortController.signal),
      timeoutController.promise,
    ]);
    timeoutController.cancel();
    return await handleResult(result);
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);

    return await handleResult({ ok: false, error: message });
  } finally {
    timeoutController.cancel();
    abortController.abort();
  }
};

export type LoopOptions = WorkerOptions & {
  intervalMs?: number;
  postTaskDelayMs?: number;
  maxIterations?: number;
  maxConsecutiveErrors?: number;
  /** runWorkerOnce の実行をラップする関数 (セマフォ取得などに利用可能) */
  runOnceWrapper?: (fn: () => Promise<RunOnceResult>) => Promise<RunOnceResult>;
};

export const runWorkerLoop = async (
  repository: QueueRepository,
  handler: TaskHandler = defaultTaskHandler,
  options: LoopOptions = {},
): Promise<void> => {
  const intervalMs = options.intervalMs ?? config.knowflow.worker.pollIntervalMs;
  const postTaskDelayMs = options.postTaskDelayMs ?? config.knowflow.worker.postTaskDelayMs;
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
  const maxConsecutiveErrors =
    options.maxConsecutiveErrors ?? config.knowflow.worker.maxConsecutiveErrors;
  const logger = options.logger ?? defaultStructuredLogger;
  const runOnceWrapper = options.runOnceWrapper ?? ((fn) => fn());
  const sleepFn = options.sleep ?? sleep;

  let iteration = 0;
  let consecutiveErrors = 0;

  while (iteration < maxIterations) {
    iteration += 1;

    try {
      const result = await runOnceWrapper(() => runWorkerOnce(repository, handler, options));

      if (!result.processed) {
        await sleepFn(intervalMs);
        continue;
      }

      // タスク処理後のクールダウン (負荷集中回避)
      await sleepFn(postTaskDelayMs);

      if (result.status === 'done') {
        consecutiveErrors = 0;
      } else {
        consecutiveErrors += 1;
        if (consecutiveErrors >= maxConsecutiveErrors) {
          logger({
            event: 'worker.loop.circuit_break',
            consecutiveErrors,
            message: `Circuit breaker triggered after ${consecutiveErrors} consecutive errors. Sleeping longer.`,
            level: 'error',
          });
          await sleepFn(intervalMs * CIRCUIT_BREAKER_BACKOFF_MULTIPLIER);
          consecutiveErrors = 0;
        }
      }
    } catch (criticalError) {
      const msg = criticalError instanceof Error ? criticalError.message : String(criticalError);
      logger({
        event: 'worker.loop.critical_error',
        message: msg,
        level: 'error',
      });
      await sleepFn(intervalMs * CRITICAL_ERROR_BACKOFF_MULTIPLIER);
    }
  }
};
