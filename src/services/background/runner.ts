import { db as defaultDb } from '../../db/index.js';
import { withGlobalSemaphore } from '../../utils/lock.js';
import { scheduler } from './scheduler.js';
import { consolidationTask } from './tasks/consolidationTask.js';
import { embeddingBatchTask } from './tasks/embeddingBatchTask.js';
import { synthesisTask } from './tasks/synthesisTask.js';

import { createLocalLlmRetriever } from '../../adapters/retriever/mcpRetriever.js';
// KnowFlow 関連のインポート (Port from scripts/worker.ts)
import { config } from '../../config.js';
import { runKeywordSeederOnce } from '../knowflow/cron/keywordSeeder.js';
import { PgKnowledgeRepository } from '../knowflow/knowledge/repository.js';
import { PgJsonbQueueRepository } from '../knowflow/queue/pgJsonbRepository.js';
import {
  createKnowFlowTaskHandler,
  createMcpEvidenceProvider,
} from '../knowflow/worker/knowFlowHandler.js';
import { runWorkerOnce } from '../knowflow/worker/loop.js';

interface TaskPayload {
  batchSize?: number;
  [key: string]: unknown;
}

/**
 * 登録されたタスクタイプを実行関数にマップします。
 */
export async function runTask(
  type: string,
  payload: TaskPayload,
  deps: {
    database: typeof defaultDb;
    runWorkerOnce?: typeof runWorkerOnce;
    runKeywordSeederOnce?: typeof runKeywordSeederOnce;
  } = {
    database: defaultDb,
  },
): Promise<void> {
  console.error(`[TaskRunner] Executing task: ${type}`);

  switch (type) {
    case 'consolidation':
      await consolidationTask();
      break;

    case 'synthesis':
      await synthesisTask();
      break;

    case 'embedding_batch':
      await embeddingBatchTask(payload.batchSize || 20);
      break;

    case 'knowflow':
      await runKnowFlowIteration(deps.database, deps.runWorkerOnce);
      break;
    case 'knowflow_keyword_seed':
      await runKnowFlowKeywordSeedIteration(deps.database, deps.runKeywordSeederOnce);
      break;

    default:
      throw new Error(`Unknown task type: ${type}`);
  }
}

/**
 * KnowFlow の1イテレーションを実行します。
 */
async function runKnowFlowIteration(
  database: typeof defaultDb = defaultDb,
  customRunWorkerOnce?: typeof runWorkerOnce,
) {
  const queueRepository = new PgJsonbQueueRepository(database);
  const knowledgeRepository = new PgKnowledgeRepository({}, database);
  const retriever = createLocalLlmRetriever(config.localLlmPath);
  const evidenceProvider = createMcpEvidenceProvider(retriever, {
    llmConfig: config.knowflow.llm,
  });
  const handler = createKnowFlowTaskHandler({
    repository: knowledgeRepository,
    evidenceProvider,
    budget: config.knowflow.budget,
  });

  const runOnce = customRunWorkerOnce ?? runWorkerOnce;

  // runWorkerOnce 自体も内部で LLM を呼び出すため、
  // Semaphore は LLM サービス側 (llm.ts, memory.ts) で制御される前提
  await runOnce(queueRepository, handler, {
    workerId: `background-manager-${process.pid}`,
  });
}

async function runKnowFlowKeywordSeedIteration(
  database: typeof defaultDb = defaultDb,
  customRunKeywordSeederOnce?: typeof runKeywordSeederOnce,
) {
  const runSeeder = customRunKeywordSeederOnce ?? runKeywordSeederOnce;
  await runSeeder({ database });
}

/**
 * スケジューラーからタスクを取得して実行するメインループ
 */
export async function processQueue(
  customScheduler = scheduler,
  deps: { database: typeof defaultDb } = { database: defaultDb },
) {
  // 30分以上経過した停滞タスクをリセット
  customScheduler.cleanupStaleTasks();

  let hasMoreTasks = true;
  while (hasMoreTasks) {
    const runningCount = customScheduler.getRunningTaskCount();
    if (runningCount > 0) {
      console.error(`[TaskRunner] Status: ${runningCount} tasks currently running.`);
    }

    // システム全体の同時実行数制限 (Local LLM の多重起動抑制)
    // セマフォの取得を試みる
    try {
      await withGlobalSemaphore(
        'background-task',
        config.backgroundWorker.maxConcurrency,
        async () => {
          // アトミックにタスクを取得 (取得できた時点で status = 'running' となっている)
          const task = await customScheduler.dequeueTask();
          if (!task) {
            // タスクがなければループを抜けるためのフラグを外側のスコープに渡す必要があるが、
            // ここではシンプルに一度 null を返して外側で break するように制御しやすくリファクタリングする
            hasMoreTasks = false;
            return;
          }

          try {
            await runTask(task.type, JSON.parse(task.payload) as TaskPayload, deps);
            customScheduler.updateTaskStatus(task.id, 'completed');
            customScheduler.deleteTask(task.id);
          } catch (error) {
            console.error(`[TaskRunner] Task ${task.id} (${task.type}) failed:`, error);

            const errorMessage =
              error instanceof Error ? `${error.message}\n${error.stack}` : String(error);

            const nextRetry = Date.now() + 5 * 60 * 1000;
            customScheduler.updateTaskStatus(task.id, 'failed', errorMessage, nextRetry);
          }
        },
        // タイムアウトを短めに設定 (他のプロセスが実行中なら今回はスキップして次回の tick に任せる)
        1000,
      );
    } catch (semaphoreError) {
      if (
        semaphoreError instanceof Error &&
        semaphoreError.message.includes('Global lock timeout')
      ) {
        console.error(
          `[TaskRunner] Concurrency limit reached (${config.backgroundWorker.maxConcurrency}). Skipping this iteration.`,
        );
        break;
      }
      throw semaphoreError;
    }

    if (!hasMoreTasks) break;
  }
}
