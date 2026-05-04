import { and, asc, desc, eq, inArray, lt, lte, or } from 'drizzle-orm';
import { db as defaultDb } from '../../../db/index.js';
import { topicTasks } from '../../../db/schema.js';
import { CreateTaskInputSchema, type TopicTask, TopicTaskSchema, createTask } from '../domain/task';
import { type FailureAction, isRunnable } from '../scheduler/policy';
import type { QueueRepository } from './repository';
import { parseTaskPayload, toTaskRowFields } from './taskRow';

const ACTIVE_STATUSES = ['pending', 'running', 'deferred'] as const;
const activeStatuses = [...ACTIVE_STATUSES];

type DbTransaction = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];

const extractLockOwnerPid = (lockOwner: string | undefined): number | null => {
  if (!lockOwner) return null;
  const parts = lockOwner.split('-').filter((part) => part.length > 0);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const pid = Number(parts[index]);
    if (Number.isInteger(pid) && pid > 1) return pid;
  }
  return null;
};

const isPidAlive = (pid: number | null): boolean => {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export class PgJsonbQueueRepository implements QueueRepository {
  private database: typeof defaultDb;

  constructor(database: typeof defaultDb = defaultDb) {
    this.database = database;
  }
  async enqueue(input: unknown): Promise<{ task: TopicTask; deduped: boolean }> {
    const parsed = CreateTaskInputSchema.parse(input);
    const task = createTask(parsed);

    return this.database.transaction(async (tx: DbTransaction) => {
      // 重複チェック
      const existing = await tx
        .select({ id: topicTasks.id, payload: topicTasks.payload })
        .from(topicTasks)
        .where(
          and(eq(topicTasks.dedupeKey, task.dedupeKey), inArray(topicTasks.status, activeStatuses)),
        )
        .orderBy(asc(topicTasks.createdAt))
        .limit(1)
        .for('update');

      if (existing[0]) {
        return {
          task: parseTaskPayload(existing[0].payload),
          deduped: true,
        };
      }

      const row = toTaskRowFields(task);
      const inserted = await tx
        .insert(topicTasks)
        .values({
          id: row.id,
          dedupeKey: row.dedupeKey,
          status: row.status,
          priority: row.priority,
          nextRunAt: row.nextRunAt,
          lockedAt: row.lockedAt,
          lockOwner: row.lockOwner,
          payload: row.payload,
        })
        .onConflictDoNothing()
        .returning({ id: topicTasks.id });

      if (inserted.length > 0) {
        return { task, deduped: false };
      }

      // Conflict した場合の再取得
      const deduped = await tx
        .select({ id: topicTasks.id, payload: topicTasks.payload })
        .from(topicTasks)
        .where(
          and(eq(topicTasks.dedupeKey, task.dedupeKey), inArray(topicTasks.status, activeStatuses)),
        )
        .orderBy(asc(topicTasks.createdAt))
        .limit(1)
        .for('update');

      if (!deduped[0]) {
        throw new Error(
          `enqueue conflict occurred but no active dedupe task found for key=${task.dedupeKey}`,
        );
      }

      return {
        task: parseTaskPayload(deduped[0].payload),
        deduped: true,
      };
    });
  }

  async list(): Promise<TopicTask[]> {
    const rows = await this.database
      .select({ payload: topicTasks.payload })
      .from(topicTasks)
      .orderBy(asc(topicTasks.createdAt));

    return rows.map((row) => parseTaskPayload(row.payload));
  }

  async dequeueAndLock(workerId: string, now = Date.now()): Promise<TopicTask | null> {
    return this.database.transaction(async (tx: DbTransaction) => {
      // 候補を選択
      // NOTE: status = ANY(...) は drizzle で any(column, values)
      const candidateRows = await tx
        .select({ id: topicTasks.id, payload: topicTasks.payload })
        .from(topicTasks)
        .where(
          or(
            eq(topicTasks.status, 'pending'),
            and(eq(topicTasks.status, 'deferred'), lte(topicTasks.nextRunAt, now)),
          ),
        )
        .orderBy(desc(topicTasks.priority), asc(topicTasks.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });

      const candidate = candidateRows[0];
      if (!candidate) {
        return null;
      }

      const parsed = parseTaskPayload(candidate.payload);
      if (!isRunnable(parsed, now)) {
        return null;
      }

      const lockedTask = TopicTaskSchema.parse({
        ...parsed,
        status: 'running',
        updatedAt: now,
        lockOwner: workerId,
        lockedAt: now,
        nextRunAt: undefined,
        errorReason: undefined,
      });
      const row = toTaskRowFields(lockedTask);

      await tx
        .update(topicTasks)
        .set({
          status: row.status,
          priority: row.priority,
          nextRunAt: row.nextRunAt,
          lockedAt: row.lockedAt,
          lockOwner: row.lockOwner,
          payload: row.payload,
          updatedAt: new Date(),
        })
        .where(eq(topicTasks.id, candidate.id));

      return lockedTask;
    });
  }

  async markDone(taskId: string, resultSummary?: string, now = Date.now()): Promise<TopicTask> {
    return this.updateTask(taskId, now, (task) =>
      TopicTaskSchema.parse({
        ...task,
        status: 'done',
        updatedAt: now,
        lockOwner: undefined,
        lockedAt: undefined,
        nextRunAt: undefined,
        errorReason: undefined,
        resultSummary,
      }),
    );
  }

  async applyFailureAction(
    taskId: string,
    action: FailureAction,
    now = Date.now(),
  ): Promise<TopicTask> {
    return this.updateTask(taskId, now, (task) => {
      if (action.kind === 'fail') {
        return TopicTaskSchema.parse({
          ...task,
          attempts: action.attempts,
          errorReason: action.errorReason,
          status: 'failed',
          updatedAt: now,
          lockOwner: undefined,
          lockedAt: undefined,
          nextRunAt: undefined,
        });
      }

      return TopicTaskSchema.parse({
        ...task,
        attempts: action.attempts,
        errorReason: action.errorReason,
        status: 'deferred',
        updatedAt: now,
        lockOwner: undefined,
        lockedAt: undefined,
        nextRunAt: action.nextRunAt,
      });
    });
  }

  async bulkUpsertTasks(tasks: TopicTask[]): Promise<number> {
    if (tasks.length === 0) {
      return 0;
    }

    await this.database.transaction(async (tx: DbTransaction) => {
      for (const task of tasks) {
        const row = toTaskRowFields(task);
        await tx
          .insert(topicTasks)
          .values({
            id: row.id,
            dedupeKey: row.dedupeKey,
            status: row.status,
            priority: row.priority,
            nextRunAt: row.nextRunAt,
            lockedAt: row.lockedAt,
            lockOwner: row.lockOwner,
            payload: row.payload,
          })
          .onConflictDoUpdate({
            target: topicTasks.id,
            set: {
              dedupeKey: row.dedupeKey,
              status: row.status,
              priority: row.priority,
              nextRunAt: row.nextRunAt,
              lockedAt: row.lockedAt,
              lockOwner: row.lockOwner,
              payload: row.payload,
              updatedAt: new Date(),
            },
          });
      }
    });

    return tasks.length;
  }

  async clearStaleTasks(timeoutMs: number, now = Date.now()): Promise<number> {
    const staleThreshold = new Date(now - timeoutMs);

    const staleTasks = await this.database
      .select({ id: topicTasks.id, payload: topicTasks.payload })
      .from(topicTasks)
      .where(and(eq(topicTasks.status, 'running'), lt(topicTasks.updatedAt, staleThreshold)));

    if (staleTasks.length === 0) {
      return 0;
    }

    let clearedCount = 0;
    await this.database.transaction(async (tx) => {
      for (const row of staleTasks) {
        const task = parseTaskPayload(row.payload);
        const staleForMs = Math.max(0, now - task.updatedAt);
        const updated = TopicTaskSchema.parse({
          ...task,
          status: 'failed',
          attempts: Math.max(task.attempts, 1),
          errorReason: `stale running task auto-failed after ${staleForMs}ms`,
          updatedAt: now,
          lockedAt: undefined,
          lockOwner: undefined,
          nextRunAt: undefined,
        });
        const fields = toTaskRowFields(updated);

        await tx
          .update(topicTasks)
          .set({
            status: fields.status,
            nextRunAt: fields.nextRunAt,
            payload: fields.payload,
            lockOwner: fields.lockOwner,
            lockedAt: fields.lockedAt,
            updatedAt: new Date(now),
          })
          .where(eq(topicTasks.id, row.id));

        clearedCount += 1;
      }
    });

    return clearedCount;
  }

  async clearOrphanedRunningTasks(
    activeLockOwnerPrefixes: string[],
    now = Date.now(),
  ): Promise<number> {
    const prefixes = activeLockOwnerPrefixes
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (prefixes.length === 0) return 0;

    const running = await this.database
      .select({ id: topicTasks.id, payload: topicTasks.payload })
      .from(topicTasks)
      .where(eq(topicTasks.status, 'running'));

    const orphanRows = running.filter((row) => {
      const task = parseTaskPayload(row.payload);
      if (!task.lockOwner) return true;
      if (isPidAlive(extractLockOwnerPid(task.lockOwner))) return false;
      return !prefixes.some((prefix) => task.lockOwner?.startsWith(prefix));
    });

    if (orphanRows.length === 0) return 0;

    let clearedCount = 0;
    await this.database.transaction(async (tx) => {
      for (const row of orphanRows) {
        const task = parseTaskPayload(row.payload);
        const updated = TopicTaskSchema.parse({
          ...task,
          status: 'deferred',
          attempts: task.attempts,
          errorReason: `orphaned running task recovered (lockOwner=${task.lockOwner ?? 'none'})`,
          updatedAt: now,
          lockedAt: undefined,
          lockOwner: undefined,
          nextRunAt: now,
        });
        const fields = toTaskRowFields(updated);
        await tx
          .update(topicTasks)
          .set({
            status: fields.status,
            nextRunAt: fields.nextRunAt,
            payload: fields.payload,
            lockOwner: fields.lockOwner,
            lockedAt: fields.lockedAt,
            updatedAt: new Date(now),
          })
          .where(eq(topicTasks.id, row.id));
        clearedCount += 1;
      }
    });

    return clearedCount;
  }

  private async updateTask(
    taskId: string,
    now: number,
    updater: (task: TopicTask) => TopicTask,
  ): Promise<TopicTask> {
    return this.database.transaction(async (tx) => {
      const rows = await tx
        .select({ id: topicTasks.id, payload: topicTasks.payload })
        .from(topicTasks)
        .where(eq(topicTasks.id, taskId))
        .for('update');

      const row = rows[0];
      if (!row) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const task = parseTaskPayload(row.payload);
      const updated = updater(task);
      const normalized = TopicTaskSchema.parse({
        ...updated,
        updatedAt: now,
      });
      const fields = toTaskRowFields(normalized);

      await tx
        .update(topicTasks)
        .set({
          dedupeKey: fields.dedupeKey,
          status: fields.status,
          priority: fields.priority,
          nextRunAt: fields.nextRunAt,
          lockedAt: fields.lockedAt,
          lockOwner: fields.lockOwner,
          payload: fields.payload,
          updatedAt: new Date(),
        })
        .where(eq(topicTasks.id, taskId));

      return normalized;
    });
  }
}
