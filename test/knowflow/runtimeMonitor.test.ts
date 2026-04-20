import { describe, expect, it, mock } from 'bun:test';
import {
  WorkerRuntimeMonitor,
  isTaskTimeoutError,
} from '../../src/services/knowflow/ops/runtimeMonitor';

describe('worker runtime monitor', () => {
  it('records runtime samples and builds a snapshot within the active window', () => {
    let now = 1_000;
    const logger = mock();
    const monitor = new WorkerRuntimeMonitor({
      windowMs: 10_000,
      reportIntervalMs: 5_000,
      taskTimeoutAlertThreshold: 2,
      lockTimeoutAlertThreshold: 2,
      logger,
      now: () => now,
    });

    monitor.recordSemaphoreWait(120, false);
    monitor.recordRunResult({ processed: true, status: 'done' });
    now += 500;
    monitor.recordRunResult({
      processed: true,
      status: 'deferred',
      error: 'Task execution timed out after 10ms',
    });
    now += 500;
    monitor.recordSemaphoreWait(900, true);
    monitor.recordRunResult({ processed: false });

    const snapshot = monitor.snapshot();
    expect(snapshot.totals.iterations).toBe(3);
    expect(snapshot.totals.processed).toBe(2);
    expect(snapshot.totals.idle).toBe(1);
    expect(snapshot.totals.done).toBe(1);
    expect(snapshot.totals.deferred).toBe(1);
    expect(snapshot.totals.failed).toBe(0);
    expect(snapshot.totals.taskTimeouts).toBe(1);
    expect(snapshot.totals.lockTimeouts).toBe(1);
    expect(snapshot.lockWait.samples).toBe(2);
    expect(snapshot.lockWait.avgMs).toBe(510);
    expect(snapshot.lockWait.p95Ms).toBe(900);
    expect(snapshot.lockWait.maxMs).toBe(900);
  });

  it('emits periodic metrics and threshold alerts with cooldown', () => {
    let now = 10_000;
    const logger = mock();
    const monitor = new WorkerRuntimeMonitor({
      windowMs: 60_000,
      reportIntervalMs: 5_000,
      taskTimeoutAlertThreshold: 2,
      lockTimeoutAlertThreshold: 2,
      logger,
      now: () => now,
    });

    monitor.recordRunResult({
      processed: true,
      status: 'deferred',
      error: 'timed out while executing task',
    });
    monitor.recordRunResult({
      processed: true,
      status: 'deferred',
      error: 'Task execution timed out after 30000ms',
    });
    monitor.recordSemaphoreWait(1_000, true);
    monitor.recordSemaphoreWait(1_000, true);

    now += 5_001;
    monitor.emitIfDue();
    monitor.emitIfDue(); // cooldown check (same timestamp)

    const events = (logger.mock.calls as Array<[Record<string, unknown>]>).map((call) => call[0]);
    expect(events.filter((event) => event.event === 'worker.runtime.metrics')).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.event === 'worker.runtime.alert' && event.alertType === 'task_timeout',
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.event === 'worker.runtime.alert' && event.alertType === 'lock_timeout',
      ),
    ).toHaveLength(1);
  });

  it('isTaskTimeoutError detects timeout patterns', () => {
    expect(isTaskTimeoutError('Task execution timed out after 1000ms')).toBe(true);
    expect(isTaskTimeoutError('operation timeout exceeded')).toBe(true);
    expect(isTaskTimeoutError('temporary failure')).toBe(false);
    expect(isTaskTimeoutError(undefined)).toBe(false);
  });
});
