import type { StructuredLogger } from './logger';

export type WorkerRunResultLike =
  | {
      processed: false;
    }
  | {
      processed: true;
      status: 'done' | 'deferred' | 'failed';
      error?: string;
    };

type RunSample = {
  at: number;
  processed: boolean;
  status?: 'done' | 'deferred' | 'failed';
  taskTimeout: boolean;
};

type LockWaitSample = {
  at: number;
  waitMs: number;
  timedOut: boolean;
};

export type WorkerRuntimeSnapshot = {
  generatedAt: number;
  windowMs: number;
  totals: {
    iterations: number;
    processed: number;
    idle: number;
    done: number;
    deferred: number;
    failed: number;
    taskTimeouts: number;
    lockTimeouts: number;
  };
  lockWait: {
    samples: number;
    avgMs: number;
    p95Ms: number;
    maxMs: number;
  };
};

export type WorkerRuntimeMonitorOptions = {
  windowMs: number;
  reportIntervalMs: number;
  taskTimeoutAlertThreshold: number;
  lockTimeoutAlertThreshold: number;
  logger: StructuredLogger;
  now?: () => number;
};

const clampRatio = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const percentile = (values: number[], ratio: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
};

export const isTaskTimeoutError = (message?: string): boolean => {
  if (!message) return false;
  return /\btimeout\b|timed out/i.test(message);
};

export class WorkerRuntimeMonitor {
  private readonly runSamples: RunSample[] = [];
  private readonly lockSamples: LockWaitSample[] = [];
  private readonly options: WorkerRuntimeMonitorOptions;
  private nextReportAt: number;
  private lastTaskTimeoutAlertAt = 0;
  private lastLockTimeoutAlertAt = 0;

  constructor(options: WorkerRuntimeMonitorOptions) {
    this.options = {
      ...options,
      windowMs: Math.max(1_000, Math.trunc(options.windowMs)),
      reportIntervalMs: Math.max(1_000, Math.trunc(options.reportIntervalMs)),
      taskTimeoutAlertThreshold: Math.max(1, Math.trunc(options.taskTimeoutAlertThreshold)),
      lockTimeoutAlertThreshold: Math.max(1, Math.trunc(options.lockTimeoutAlertThreshold)),
    };
    this.nextReportAt = this.now() + this.options.reportIntervalMs;
  }

  recordRunResult(result: WorkerRunResultLike): void {
    const now = this.now();
    this.runSamples.push({
      at: now,
      processed: result.processed,
      status: result.processed ? result.status : undefined,
      taskTimeout: result.processed ? isTaskTimeoutError(result.error) : false,
    });
    this.prune(now);
  }

  recordSemaphoreWait(waitMs: number, timedOut: boolean): void {
    const now = this.now();
    this.lockSamples.push({
      at: now,
      waitMs: Math.max(0, Math.round(waitMs)),
      timedOut,
    });
    this.prune(now);
  }

  snapshot(nowInput?: number): WorkerRuntimeSnapshot {
    const now = nowInput ?? this.now();
    this.prune(now);

    const iterations = this.runSamples.length;
    const processed = this.runSamples.filter((sample) => sample.processed).length;
    const idle = iterations - processed;
    const done = this.runSamples.filter((sample) => sample.status === 'done').length;
    const deferred = this.runSamples.filter((sample) => sample.status === 'deferred').length;
    const failed = this.runSamples.filter((sample) => sample.status === 'failed').length;
    const taskTimeouts = this.runSamples.filter((sample) => sample.taskTimeout).length;
    const lockTimeouts = this.lockSamples.filter((sample) => sample.timedOut).length;
    const lockWaitMs = this.lockSamples.map((sample) => sample.waitMs);
    const lockSamples = lockWaitMs.length;
    const avgMs =
      lockSamples > 0 ? lockWaitMs.reduce((sum, value) => sum + value, 0) / lockSamples : 0;
    const maxMs = lockSamples > 0 ? Math.max(...lockWaitMs) : 0;
    const p95Ms = percentile(lockWaitMs, clampRatio(0.95));

    return {
      generatedAt: now,
      windowMs: this.options.windowMs,
      totals: {
        iterations,
        processed,
        idle,
        done,
        deferred,
        failed,
        taskTimeouts,
        lockTimeouts,
      },
      lockWait: {
        samples: lockSamples,
        avgMs,
        p95Ms,
        maxMs,
      },
    };
  }

  emitIfDue(): void {
    const now = this.now();
    const snapshot = this.snapshot(now);

    if (now >= this.nextReportAt) {
      this.options.logger({
        event: 'worker.runtime.metrics',
        level: 'info',
        windowMs: snapshot.windowMs,
        totals: snapshot.totals,
        lockWait: snapshot.lockWait,
      });
      this.nextReportAt = now + this.options.reportIntervalMs;
    }

    const cooldownMs = this.options.reportIntervalMs;

    if (
      snapshot.totals.taskTimeouts >= this.options.taskTimeoutAlertThreshold &&
      now - this.lastTaskTimeoutAlertAt >= cooldownMs
    ) {
      this.options.logger({
        event: 'worker.runtime.alert',
        level: 'error',
        alertType: 'task_timeout',
        observed: snapshot.totals.taskTimeouts,
        threshold: this.options.taskTimeoutAlertThreshold,
        windowMs: snapshot.windowMs,
      });
      this.lastTaskTimeoutAlertAt = now;
    }

    if (
      snapshot.totals.lockTimeouts >= this.options.lockTimeoutAlertThreshold &&
      now - this.lastLockTimeoutAlertAt >= cooldownMs
    ) {
      this.options.logger({
        event: 'worker.runtime.alert',
        level: 'error',
        alertType: 'lock_timeout',
        observed: snapshot.totals.lockTimeouts,
        threshold: this.options.lockTimeoutAlertThreshold,
        windowMs: snapshot.windowMs,
      });
      this.lastLockTimeoutAlertAt = now;
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private prune(now: number): void {
    const cutoff = now - this.options.windowMs;
    while (this.runSamples.length > 0 && this.runSamples[0] && this.runSamples[0].at < cutoff) {
      this.runSamples.shift();
    }
    while (this.lockSamples.length > 0 && this.lockSamples[0] && this.lockSamples[0].at < cutoff) {
      this.lockSamples.shift();
    }
  }
}
