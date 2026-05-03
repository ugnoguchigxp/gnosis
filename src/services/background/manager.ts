import { createLocalLlmRetriever } from '../../adapters/retriever/mcpRetriever.js';
import { config, envBoolean } from '../../config.js';
import { GNOSIS_CONSTANTS } from '../../constants.js';
import { withGlobalSemaphore } from '../../utils/lock.js';
import { PgKnowledgeRepository } from '../knowflow/knowledge/repository.js';
import { checkLlmHealth } from '../knowflow/ops/healthCheck.js';
import { defaultStructuredLogger } from '../knowflow/ops/logger.js';
import { PgJsonbQueueRepository } from '../knowflow/queue/pgJsonbRepository.js';
import {
  createKnowFlowTaskHandler,
  createMcpEvidenceProvider,
} from '../knowflow/worker/knowFlowHandler.js';
import { runWorkerOnce } from '../knowflow/worker/loop.js';

let intervalId: Timer | null = null;
let isProcessing = false;
let lastTickStart = 0;
let startupInFlight = false;
let startupToken = 0;
const queueRepository = new PgJsonbQueueRepository();
const knowledgeRepository = new PgKnowledgeRepository();
const retriever = createLocalLlmRetriever(config.localLlmPath);
const evidenceProvider = createMcpEvidenceProvider(retriever, {
  llmConfig: config.knowflow.llm,
  logger: defaultStructuredLogger,
});
const handler = createKnowFlowTaskHandler({
  repository: knowledgeRepository,
  queueRepository,
  evidenceProvider,
  budget: config.knowflow.budget,
  logger: defaultStructuredLogger,
});

/**
 * すべてのバックグラウンドプロセスを管理するマネージャー。
 */
export function startBackgroundWorkers(): void {
  const automationEnabled = envBoolean(
    process.env.GNOSIS_ENABLE_AUTOMATION,
    GNOSIS_CONSTANTS.AUTOMATION_ENABLED_DEFAULT,
  );
  if (!automationEnabled) {
    console.error('[BackgroundManager] Automation is OFF. Skipping background worker startup.');
    return;
  }

  if (!config.backgroundWorker.enabled) {
    console.error('[BackgroundManager] Background workers are disabled by configuration.');
    return;
  }

  if (intervalId || startupInFlight) return;
  startupInFlight = true;
  const token = ++startupToken;

  void (async () => {
    const health = await checkLlmHealth(config.knowflow.llm, defaultStructuredLogger).catch(
      () => null,
    );
    if (!health?.ok) {
      console.error(
        '[BackgroundManager] Local LLM health check failed. Skip timer startup until LLM recovers.',
      );
      startupInFlight = false;
      return;
    }
    if (token !== startupToken) {
      startupInFlight = false;
      return;
    }

    const tick = async () => {
      try {
        await queueRepository.clearStaleTasks(config.knowflow.worker.cronRunWindowMs);

        // topic_tasks に system task を投入（単一キュー運用）
        await queueRepository.enqueue({
          topic: '__system__/synthesis',
          mode: 'directed',
          source: 'cron',
          requestedBy: 'background-manager',
          sourceGroup: 'system/synthesis',
          priority: 90,
          metadata: {
            systemTask: {
              type: 'synthesis',
              payload: { maxFailures: 0 },
            },
          },
        });
        await queueRepository.enqueue({
          topic: '__system__/embedding_batch',
          mode: 'directed',
          source: 'cron',
          requestedBy: 'background-manager',
          sourceGroup: 'system/embedding_batch',
          priority: 91,
          metadata: {
            systemTask: {
              type: 'embedding_batch',
              payload: { batchSize: 50 },
            },
          },
        });
      } catch (enqueueError) {
        console.error('[BackgroundManager] Error during periodic enqueue:', enqueueError);
      }

      if (isProcessing) {
        if (Date.now() - lastTickStart > 60 * 60 * 1000) {
          console.error(
            '[BackgroundManager] Watchdog: Previous tick hung for >1h. Resetting flag.',
          );
          isProcessing = false;
        } else {
          return;
        }
      }

      isProcessing = true;
      lastTickStart = Date.now();

      try {
        console.error('[BackgroundManager] Ticking unified topic queue worker...');
        await withGlobalSemaphore(
          'background-task',
          config.backgroundWorker.maxConcurrency,
          async () => {
            const MAX_TASKS_PER_TICK = 10;
            for (let i = 0; i < MAX_TASKS_PER_TICK; i += 1) {
              const result = await runWorkerOnce(queueRepository, handler, {
                workerId: `background-manager-${process.pid}`,
              });
              if (!result.processed) break;
              if (result.status === 'failed') break;
            }
          },
          1_000,
        );
      } catch (error) {
        console.error('[BackgroundManager] Error during background tick:', error);
      } finally {
        isProcessing = false;
      }
    };

    // 初回実行
    tick();

    // 定期実行
    if (token !== startupToken || intervalId) {
      startupInFlight = false;
      return;
    }
    intervalId = setInterval(tick, config.backgroundWorker.intervalMs);
    startupInFlight = false;
    console.error(
      `[BackgroundManager] Unified background worker started (interval: ${config.backgroundWorker.intervalMs}ms).`,
    );
  })().catch((error) => {
    startupInFlight = false;
    console.error('[BackgroundManager] Startup error:', error);
  });
}

/**
 * バックグラウンドプロセスを停止します。
 */
export function stopBackgroundWorkers(): void {
  startupToken += 1;
  startupInFlight = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
