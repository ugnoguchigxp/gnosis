import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  CreateTaskInputSchema,
  type TopicTask,
  TopicTaskSchema,
  createDedupeKey,
  createTask,
} from '../domain/task';
import { type FailureAction, compareTaskPriority, isRunnable } from '../scheduler/policy';

const QueueFileSchema = {
  parse(payload: unknown): TopicTask[] {
    if (!Array.isArray(payload)) {
      throw new Error('Queue payload must be an array.');
    }
    return payload.map((item) => TopicTaskSchema.parse(item));
  },
};

export type QueueRepository = {
  enqueue: (input: unknown) => Promise<{ task: TopicTask; deduped: boolean }>;
  list: () => Promise<TopicTask[]>;
  dequeueAndLock: (workerId: string, now?: number) => Promise<TopicTask | null>;
  markDone: (taskId: string, resultSummary?: string, now?: number) => Promise<TopicTask>;
  applyFailureAction: (taskId: string, action: FailureAction, now?: number) => Promise<TopicTask>;
  clearStaleTasks: (timeoutMs: number, now?: number) => Promise<number>;
};

export class FileQueueRepository implements QueueRepository {
  private readonly queueFilePath: string;
  private mutateChain: Promise<void> = Promise.resolve();

  constructor(queueFilePath: string) {
    this.queueFilePath = resolve(queueFilePath);
  }

  async enqueue(input: unknown): Promise<{ task: TopicTask; deduped: boolean }> {
    const parsed = CreateTaskInputSchema.parse(input);
    const dedupeKey = createDedupeKey(parsed.topic, parsed.mode, parsed.source, parsed.sourceGroup);

    return this.withMutation<{ task: TopicTask; deduped: boolean }>(async (tasks) => {
      const existing = tasks.find(
        (task) =>
          task.dedupeKey === dedupeKey &&
          (task.status === 'pending' || task.status === 'running' || task.status === 'deferred'),
      );

      if (existing) {
        return { tasks, output: { task: existing, deduped: true } };
      }

      const task = createTask(parsed);
      return { tasks: [...tasks, task], output: { task, deduped: false } };
    });
  }

  async list(): Promise<TopicTask[]> {
    return this.readQueue();
  }

  async dequeueAndLock(workerId: string, now = Date.now()): Promise<TopicTask | null> {
    return this.withMutation(async (tasks) => {
      const runningDedupeKeys = new Set(
        tasks.filter((task) => task.status === 'running').map((task) => task.dedupeKey),
      );

      const candidates = tasks.filter((task) => isRunnable(task, now)).sort(compareTaskPriority);

      const selected = candidates.find((candidate) => !runningDedupeKeys.has(candidate.dedupeKey));

      if (!selected) {
        return { tasks, output: null };
      }

      const nextTasks = tasks.map((task) => {
        if (task.id !== selected.id) {
          return task;
        }

        return TopicTaskSchema.parse({
          ...task,
          status: 'running',
          lockedAt: now,
          lockOwner: workerId,
          updatedAt: now,
          nextRunAt: undefined,
          errorReason: undefined,
        });
      });

      const locked = nextTasks.find((task) => task.id === selected.id) ?? null;
      return { tasks: nextTasks, output: locked };
    });
  }

  async markDone(taskId: string, resultSummary?: string, now = Date.now()): Promise<TopicTask> {
    return this.withMutation(async (tasks) => {
      let updated: TopicTask | null = null;
      const nextTasks = tasks.map((task) => {
        if (task.id !== taskId) {
          return task;
        }

        updated = TopicTaskSchema.parse({
          ...task,
          status: 'done',
          updatedAt: now,
          lockedAt: undefined,
          lockOwner: undefined,
          errorReason: undefined,
          nextRunAt: undefined,
          resultSummary,
        });
        return updated;
      });

      if (!updated) {
        throw new Error(`Task not found: ${taskId}`);
      }

      return { tasks: nextTasks, output: updated };
    });
  }

  async applyFailureAction(
    taskId: string,
    action: FailureAction,
    now = Date.now(),
  ): Promise<TopicTask> {
    return this.withMutation(async (tasks) => {
      let updated: TopicTask | null = null;

      const nextTasks = tasks.map((task) => {
        if (task.id !== taskId) {
          return task;
        }

        if (action.kind === 'fail') {
          updated = TopicTaskSchema.parse({
            ...task,
            attempts: action.attempts,
            status: 'failed',
            errorReason: action.errorReason,
            updatedAt: now,
            lockedAt: undefined,
            lockOwner: undefined,
            nextRunAt: undefined,
          });
          return updated;
        }

        updated = TopicTaskSchema.parse({
          ...task,
          attempts: action.attempts,
          status: 'deferred',
          errorReason: action.errorReason,
          updatedAt: now,
          lockedAt: undefined,
          lockOwner: undefined,
          nextRunAt: action.nextRunAt,
        });
        return updated;
      });

      if (!updated) {
        throw new Error(`Task not found: ${taskId}`);
      }

      return { tasks: nextTasks, output: updated };
    });
  }

  async clearStaleTasks(timeoutMs: number, now = Date.now()): Promise<number> {
    return this.withMutation<number>(async (tasks) => {
      let clearedCount = 0;
      const nextTasks = tasks.map((task) => {
        if (task.status === 'running' && task.updatedAt + timeoutMs < now) {
          clearedCount += 1;
          const staleForMs = Math.max(0, now - task.updatedAt);
          return TopicTaskSchema.parse({
            ...task,
            status: 'failed',
            attempts: Math.max(task.attempts, 1),
            errorReason: `stale running task auto-failed after ${staleForMs}ms`,
            updatedAt: now,
            lockedAt: undefined,
            lockOwner: undefined,
            nextRunAt: undefined,
          });
        }
        return task;
      });

      return { tasks: nextTasks, output: clearedCount };
    });
  }

  private async withMutation<T>(
    mutator: (tasks: TopicTask[]) => Promise<{ tasks: TopicTask[]; output: T }>,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const tasks = await this.readQueue();
      const { tasks: nextTasks, output } = await mutator(tasks);
      await this.writeQueue(nextTasks);
      return output;
    };

    const prev = this.mutateChain;
    let release!: () => void;
    this.mutateChain = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });

    await prev;
    try {
      return await run();
    } finally {
      release();
    }
  }

  private async readQueue(): Promise<TopicTask[]> {
    await this.ensureQueueFile();
    const raw = await readFile(this.queueFilePath, 'utf-8');
    const payload = raw.trim().length === 0 ? [] : JSON.parse(raw);
    return QueueFileSchema.parse(payload);
  }

  private async writeQueue(tasks: TopicTask[]): Promise<void> {
    await this.ensureQueueFile();
    const tmpFile = `${this.queueFilePath}.tmp`;
    await writeFile(tmpFile, `${JSON.stringify(tasks, null, 2)}\n`, 'utf-8');
    await rename(tmpFile, this.queueFilePath);
  }

  private async ensureQueueFile(): Promise<void> {
    await mkdir(dirname(this.queueFilePath), { recursive: true });
    try {
      await readFile(this.queueFilePath, 'utf-8');
    } catch {
      await writeFile(this.queueFilePath, '[]\n', 'utf-8');
    }
  }
}
