import { config } from '../../config.js';
import { consolidationTask } from './tasks/consolidationTask.js';
import { synthesisTask } from './tasks/synthesisTask.js';
import { BackgroundWorker } from './worker.js';

/**
 * すべてのバックグラウンドプロセスを管理するマネージャー。
 */
let introspectionWorker: BackgroundWorker | null = null;

/**
 * バックグラウンドプロセスを開始します。
 */
export function startBackgroundWorkers(): void {
  if (!config.backgroundWorker.enabled) {
    console.error('[BackgroundManager] Background workers are disabled by configuration.');
    return;
  }

  if (introspectionWorker) return;

  // 集約(Consolidation)と統合(Synthesis)を順次実行するタスクを作成
  // これにより、ストーリー化されたばかりのメモが即座にグラフに統合される流れを保証します
  const combinedTask = async () => {
    await consolidationTask();
    await synthesisTask();
  };

  introspectionWorker = new BackgroundWorker(
    'Introspection',
    combinedTask,
    config.backgroundWorker.intervalMs,
  );

  introspectionWorker.start();
  console.error('[BackgroundManager] All background workers started.');
}

/**
 * バックグラウンドプロセスを停止します。
 */
export function stopBackgroundWorkers(): void {
  if (introspectionWorker) {
    introspectionWorker.stop();
    introspectionWorker = null;
  }
}
