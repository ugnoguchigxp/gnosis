import { resolve } from 'node:path';
import { createLocalLlmRetriever } from '../adapters/retriever/mcpRetriever.js';
import { config } from '../config.js';
import { PgKnowledgeRepository } from '../services/knowflow/knowledge/repository.js';
import { checkLlmHealth } from '../services/knowflow/ops/healthCheck.js';
import { createRunLogger } from '../services/knowflow/ops/runLog.js';
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

  // LLMの生存確認（ヘルスチェック）
  const health = await checkLlmHealth(config.knowflow.llm, logger);
  if (!health.ok) {
    console.error(
      '--- Critical: LLM Health Check Failed. Checking configuration and environment... ---',
    );
  }

  try {
    // 常にループを回すが、LLMリソースの同時実行数は制限する
    await runWorkerLoop(queueRepository, handler, {
      workerId: `daemon-${process.pid}`,
      intervalMs: config.knowflow.worker.pollIntervalMs, // Configurable interval
      logger,
      // runWorkerOnce の実行をラップして、独自プロセスでもセマフォを共有する
      runOnceWrapper: async (fn) => {
        try {
          return await withGlobalSemaphore(
            'background-task',
            config.backgroundWorker.maxConcurrency,
            fn,
            1000, // タイムアウト時は次回のイテレーションに回す
          );
        } catch (err) {
          if (err instanceof Error && err.message.includes('Global lock timeout')) {
            return { processed: false }; // セマフォ取得失敗時は「未処理」として扱う
          }
          throw err;
        }
      },
    });
  } catch (error) {
    console.error('Worker Daemon Critical Error:', error);
    process.exit(1);
  }
}

main();
