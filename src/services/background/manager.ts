import { config } from '../../config.js';
import { processQueue } from './runner.js';
import { scheduler } from './scheduler.js';

let intervalId: Timer | null = null;
let isProcessing = false;

/**
 * すべてのバックグラウンドプロセスを管理するマネージャー。
 */
export function startBackgroundWorkers(): void {
  if (!config.backgroundWorker.enabled) {
    console.error('[BackgroundManager] Background workers are disabled by configuration.');
    return;
  }

  if (intervalId) return;

  const tick = async () => {
    if (isProcessing) return;
    isProcessing = true;

    try {
      console.error('[BackgroundManager] Ticking unified background scheduler...');

      // 定期タスクの登録/更新 (ID固定で重複排除)
      // 5分ごとにキューに積む (実際には status='pending' なら REPLACE される)
      await scheduler.enqueue('consolidation', {}, { id: 'periodic-consolidation', priority: 10 });
      await scheduler.enqueue('synthesis', {}, { id: 'periodic-synthesis', priority: 10 });
      await scheduler.enqueue(
        'embedding_batch',
        { batchSize: 50 },
        { id: 'periodic-embedding', priority: 20 },
      );
      await scheduler.enqueue('knowflow', {}, { id: 'periodic-knowflow', priority: 5 });

      // キューを消化
      await processQueue();
    } catch (error) {
      console.error('[BackgroundManager] Error during background tick:', error);
    } finally {
      isProcessing = false;
    }
  };

  // 初回実行
  tick();

  // 定期実行
  intervalId = setInterval(tick, config.backgroundWorker.intervalMs);
  console.error(
    `[BackgroundManager] Unified background worker started (interval: ${config.backgroundWorker.intervalMs}ms).`,
  );
}

/**
 * バックグラウンドプロセスを停止します。
 */
export function stopBackgroundWorkers(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
