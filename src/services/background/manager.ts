import { config } from '../../config.js';
import { processQueue } from './runner.js';
import { scheduler } from './scheduler.js';

let intervalId: Timer | null = null;
let isProcessing = false;
let lastTickStart = 0;

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
    try {
      // 定期タスクの登録/更新 (ID固定で重複排除)
      await scheduler.enqueue('consolidation', {}, { id: 'periodic-consolidation', priority: 10 });
      await scheduler.enqueue('synthesis', {}, { id: 'periodic-synthesis', priority: 10 });
      await scheduler.enqueue(
        'embedding_batch',
        { batchSize: 50 },
        { id: 'periodic-embedding', priority: 20 },
      );
      await scheduler.enqueue('knowflow', {}, { id: 'periodic-knowflow', priority: 5 });
      await scheduler.enqueue(
        'knowflow_keyword_seed',
        {},
        { id: 'periodic-knowflow-keyword-seed', priority: 15 },
      );
      await scheduler.enqueue(
        'hook_candidate_promotion',
        {},
        { id: 'periodic-hook-candidate-promotion', priority: 12 },
      );
    } catch (enqueueError) {
      console.error('[BackgroundManager] Error during periodic enqueue:', enqueueError);
    }

    if (isProcessing) {
      if (Date.now() - lastTickStart > 60 * 60 * 1000) {
        console.error('[BackgroundManager] Watchdog: Previous tick hung for >1h. Resetting flag.');
        isProcessing = false;
      } else {
        return;
      }
    }

    isProcessing = true;
    lastTickStart = Date.now();

    try {
      console.error('[BackgroundManager] Ticking unified background scheduler...');
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
