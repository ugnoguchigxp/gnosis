import { resolve } from 'node:path';
import { createLocalLlmRetriever } from '../adapters/retriever/mcpRetriever.js';
import { config, envNumber } from '../config.js';
import { PgKnowledgeRepository } from '../services/knowflow/knowledge/repository.js';
import { checkLlmHealth } from '../services/knowflow/ops/healthCheck.js';
import { createRunLogger } from '../services/knowflow/ops/runLog.js';
import { WorkerRuntimeMonitor } from '../services/knowflow/ops/runtimeMonitor.js';
import { PgJsonbQueueRepository } from '../services/knowflow/queue/pgJsonbRepository.js';
import {
  createKnowFlowTaskHandler,
  createMcpEvidenceProvider,
} from '../services/knowflow/worker/knowFlowHandler.js';
import { runWorkerLoop } from '../services/knowflow/worker/loop.js';
import { withGlobalSemaphore } from '../utils/lock.js';

async function main() {
  const runLogger = await createRunLogger({ runId: `worker-daemon-${Date.now()}` });
  const logger = runLogger.createStructuredLogger({ verbose: true });
  const llmLogger = runLogger.createLlmLogger({ verbose: true });
  const healthCheckReportIntervalMs = Math.max(
    config.knowflow.healthCheck.timeoutMs,
    envNumber(process.env.KNOWFLOW_HEALTH_CHECK_REPORT_INTERVAL_MS, 300_000),
  );
  const runtimeMetricsWindowMs = Math.max(
    60_000,
    envNumber(process.env.KNOWFLOW_RUNTIME_METRICS_WINDOW_MS, 900_000),
  );
  const runtimeMetricsReportIntervalMs = Math.max(
    10_000,
    envNumber(process.env.KNOWFLOW_RUNTIME_METRICS_REPORT_INTERVAL_MS, 60_000),
  );
  const runtimeTaskTimeoutAlertThreshold = Math.max(
    1,
    envNumber(process.env.KNOWFLOW_RUNTIME_TASK_TIMEOUT_ALERT_THRESHOLD, 3),
  );
  const runtimeLockTimeoutAlertThreshold = Math.max(
    1,
    envNumber(process.env.KNOWFLOW_RUNTIME_LOCK_TIMEOUT_ALERT_THRESHOLD, 3),
  );
  const runtimeMonitor = new WorkerRuntimeMonitor({
    windowMs: runtimeMetricsWindowMs,
    reportIntervalMs: runtimeMetricsReportIntervalMs,
    taskTimeoutAlertThreshold: runtimeTaskTimeoutAlertThreshold,
    lockTimeoutAlertThreshold: runtimeLockTimeoutAlertThreshold,
    logger,
  });

  console.log('--- Gnosis KnowFlow Worker Daemon Start ---');

  const queueRepository = new PgJsonbQueueRepository();
  const knowledgeRepository = new PgKnowledgeRepository();

  // localLlm のパス解決 (config を使用)
  const retriever = createLocalLlmRetriever(config.localLlmPath);

  const evidenceProvider = createMcpEvidenceProvider(retriever, {
    logger,
    llmConfig: config.knowflow.llm,
    llmLogger,
  });

  const handler = createKnowFlowTaskHandler({
    repository: knowledgeRepository,
    evidenceProvider,
    budget: config.knowflow.budget,
    logger,
  });

  // 起動時にスタックしているタスクをクリーンアップ (1時間以上動きがないもの)
  const cleanedCount = await queueRepository.clearStaleTasks(
    config.knowflow.worker.cronRunWindowMs,
  );
  if (cleanedCount > 0) {
    logger({
      event: 'worker.startup.cleanup',
      clearedCount: cleanedCount,
      level: 'info',
    });
  }

  let healthReportTimer: ReturnType<typeof setInterval> | undefined;
  let healthCheckInFlight = false;
  const runHealthCheck = async (trigger: 'startup' | 'interval') => {
    if (healthCheckInFlight) {
      logger({
        event: 'worker.health_check.skipped',
        trigger,
        reason: 'in_flight',
        level: 'warn',
      });
      return;
    }
    healthCheckInFlight = true;
    const startedAt = Date.now();
    try {
      const health = await checkLlmHealth(config.knowflow.llm, logger);
      logger({
        event: 'worker.health_check.report',
        trigger,
        ok: health.ok,
        apiOk: health.details.api?.ok ?? null,
        cliOk: health.details.cli?.ok ?? null,
        durationMs: Date.now() - startedAt,
        level: health.ok ? 'info' : 'warn',
      });
      if (trigger === 'startup' && !health.ok) {
        console.error(
          '--- Critical: LLM Health Check Failed. Checking configuration and environment... ---',
        );
      }
    } catch (error) {
      logger({
        event: 'worker.health_check.error',
        trigger,
        message: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        level: 'error',
      });
      if (trigger === 'startup') {
        console.error(
          '--- Critical: LLM Health Check Failed. Checking configuration and environment... ---',
        );
      }
    } finally {
      healthCheckInFlight = false;
    }
  };

  await runHealthCheck('startup');
  healthReportTimer = setInterval(() => {
    void runHealthCheck('interval');
  }, healthCheckReportIntervalMs);
  healthReportTimer.unref?.();

  let fatalError: unknown;
  try {
    // 常にループを回すが、LLMリソースの同時実行数は制限する
    await runWorkerLoop(queueRepository, handler, {
      workerId: `daemon-${process.pid}`,
      intervalMs: config.knowflow.worker.pollIntervalMs, // Configurable interval
      logger,
      // runWorkerOnce の実行をラップして、独自プロセスでもセマフォを共有する
      runOnceWrapper: async (fn) => {
        const lockWaitStartedAt = Date.now();
        try {
          const result = await withGlobalSemaphore(
            'background-task',
            config.backgroundWorker.maxConcurrency,
            async () => {
              runtimeMonitor.recordSemaphoreWait(Date.now() - lockWaitStartedAt, false);
              const wrappedResult = await fn();
              runtimeMonitor.recordRunResult(wrappedResult);
              runtimeMonitor.emitIfDue();
              return wrappedResult;
            },
            1000, // タイムアウト時は次回のイテレーションに回す
          );
          return result;
        } catch (err) {
          if (err instanceof Error && err.message.includes('Global lock timeout')) {
            runtimeMonitor.recordSemaphoreWait(Date.now() - lockWaitStartedAt, true);
            runtimeMonitor.emitIfDue();
            return { processed: false }; // セマフォ取得失敗時は「未処理」として扱う
          }
          throw err;
        }
      },
    });
  } catch (error) {
    fatalError = error;
    console.error('Worker Daemon Critical Error:', error);
  } finally {
    runtimeMonitor.emitIfDue();
    if (healthReportTimer) {
      clearInterval(healthReportTimer);
    }
    await runLogger.flush();
  }

  if (fatalError) {
    process.exit(1);
  }
}

main();
