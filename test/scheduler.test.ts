import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { UnifiedTaskScheduler } from '../src/services/background/scheduler.js';

describe('UnifiedTaskScheduler', () => {
  let db: Database;
  let scheduler: UnifiedTaskScheduler;

  beforeEach(() => {
    // In-memory database for testing
    db = new Database(':memory:');
    scheduler = new UnifiedTaskScheduler(db);
  });

  afterEach(() => {
    db.close();
  });

  it('initially has no tasks', () => {
    const tasks = scheduler.getAllTasks();
    expect(tasks).toHaveLength(0);
  });

  it('can enqueue and retrieve a task', async () => {
    await scheduler.enqueue('test-task', { foo: 'bar' });
    const tasks = scheduler.getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('test-task');
    expect(JSON.parse(tasks[0].payload)).toEqual({ foo: 'bar' });
  });

  it('retrieves the next available task based on priority', async () => {
    await scheduler.enqueue('low-priority', {}, { priority: 1 });
    await scheduler.enqueue('high-priority', {}, { priority: 10 });

    const task = await scheduler.getNextTask();
    expect(task?.type).toBe('high-priority');
  });

  it('retrieves the oldest task if priorities are equal', async () => {
    await scheduler.enqueue('first', {}, { priority: 5 });
    await scheduler.enqueue('second', {}, { priority: 5 });

    const task = await scheduler.getNextTask();
    expect(task?.type).toBe('first');
  });

  it('updates task status correctly', async () => {
    await scheduler.enqueue('task-1', {});
    const task = await scheduler.getNextTask();
    expect(task).toBeDefined();
    if (!task) throw new Error('Task not found');

    scheduler.updateTaskStatus(task.id, 'running');
    const runningTasks = scheduler.getAllTasks().filter((t) => t.status === 'running');
    expect(runningTasks).toHaveLength(1);
    expect(scheduler.getRunningTaskCount()).toBe(1);

    scheduler.updateTaskStatus(task.id, 'completed');
    expect(scheduler.getRunningTaskCount()).toBe(0);
  });

  it('deletes a task', async () => {
    await scheduler.enqueue('task-1', {});
    const tasks = scheduler.getAllTasks();
    expect(tasks).toHaveLength(1);

    scheduler.deleteTask(tasks[0].id);
    expect(scheduler.getAllTasks()).toHaveLength(0);
  });

  it('cleans up stale tasks', async () => {
    await scheduler.enqueue('stale-task', {});
    const task = await scheduler.getNextTask();
    if (!task) throw new Error('Task not found');
    scheduler.updateTaskStatus(task.id, 'running');

    // Force set last_run_at to old value
    const oldTime = Date.now() - 60 * 60 * 1000; // 1 hour ago
    db.run('UPDATE background_tasks SET last_run_at = ? WHERE id = ?', [oldTime, task.id]);

    scheduler.cleanupStaleTasks(30 * 60 * 1000); // 30 min timeout

    const tasks = scheduler.getAllTasks();
    expect(tasks[0].status).toBe('pending');
  });

  it('does not retrieve tasks scheduled for the future', async () => {
    const future = Date.now() + 10000;
    await scheduler.enqueue('future-task', {}, { nextRunAt: future });

    const task = await scheduler.getNextTask();
    expect(task).toBeNull();
  });

  it('does not overwrite a running periodic task when re-enqueued with same id', async () => {
    await scheduler.enqueue('periodic', { step: 1 }, { id: 'periodic-1', priority: 5 });
    const first = await scheduler.dequeueTask();
    expect(first?.id).toBe('periodic-1');
    expect(first?.status).toBe('pending');

    await scheduler.enqueue('periodic', { step: 2 }, { id: 'periodic-1', priority: 9 });

    const tasks = scheduler.getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('periodic-1');
    expect(tasks[0].status).toBe('running');
    expect(JSON.parse(tasks[0].payload)).toEqual({ step: 1 });
  });

  it('keeps failed task unchanged before retry time when re-enqueued with same id', async () => {
    const retryAt = Date.now() + 30_000;
    await scheduler.enqueue('periodic', { step: 1 }, { id: 'periodic-failed', priority: 3 });
    scheduler.updateTaskStatus('periodic-failed', 'failed', 'boom', retryAt);

    await scheduler.enqueue('periodic', { step: 2 }, { id: 'periodic-failed', priority: 9 });

    const tasks = scheduler.getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('periodic-failed');
    expect(tasks[0].status).toBe('failed');
    expect(tasks[0].nextRunAt).toBe(retryAt);
    expect(tasks[0].errorMessage).toBe('boom');
    expect(JSON.parse(tasks[0].payload)).toEqual({ step: 1 });
  });

  it('requeues failed task to pending after retry time when re-enqueued with same id', async () => {
    const past = Date.now() - 10_000;
    await scheduler.enqueue('periodic', { step: 1 }, { id: 'periodic-retry', priority: 1 });
    scheduler.updateTaskStatus('periodic-retry', 'failed', 'boom', past);

    await scheduler.enqueue('periodic', { step: 2 }, { id: 'periodic-retry', priority: 7 });

    const tasks = scheduler.getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('periodic-retry');
    expect(tasks[0].status).toBe('pending');
    expect(tasks[0].errorMessage).toBeNull();
    expect(JSON.parse(tasks[0].payload)).toEqual({ step: 2 });
  });
});
