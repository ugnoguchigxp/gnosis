import { resolve } from 'node:path';
// Set process title for easier identification
process.title = 'gnosis-worker';
import { createLocalLlmRetriever } from '../adapters/retriever/mcpRetriever.js';
import { config, envBoolean, envNumber } from '../config.js';
import { GNOSIS_CONSTANTS } from '../constants.js';

// Add diagnostic info to environment
process.env.GNOSIS_PROCESS_INFO = `Started:${new Date().toISOString()} | PPID:${
  process.ppid
} | CMD:${process.argv.join(' ')}`;
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
import { notifyTaskEnd, notifyTaskStart } from '../supervisor/client.js';
import { withGlobalSemaphore } from '../utils/lock.js';

async function main() {
  const automationEnabled = envBoolean(
    process.env.GNOSIS_ENABLE_AUTOMATION,
    GNOSIS_CONSTANTS.AUTOMATION_ENABLED_DEFAULT,
  );
  if (!automationEnabled) {
    console.error('[Worker] Automation is OFF. Skipping daemon startup.');
    process.exit(0);
  }

  const runLogger = await createRunLogger({ runId: `worker-daemon-${Date.now()}` });
  let healthReportTimer: ReturnType<typeof setInterval> | undefined;
  let shutdownRequested = false;
  let shutdownReason = 'normal';

  const requestShutdown = (reason: string) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    shutdownReason = reason;
    console.error(
      `\n--- Gnosis Worker Graceful Shutdown Requested (${reason}, PID: ${process.pid}) ---`,
    );
  };

  process.on('SIGINT', () => requestShutdown('SIGINT'));
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));

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
  await notifyTaskStart(process.title).catch(() => {});

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
    queueRepository,
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
  const orphanClearedCount = await queueRepository.clearOrphanedRunningTasks([
    `daemon-${process.pid}-`,
  ]);
  if (orphanClearedCount > 0) {
    logger({
      event: 'worker.startup.orphan_cleanup',
      clearedCount: orphanClearedCount,
      level: 'warn',
    });
  }

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
    // ワーカーは並列に走らせ、空きスロットがあれば pending を即時処理する。
    const workerParallelism = Math.max(
      1,
      Math.min(config.knowflow.worker.parallelism, config.backgroundWorker.maxConcurrency),
    );
    const workers = Array.from({ length: workerParallelism }, (_, index) => {
      const workerIndex = index + 1;
      return runWorkerLoop(queueRepository, handler, {
        workerId: `daemon-${process.pid}-${workerIndex}`,
        intervalMs: config.knowflow.worker.pollIntervalMs,
        postTaskDelayMs: 0,
        shouldStop: () => shutdownRequested,
        logger,
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
              1000,
            );
            return result;
          } catch (err) {
            if (err instanceof Error && err.message.includes('Global lock timeout')) {
              runtimeMonitor.recordSemaphoreWait(Date.now() - lockWaitStartedAt, true);
              runtimeMonitor.emitIfDue();
              return { processed: false };
            }
            throw err;
          }
        },
      });
    });
    await Promise.all(workers);
  } catch (error) {
    fatalError = error;
    console.error('Worker Daemon Critical Error:', error);
  } finally {
    runtimeMonitor.emitIfDue();
    if (healthReportTimer) {
      clearInterval(healthReportTimer);
    }
    await notifyTaskEnd().catch(() => {});
    console.error(
      `--- Gnosis Worker Shutdown Complete (Reason: ${
        fatalError ? 'fatal_error' : shutdownReason
      }, PID: ${process.pid}) ---`,
    );
    await runLogger.flush();
  }

  if (fatalError) {
    process.exit(1);
  }
}

main();
