import { describe, expect, it } from 'bun:test';
import type { TopicTask } from '../../src/services/knowflow/domain/task';
import {
  compareTaskPriority,
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

  it('decideFailureAction defers first and fails at max attempts', () => {
    const deferAction = decideFailureAction(createTask({ attempts: 0 }), 'temporary', {
      now: 1_000,
      maxAttempts: 3,
      baseBackoffMs: 200,
      maxBackoffMs: 5_000,
    });
    expect(deferAction.kind).toBe('defer');
    if (deferAction.kind === 'defer') {
      expect(deferAction.attempts).toBe(1);
      expect(deferAction.nextRunAt).toBe(1_200);
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
});
