import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface BackgroundTask {
  id: string;
  type: string;
  status: TaskStatus;
  payload: string; // JSON
  priority: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  errorMessage: string | null;
  createdAt: number;
}

interface TaskRow {
  id: string;
  type: string;
  status: string;
  payload: string;
  priority: number;
  next_run_at: number | null;
  last_run_at: number | null;
  error_message: string | null;
  created_at: number;
}

export class UnifiedTaskScheduler {
  private db: Database;

  constructor(dbPath = 'gnosis-tasks.sqlite') {
    const dir = path.dirname(dbPath);
    if (dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.init();
  }

  private init() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS background_tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT,
        priority INTEGER DEFAULT 0,
        next_run_at INTEGER,
        last_run_at INTEGER,
        error_message TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_tasks_status_next ON background_tasks(status, next_run_at)',
    );
  }

  async enqueue(
    type: string,
    payload: unknown,
    options: { priority?: number; nextRunAt?: number; id?: string } = {},
  ) {
    const id = options.id || crypto.randomUUID();
    const priority = options.priority || 0;
    const nextRunAt = options.nextRunAt || Date.now();
    const payloadStr = JSON.stringify(payload);

    this.db.run(
      `INSERT OR REPLACE INTO background_tasks (id, type, status, payload, priority, next_run_at, created_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
      [id, type, payloadStr, priority, nextRunAt, Date.now()],
    );
  }

  async getNextTask(): Promise<BackgroundTask | null> {
    const now = Date.now();
    const row = this.db
      .query(
        `SELECT * FROM background_tasks 
       WHERE (status = 'pending' OR (status = 'failed' AND next_run_at <= ?)) 
       AND next_run_at <= ?
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`,
      )
      .get(now, now) as TaskRow | undefined;

    if (!row) return null;

    return {
      id: row.id,
      type: row.type,
      status: row.status as TaskStatus,
      payload: row.payload,
      priority: row.priority,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      errorMessage: row.error_message,
      createdAt: row.created_at,
    };
  }

  updateTaskStatus(id: string, status: TaskStatus, errorMessage: string | null = null) {
    const now = Date.now();
    if (status === 'running') {
      this.db.run('UPDATE background_tasks SET status = ?, last_run_at = ? WHERE id = ?', [
        status,
        now,
        id,
      ]);
    } else {
      this.db.run('UPDATE background_tasks SET status = ?, error_message = ? WHERE id = ?', [
        status,
        errorMessage,
        id,
      ]);
    }
  }

  deleteTask(id: string) {
    this.db.run('DELETE FROM background_tasks WHERE id = ?', [id]);
  }

  // クリーンアップ: 実行中だが長時間放置されているタスクをリセット
  cleanupStaleTasks(timeoutMs: number = 30 * 60 * 1000) {
    const threshold = Date.now() - timeoutMs;
    this.db.run(
      `UPDATE background_tasks SET status = 'pending' WHERE status = 'running' AND last_run_at < ?`,
      [threshold],
    );
  }

  getAllTasks(): BackgroundTask[] {
    const rows = this.db
      .query('SELECT * FROM background_tasks ORDER BY created_at DESC')
      .all() as TaskRow[];
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status as TaskStatus,
      payload: row.payload,
      priority: row.priority,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      errorMessage: row.error_message,
      createdAt: row.created_at,
    }));
  }

  getRunningTaskCount(): number {
    const row = this.db
      .query("SELECT COUNT(*) as count FROM background_tasks WHERE status = 'running'")
      .get() as {
      count: number;
    };
    return row.count;
  }
}

export const scheduler = new UnifiedTaskScheduler();
