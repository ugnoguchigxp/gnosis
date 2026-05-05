import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { topicTasks } from '../db/schema.js';
import { parseTaskPayload } from '../services/knowflow/queue/taskRow.js';
import { parseArgMap, readNumberFlag, readStringFlag } from '../services/knowflow/utils/args.js';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output.js';

const DEFER_MINUTES_DEFAULT = 15;

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);
  const action = readStringFlag(args, 'action');
  const taskId = readStringFlag(args, 'task-id');

  if (!action || !['retry', 'defer'].includes(action)) {
    throw new Error('--action must be retry or defer');
  }
  if (!taskId) {
    throw new Error('--task-id is required');
  }

  let rows: any[] = [];
  try {
    // IDがUUID形式でない場合、Postgresクエリが失敗する可能性があるためtry-catchで囲む
    rows = await db
      .select({
        id: topicTasks.id,
        status: topicTasks.status,
        priority: topicTasks.priority,
        payload: topicTasks.payload,
      })
      .from(topicTasks)
      .where(eq(topicTasks.id, taskId))
      .limit(1);
  } catch (e) {
    // Ignore error and fallback to SQLite
  }

  const row = rows[0];
  if (row) {
    // KnowFlow (Postgres) task handling
    const task = parseTaskPayload(row.payload);
    const now = Date.now();

    if (action === 'retry') {
      if (!['failed', 'deferred'].includes(row.status)) {
        throw new Error(`retry allowed only for failed/deferred tasks: ${row.status}`);
      }
      const sourceTaskId = task.id;
      const retryPayload = {
        ...task,
        id: crypto.randomUUID(),
        status: 'pending',
        attempts: 0,
        lockedAt: undefined,
        lockOwner: undefined,
        nextRunAt: undefined,
        errorReason: undefined,
        resultSummary: undefined,
        updatedAt: now,
        createdAt: now,
        requestedBy: task.requestedBy ?? 'monitor',
      };

      await db.insert(topicTasks).values({
        id: retryPayload.id,
        dedupeKey: `${task.dedupeKey}:retry:${retryPayload.id}`,
        status: 'pending',
        priority: row.priority,
        nextRunAt: null,
        lockedAt: null,
        lockOwner: null,
        payload: retryPayload,
      });

      process.stdout.write(
        renderOutput(
          {
            success: true,
            action,
            sourceTaskId,
            newTaskId: retryPayload.id,
            status: 'pending',
          },
          outputFormat,
        ),
      );
      return;
    }

    if (action === 'defer') {
      if (!['pending', 'deferred'].includes(row.status)) {
        throw new Error(`defer allowed only for pending/deferred tasks: ${row.status}`);
      }

      const deferMinutes = Math.max(
        1,
        readNumberFlag(args, 'defer-minutes') ?? DEFER_MINUTES_DEFAULT,
      );
      const nextRunAt = now + deferMinutes * 60 * 1000;
      const nextPayload = {
        ...task,
        status: 'deferred',
        nextRunAt,
        updatedAt: now,
      };

      const updated = await db
        .update(topicTasks)
        .set({
          status: 'deferred',
          nextRunAt,
          payload: nextPayload,
          updatedAt: new Date(),
        })
        .where(and(eq(topicTasks.id, taskId), eq(topicTasks.status, row.status)))
        .returning({ id: topicTasks.id });
      if (updated.length === 0) {
        throw new Error('defer failed due to concurrent task state change');
      }

      process.stdout.write(
        renderOutput(
          {
            success: true,
            action,
            taskId,
            nextRunAt,
            deferMinutes,
          },
          outputFormat,
        ),
      );
      return;
    }
  }

  // Fallback to Embedding (SQLite) task handling
  const sqlitePath = resolve(process.cwd(), 'data', 'gnosis-tasks.sqlite');
  if (existsSync(sqlitePath)) {
    const sqlite = new Database(sqlitePath);
    try {
      const sqliteRow = sqlite
        .query<{ id: string; status: string }, [string]>(
          'SELECT id, status FROM background_tasks WHERE id = ?',
        )
        .get(taskId);

      if (sqliteRow) {
        const now = Date.now();
        if (action === 'retry') {
          if (!['failed', 'completed', 'unknown'].includes(sqliteRow.status)) {
            // SQLite tasks might use 'completed' instead of 'done'
          }

          sqlite.run(
            'UPDATE background_tasks SET status = ?, next_run_at = ?, error_message = NULL WHERE id = ?',
            ['pending', now, taskId],
          );

          process.stdout.write(
            renderOutput(
              {
                success: true,
                action,
                taskId,
                status: 'pending',
              },
              outputFormat,
            ),
          );
          return;
        }

        if (action === 'defer') {
          const deferMinutes = Math.max(
            1,
            readNumberFlag(args, 'defer-minutes') ?? DEFER_MINUTES_DEFAULT,
          );
          const nextRunAt = now + deferMinutes * 60 * 1000;

          sqlite.run('UPDATE background_tasks SET status = ?, next_run_at = ? WHERE id = ?', [
            'pending',
            nextRunAt,
            taskId,
          ]);

          process.stdout.write(
            renderOutput(
              {
                success: true,
                action,
                taskId,
                nextRunAt,
                deferMinutes,
              },
              outputFormat,
            ),
          );
          return;
        }
      }
    } finally {
      sqlite.close();
    }
  }

  throw new Error(`task not found in any queue: ${taskId}`);
};

run()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
