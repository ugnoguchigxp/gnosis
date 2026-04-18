import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, unlinkSync } from 'node:fs';
import { UnifiedTaskScheduler } from '../src/services/background/scheduler.js';

const TEST_DB = 'test-tasks-atomicity.sqlite';

describe('UnifiedTaskScheduler Atomicity', () => {
  let scheduler: UnifiedTaskScheduler;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    scheduler = new UnifiedTaskScheduler(TEST_DB);
  });

  afterEach(() => {
    scheduler.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('dequeueTask is atomic and prevents duplicate acquisition', async () => {
    // 3つのタスクを登録
    await scheduler.enqueue('taskA', { name: 'A' }, { priority: 10 });
    await scheduler.enqueue('taskB', { name: 'B' }, { priority: 5 });
    await scheduler.enqueue('taskC', { name: 'C' }, { priority: 1 });

    // 同時に4回 dequeueTask を呼び出す (タスクは3つしかない)
    const results = await Promise.all([
      scheduler.dequeueTask(),
      scheduler.dequeueTask(),
      scheduler.dequeueTask(),
      scheduler.dequeueTask(),
    ]);

    // 取得できたタスクの数を確認
    const acquiredTasks = results.filter((t) => t !== null);
    expect(acquiredTasks.length).toBe(3);

    // 重複がないことを確認
    const ids = new Set(acquiredTasks.map((t) => t?.id));
    expect(ids.size).toBe(3);

    // ステータスがすべて 'running' になっていることを確認
    const allTasks = scheduler.getAllTasks();
    const runningTasks = allTasks.filter((t) => t.status === 'running');
    expect(runningTasks.length).toBe(3);
  });

  it('priority is respected in dequeueTask', async () => {
    await scheduler.enqueue('low', {}, { priority: 1 });
    await scheduler.enqueue('high', {}, { priority: 100 });
    await scheduler.enqueue('medium', {}, { priority: 50 });

    const task1 = await scheduler.dequeueTask();
    expect(task1?.type).toBe('high');

    const task2 = await scheduler.dequeueTask();
    expect(task2?.type).toBe('medium');

    const task3 = await scheduler.dequeueTask();
    expect(task3?.type).toBe('low');
  });

  it('picks up failed tasks after nextRunAt', async () => {
    const past = Date.now() - 10000;
    const future = Date.now() + 10000;

    // 失敗したが再試行時間が過ぎているタスク
    await scheduler.enqueue('retry-now', {}, { id: 't1', nextRunAt: past });
    scheduler.updateTaskStatus('t1', 'failed', 'error', past);

    // 失敗したがまだ再試行待ちのタスク
    await scheduler.enqueue('retry-later', {}, { id: 't2', nextRunAt: future });
    scheduler.updateTaskStatus('t2', 'failed', 'error', future);

    const task = await scheduler.dequeueTask();
    expect(task?.id).toBe('t1');
    expect(task?.type).toBe('retry-now');

    const noTask = await scheduler.dequeueTask();
    expect(noTask).toBeNull();
  });
});
