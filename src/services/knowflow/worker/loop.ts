import { setTimeout as sleep } from 'node:timers/promises';
import type { TopicTask } from '../domain/task';
import { type StructuredLogger, defaultStructuredLogger } from '../ops/logger';
import type { QueueRepository } from '../queue/repository';
import { decideFailureAction } from '../scheduler/policy';

export type TaskExecutionResult =
  | {
      ok: true;
      summary?: string;
    }
  | {
      ok: false;
      error: string;
    };

export type TaskHandler = (task: TopicTask) => Promise<TaskExecutionResult>;

export type WorkerOptions = {
  workerId?: string;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  logger?: StructuredLogger;
};

export type RunOnceResult =
  | {
      processed: false;
    }
  | {
      processed: true;
      taskId: string;
      status: 'done' | 'deferred' | 'failed';
    };

export const defaultTaskHandler: TaskHandler = async (task) => ({
  ok: true,
  summary: `Processed topic=${task.topic}`,
});

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

  try {
    const result = await handler(task);
    if (result.ok) {
      await repository.markDone(task.id, result.summary, options.now?.() ?? Date.now());
      logger({
        event: 'task.done',
        workerId,
        taskId: task.id,
        summary: result.summary,
        level: 'info',
      });
      return { processed: true, taskId: task.id, status: 'done' };
    }

    const action = decideFailureAction(task, result.error, {
      now: options.now?.() ?? Date.now(),
      maxAttempts: options.maxAttempts,
      baseBackoffMs: options.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
    });
    await repository.applyFailureAction(task.id, action, options.now?.() ?? Date.now());
    logger({
      event: action.kind === 'fail' ? 'task.failed' : 'task.deferred',
      workerId,
      taskId: task.id,
      error: result.error,
      attempts: action.attempts,
      nextRunAt: action.kind === 'defer' ? action.nextRunAt : undefined,
      level: action.kind === 'fail' ? 'error' : 'warn',
    });
    return {
      processed: true,
      taskId: task.id,
      status: action.kind === 'fail' ? 'failed' : 'deferred',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const action = decideFailureAction(task, message, {
      now: options.now?.() ?? Date.now(),
      maxAttempts: options.maxAttempts,
      baseBackoffMs: options.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
    });
    await repository.applyFailureAction(task.id, action, options.now?.() ?? Date.now());
    logger({
      event: action.kind === 'fail' ? 'task.failed' : 'task.deferred',
      workerId,
      taskId: task.id,
      error: message,
      attempts: action.attempts,
      nextRunAt: action.kind === 'defer' ? action.nextRunAt : undefined,
      level: action.kind === 'fail' ? 'error' : 'warn',
    });
    return {
      processed: true,
      taskId: task.id,
      status: action.kind === 'fail' ? 'failed' : 'deferred',
    };
  }
};

export const runWorkerLoop = async (
  repository: QueueRepository,
  handler: TaskHandler = defaultTaskHandler,
  options: WorkerOptions & {
    intervalMs?: number;
    maxIterations?: number;
  } = {},
): Promise<void> => {
  const intervalMs = options.intervalMs ?? 1_000;
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;

  let iteration = 0;
  while (iteration < maxIterations) {
    iteration += 1;
    const result = await runWorkerOnce(repository, handler, options);
    if (!result.processed) {
      await sleep(intervalMs);
    }
  }
};
