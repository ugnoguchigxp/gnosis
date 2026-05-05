import type { TopicTask } from '../domain/task';

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_BACKOFF_MS = 30_000;
export const DEFAULT_MAX_BACKOFF_MS = 30 * 60_000;
export const DEFAULT_BACKOFF_JITTER_RATIO = 0.2;

export type FailureAction =
  | {
      kind: 'defer';
      attempts: number;
      errorReason: string;
      nextRunAt: number;
    }
  | {
      kind: 'fail';
      attempts: number;
      errorReason: string;
    };

export const computeBackoffMs = (
  attempts: number,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
): number => {
  const exponent = Math.max(0, attempts - 1);
  const backoff = baseBackoffMs * 2 ** exponent;
  return Math.min(backoff, maxBackoffMs);
};

export const computeBackoffWithJitterMs = (
  backoffMs: number,
  jitterRatio = DEFAULT_BACKOFF_JITTER_RATIO,
  random: () => number = Math.random,
): number => {
  const ratio = Math.max(0, Math.min(1, jitterRatio));
  if (ratio === 0) return Math.max(0, Math.round(backoffMs));

  const spread = backoffMs * ratio;
  const lower = Math.max(0, backoffMs - spread);
  const upper = backoffMs + spread;
  return Math.round(lower + (upper - lower) * random());
};

export const decideFailureAction = (
  task: TopicTask,
  errorReason: string,
  options?: {
    now?: number;
    maxAttempts?: number;
    retryable?: boolean;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    jitterRatio?: number;
    random?: () => number;
  },
): FailureAction => {
  const now = options?.now ?? Date.now();
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const attempts = task.attempts + 1;
  const retryable = options?.retryable ?? true;

  if (!retryable || attempts >= maxAttempts) {
    return {
      kind: 'fail',
      attempts,
      errorReason,
    };
  }

  return {
    kind: 'defer',
    attempts,
    errorReason,
    // Single-thread queue policy: retry immediately and let priority order decide execution.
    nextRunAt: now,
  };
};

export const compareTaskPriority = (a: TopicTask, b: TopicTask): number => {
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }
  return a.createdAt - b.createdAt;
};

export const isRunnable = (task: TopicTask, now = Date.now()): boolean => {
  if (task.status === 'pending') {
    return true;
  }

  if (task.status === 'deferred') {
    return (task.nextRunAt ?? 0) <= now;
  }

  return false;
};
