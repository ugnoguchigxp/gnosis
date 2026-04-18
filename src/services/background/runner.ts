import { withGlobalSemaphore } from '../../utils/lock.js';
import { scheduler } from './scheduler.js';
import { consolidationTask } from './tasks/consolidationTask.js';
import { embeddingBatchTask } from './tasks/embeddingBatchTask.js';
import { synthesisTask } from './tasks/synthesisTask.js';

import { createLocalLlmRetriever } from '../../adapters/retriever/mcpRetriever.js';
// KnowFlow 関連のインポート (Port from scripts/worker.ts)
import { config } from '../../config.js';
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
export async function runTask(type: string, payload: TaskPayload): Promise<void> {
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
      await runKnowFlowIteration();
      break;

    default:
      throw new Error(`Unknown task type: ${type}`);
  }
}

/**
 * KnowFlow の1イテレーションを実行します。
 */
async function runKnowFlowIteration() {
  const queueRepository = new PgJsonbQueueRepository();
  const knowledgeRepository = new PgKnowledgeRepository();
  const retriever = createLocalLlmRetriever(config.localLlmPath);
  const evidenceProvider = createMcpEvidenceProvider(retriever, {
    llmConfig: config.knowflow.llm,
  });
  const handler = createKnowFlowTaskHandler({
    repository: knowledgeRepository,
    evidenceProvider,
    budget: config.knowflow.budget,
  });

  // runWorkerOnce 自体も内部で LLM を呼び出すため、
  // Semaphore は LLM サービス側 (llm.ts, memory.ts) で制御される前提
  await runWorkerOnce(queueRepository, handler, {
    workerId: `background-manager-${process.pid}`,
  });
}

/**
 * スケジューラーからタスクを取得して実行するメインループ
 */
export async function processQueue() {
  // 30分以上経過した停滞タスクをリセット
  scheduler.cleanupStaleTasks();

  while (true) {
    const runningCount = scheduler.getRunningTaskCount();
    if (runningCount > 0) {
      console.error(`[TaskRunner] Status: ${runningCount} tasks currently running.`);
    }

    const task = await scheduler.getNextTask();
    if (!task) break;

    try {
      scheduler.updateTaskStatus(task.id, 'running');
      await runTask(task.type, JSON.parse(task.payload) as TaskPayload);
      scheduler.updateTaskStatus(task.id, 'completed');

      // 完了した定期タスクは削除して次のスケジュールを待つ
      // (もしくは status = 'completed' のままにして履歴とする)
      // ここではシンプルに削除せず、定期実行タスクの場合は後で再登録される
      scheduler.deleteTask(task.id);
    } catch (error) {
      console.error(`[TaskRunner] Task ${task.id} (${task.type}) failed:`, error);
      scheduler.updateTaskStatus(
        task.id,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
