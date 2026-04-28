import { isProcessAlive, signalProcessTree } from '../runtime/childProcesses.js';

export type TaskInfo = {
  pid: number;
  ppid: number;
  task: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'finished' | 'zombie' | 'killed';
};

export class TaskManager {
  private tasks = new Map<number, TaskInfo>();
  private readonly gracePeriodMs = 2000;
  private readonly finishedTaskTtlMs = 60_000; // 終了後1分間は情報を保持

  constructor(private logger: Pick<Console, 'log' | 'error'> = console) {}

  register(pid: number, ppid: number, task: string): void {
    // 既存のタスクがあれば上書き（PID再利用対策）
    this.tasks.set(pid, {
      pid,
      ppid,
      task,
      startedAt: Date.now(),
      status: 'running',
    });
    this.logger.log(`[TaskManager] Task started: ${task} (PID: ${pid}, PPID: ${ppid})`);
  }

  async unregister(pid: number): Promise<void> {
    const task = this.tasks.get(pid);
    if (!task || task.status !== 'running') return;

    task.status = 'finished';
    task.endedAt = Date.now();
    this.logger.log(`[TaskManager] Task finished signal received: ${task.task} (PID: ${pid})`);

    // 猶予期間を待ってプロセスが残っているか確認
    setTimeout(() => {
      this.verifyCleanup(pid);
    }, this.gracePeriodMs);
  }

  private verifyCleanup(pid: number): void {
    const task = this.tasks.get(pid);
    if (!task || task.status !== 'finished') return;

    if (isProcessAlive(pid)) {
      task.status = 'zombie';
      this.logger.error(
        `[TaskManager] ALERT: Process ${pid} (${task.task}) is still alive after finish signal!`,
      );
      this.logger.error(`[TaskManager] Suggesting forced termination for PID ${pid}`);

      if (process.env.GNOSIS_SUPERVISOR_AUTO_KILL === 'true') {
        this.logger.error(`[TaskManager] Auto-killing zombie process ${pid}...`);
        signalProcessTree(pid, 'SIGKILL');
        task.status = 'killed';
      }
    }

    // 終了/殺害済みタスクを一定時間後に履歴から削除
    setTimeout(() => {
      const current = this.tasks.get(pid);
      if (
        current &&
        (current.status === 'finished' ||
          current.status === 'killed' ||
          current.status === 'zombie')
      ) {
        this.tasks.delete(pid);
      }
    }, this.finishedTaskTtlMs);
  }

  /**
   * 親プロセスが死んでいるタスクを掃除する（親とはぐれた孤児の回収）
   */
  reapOrphans(): void {
    for (const [pid, task] of this.tasks.entries()) {
      if (task.status === 'running' && task.ppid > 1 && !isProcessAlive(task.ppid)) {
        this.logger.error(
          `[TaskManager] Parent ${task.ppid} of task ${pid} (${task.task}) died. Reaping orphan...`,
        );
        signalProcessTree(pid, 'SIGTERM');
        // SIGTERM で死なない場合は次の reap で SIGKILL するなどの段階的処置も可能
        task.status = 'finished';
        setTimeout(() => this.verifyCleanup(pid), this.gracePeriodMs);
      }
    }
  }

  getStats() {
    return {
      activeCount: Array.from(this.tasks.values()).filter((t) => t.status === 'running').length,
      tasks: Array.from(this.tasks.values()),
    };
  }
}
