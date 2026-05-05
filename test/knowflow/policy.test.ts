import { describe, expect, it } from 'bun:test';
import type { TopicTask } from '../../src/services/knowflow/domain/task';
import {
  compareTaskPriority,
  computeBackoffWithJitterMs,
  decideFailureAction,
  isRunnable,
} from '../../src/services/knowflow/scheduler/policy';

const createTask = (overrides: Partial<TopicTask> = {}): TopicTask => ({
  id: 'task-1',
  topic: 'test topic',
  mode: 'directed',
  source: 'user',
  priority: 100,
  status: 'pending',
  dedupeKey: 'test topic:directed:user',
  attempts: 0,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides,
});

describe('scheduler policy', () => {
  it('compareTaskPriority sorts by priority desc then createdAt asc', () => {
    const highPriority = createTask({ id: 'high', priority: 100, createdAt: 2_000 });
    const lowPriority = createTask({ id: 'low', priority: 10, createdAt: 1_000 });
    expect(compareTaskPriority(highPriority, lowPriority)).toBeLessThan(0);
    expect(compareTaskPriority(lowPriority, highPriority)).toBeGreaterThan(0);

    const older = createTask({ id: 'older', priority: 50, createdAt: 1_000 });
    const newer = createTask({ id: 'newer', priority: 50, createdAt: 2_000 });
    expect(compareTaskPriority(older, newer)).toBeLessThan(0);
    expect(compareTaskPriority(newer, older)).toBeGreaterThan(0);
  });

  it('isRunnable only allows pending or due deferred tasks', () => {
    const now = 10_000;
    expect(isRunnable(createTask({ status: 'pending' }), now)).toBe(true);
    expect(isRunnable(createTask({ status: 'deferred', nextRunAt: now - 1 }), now)).toBe(true);
    expect(isRunnable(createTask({ status: 'deferred', nextRunAt: now + 1 }), now)).toBe(false);
    expect(isRunnable(createTask({ status: 'done' }), now)).toBe(false);
    expect(isRunnable(createTask({ status: 'failed' }), now)).toBe(false);
    expect(isRunnable(createTask({ status: 'running' }), now)).toBe(false);
  });

  it('decideFailureAction retries immediately and fails at max attempts', () => {
    const deferAction = decideFailureAction(createTask({ attempts: 0 }), 'temporary', {
      now: 1_000,
      maxAttempts: 3,
      baseBackoffMs: 200,
      maxBackoffMs: 5_000,
      jitterRatio: 0,
    });
    expect(deferAction.kind).toBe('defer');
    if (deferAction.kind === 'defer') {
      expect(deferAction.attempts).toBe(1);
      expect(deferAction.nextRunAt).toBe(1_000);
      expect(deferAction.errorReason).toBe('temporary');
    }

    const failAction = decideFailureAction(createTask({ attempts: 2 }), 'terminal', {
      now: 1_000,
      maxAttempts: 3,
    });
    expect(failAction.kind).toBe('fail');
    if (failAction.kind === 'fail') {
      expect(failAction.attempts).toBe(3);
      expect(failAction.errorReason).toBe('terminal');
    }
  });

  it('decideFailureAction fails immediately when retryable=false', () => {
    const action = decideFailureAction(createTask({ attempts: 0 }), 'timeout', {
      now: 1_000,
      maxAttempts: 3,
      retryable: false,
    });
    expect(action.kind).toBe('fail');
    if (action.kind === 'fail') {
      expect(action.attempts).toBe(1);
      expect(action.errorReason).toBe('timeout');
    }
  });

  it('computeBackoffWithJitterMs spreads retry time within configured jitter range', () => {
    const baseBackoff = 1_000;
    expect(computeBackoffWithJitterMs(baseBackoff, 0.2, () => 0)).toBe(800);
    expect(computeBackoffWithJitterMs(baseBackoff, 0.2, () => 0.5)).toBe(1_000);
    expect(computeBackoffWithJitterMs(baseBackoff, 0.2, () => 1)).toBe(1_200);
  });

  it('decideFailureAction ignores backoff knobs and keeps retry immediate', () => {
    const action = decideFailureAction(createTask({ attempts: 10 }), 'retry', {
      now: 1_000,
      maxAttempts: 99,
      baseBackoffMs: 10_000,
      maxBackoffMs: 5_000,
      jitterRatio: 0.2,
      random: () => 1,
    });
    expect(action.kind).toBe('defer');
    if (action.kind === 'defer') {
      expect(action.nextRunAt).toBe(1_000);
    }
  });
});
