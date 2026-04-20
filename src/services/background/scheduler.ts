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

  constructor(dbOrPath: Database | string = 'data/gnosis-tasks.sqlite') {
    if (typeof dbOrPath === 'string') {
      const dir = path.dirname(dbOrPath);
      if (dir !== '.' && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.db = new Database(dbOrPath);
    } else {
      this.db = dbOrPath;
    }
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
    // 高速化と並列性の向上のために WAL モードを有効化
    this.db.run('PRAGMA journal_mode = WAL');
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
    const now = Date.now();

    type ExistingTaskRow = Pick<
      TaskRow,
      'id' | 'status' | 'next_run_at' | 'created_at' | 'error_message'
    >;

    // 固定 ID タスクを安全に再投入する:
    // - running は上書きしない
    // - failed は再試行時刻が来るまで保持
    // - failed かつ再試行時刻到来なら pending に戻す
    this.db.transaction(() => {
      const existing = this.db
        .query(
          `SELECT id, status, next_run_at, created_at, error_message
           FROM background_tasks
           WHERE id = ?`,
        )
        .get(id) as ExistingTaskRow | undefined;

      if (!existing) {
        // 競合時（他プロセスが同一IDを先に挿入）でも例外で落ちないようにする
        this.db.run(
          `INSERT OR IGNORE INTO background_tasks (id, type, status, payload, priority, next_run_at, created_at)
           VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
          [id, type, payloadStr, priority, nextRunAt, now],
        );
        return;
      }

      if (existing.status === 'running') {
        return;
      }

      if (existing.status === 'failed') {
        const retryDue = existing.next_run_at === null || existing.next_run_at <= now;
        if (!retryDue) {
          return;
        }
      }

      const mergedNextRunAt =
        existing.next_run_at === null ? nextRunAt : Math.min(existing.next_run_at, nextRunAt);

      this.db.run(
        `UPDATE background_tasks
         SET type = ?, status = 'pending', payload = ?, priority = ?, next_run_at = ?, error_message = NULL
         WHERE id = ?`,
        [type, payloadStr, priority, mergedNextRunAt, id],
      );
    })();
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

    return this.mapRowToTask(row);
  }

  /**
   * アトミックにタスクを取得して 'running' 状態にします。
   * 複数のワーカーが同時に動作している場合に、同一タスクの重複実行を防ぎます。
   */
  async dequeueTask(): Promise<BackgroundTask | null> {
    const now = Date.now();
    let task: BackgroundTask | null = null;

    // トランザクション内で取得と更新を同時に行う
    this.db.transaction(() => {
      const row = this.db
        .query(
          `SELECT * FROM background_tasks 
           WHERE (status = 'pending' OR (status = 'failed' AND next_run_at <= ?)) 
           AND (next_run_at IS NULL OR next_run_at <= ?)
           ORDER BY priority DESC, created_at ASC
           LIMIT 1`,
        )
        .get(now, now) as TaskRow | undefined;

      if (row) {
        this.db.run('UPDATE background_tasks SET status = ?, last_run_at = ? WHERE id = ?', [
          'running',
          now,
          row.id,
        ]);
        task = this.mapRowToTask(row);
      }
    })();

    return task;
  }

  private mapRowToTask(row: TaskRow): BackgroundTask {
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

  updateTaskStatus(
    id: string,
    status: TaskStatus,
    errorMessage: string | null = null,
    nextRunAt: number | null = null,
  ) {
    const now = Date.now();
    if (status === 'running') {
      this.db.run('UPDATE background_tasks SET status = ?, last_run_at = ? WHERE id = ?', [
        status,
        now,
        id,
      ]);
    } else {
      // エラーメッセージが提供された場合、もしあればスタックトレースを含めるなど詳細化を検討可能
      this.db.run(
        'UPDATE background_tasks SET status = ?, error_message = ?, next_run_at = COALESCE(?, next_run_at) WHERE id = ?',
        [status, errorMessage, nextRunAt, id],
      );
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

  optimize() {
    console.error('[Maintenance] Cleaning up stale tasks in UnifiedTaskScheduler...');
    this.cleanupStaleTasks();
    // SQLite の最適化
    this.db.run('ANALYZE;');
  }

  close() {
    this.db.close();
  }
}

export const scheduler = new UnifiedTaskScheduler();
