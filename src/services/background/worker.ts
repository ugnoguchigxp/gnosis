import { setTimeout } from 'node:timers/promises';

export type WorkerTask = () => Promise<void>;

/**
 * バックグラウンドで周期的にタスクを実行するワーカー。
 * MCPプロトコル(STDIO)を破壊しないよう、ログはすべて console.error に出力します。
 */
export class BackgroundWorker {
  private isRunning = false;
  private abortController: AbortController | null = null;

  constructor(
    private readonly name: string,
    private readonly task: WorkerTask,
    private readonly intervalMs: number,
  ) {}

  /**
   * ワーカーを開始します。
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();

    console.error(`[BackgroundWorker:${this.name}] Starting with interval ${this.intervalMs}ms`);

    // 非同期でループを開始
    this.loop().catch((err) => {
      console.error(`[BackgroundWorker:${this.name}] Fatal error in loop:`, err);
      this.isRunning = false;
    });
  }

  /**
   * ワーカーを停止します。
   */
  public stop(): void {
    this.isRunning = false;
    if (this.abortController) {
      this.abortController.abort();
    }
    console.error(`[BackgroundWorker:${this.name}] Stopped`);
  }

  private async loop(): Promise<void> {
    while (this.isRunning) {
      const start = Date.now();
      try {
        console.error(`[BackgroundWorker:${this.name}] Executing task...`);
        await this.task();
        console.error(`[BackgroundWorker:${this.name}] Task completed in ${Date.now() - start}ms`);
      } catch (err) {
        console.error(`[BackgroundWorker:${this.name}] Task failed:`, err);
      }

      if (!this.isRunning) break;

      try {
        await setTimeout(this.intervalMs, undefined, { signal: this.abortController?.signal });
      } catch (err) {
        // AbortSignal による中断
        if (err instanceof Error && err.name === 'AbortError') {
          break;
        }
        throw err;
      }
    }
  }
}
