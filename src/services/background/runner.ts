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
import type { KeywordSeederRunResult } from '../knowflow/cron/types.js';
import { PgKnowledgeRepository } from '../knowflow/knowledge/repository.js';
import { PgJsonbQueueRepository } from '../knowflow/queue/pgJsonbRepository.js';
import {
  createKnowFlowTaskHandler,
  createMcpEvidenceProvider,
} from '../knowflow/worker/knowFlowHandler.js';
import { runWorkerOnce } from '../knowflow/worker/loop.js';
import type { RunOnceResult } from '../knowflow/worker/loop.js';

interface TaskPayload {
  batchSize?: number;
  maxFailures?: number;
  [key: string]: unknown;
}

export type TaskOutcome = {
  ok: boolean;
  processed: boolean;
  summary: string;
  partialFailures: number;
  error?: string;
  stats?: Record<string, unknown>;
};

const readNonNegativeInt = (value: unknown): number | undefined => {
  const raw =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(raw)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(raw));
};

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
): Promise<TaskOutcome> {
  console.error(`[TaskRunner] Executing task: ${type}`);

  switch (type) {
    case 'consolidation': {
      const maxFailures = readNonNegativeInt(payload.maxFailures) ?? 0;
      const result = await consolidationTask({ maxFailures });
      return {
        ok: true,
        processed: result.attemptedGroups > 0,
        summary: `eligible=${result.eligibleGroups} attempted=${result.attemptedGroups} succeeded=${result.succeededGroups} skipped=${result.skippedGroups} failed=${result.failedGroups} episodes=${result.createdEpisodes}`,
        partialFailures: result.failedGroups,
        stats: result,
      };
    }

    case 'synthesis': {
      const maxFailures = readNonNegativeInt(payload.maxFailures) ?? 0;
      const result = await synthesisTask({ maxFailures });
      return {
        ok: true,
        processed: result.processedMemories > 0 || result.failedCount > 0,
        summary: `processed=${result.processedMemories} entities=${result.extractedEntities} relations=${result.extractedRelations} failed=${result.failedCount}`,
        partialFailures: result.failedCount,
        stats: result,
      };
    }

    case 'embedding_batch': {
      const batchSize = readNonNegativeInt(payload.batchSize) ?? 20;
      const result = await embeddingBatchTask(batchSize);
      return {
        ok: true,
        processed: result.processed > 0,
        summary: `processed=${result.processed}`,
        partialFailures: 0,
        stats: result,
      };
    }

    case 'knowflow': {
      const result = await runKnowFlowIteration(deps.database, deps.runWorkerOnce);
      return mapKnowflowRunOnceResult(result);
    }

    case 'knowflow_keyword_seed': {
      const result = await runKnowFlowKeywordSeedIteration(
        deps.database,
        deps.runKeywordSeederOnce,
      );
      const sourceFailures = readNonNegativeInt(result.sourceFailures) ?? 0;
      const processed =
        result.evaluated > 0 || result.enqueued > 0 || result.skipped > 0 || sourceFailures > 0;

      return {
        ok: sourceFailures === 0,
        processed,
        summary: `sources=${result.sources} evaluated=${result.evaluated} enqueued=${result.enqueued} skipped=${result.skipped} deduped=${result.deduped} sourceFailures=${sourceFailures}`,
        partialFailures: sourceFailures,
        error:
          sourceFailures > 0
            ? `${sourceFailures} source(s) failed during keyword seeding`
            : undefined,
        stats: result,
      };
    }

    default:
      throw new Error(`Unknown task type: ${type}`);
  }
}

function mapKnowflowRunOnceResult(result: RunOnceResult): TaskOutcome {
  if (!result.processed) {
    return {
      ok: true,
      processed: false,
      summary: 'No runnable knowflow tasks in queue.',
      partialFailures: 0,
    };
  }

  if (result.status === 'done') {
    return {
      ok: true,
      processed: true,
      summary: `Processed knowflow task ${result.taskId} successfully.`,
      partialFailures: 0,
    };
  }

  return {
    ok: false,
    processed: true,
    summary: `Knowflow task ${result.taskId} ended with status=${result.status}.`,
    partialFailures: 1,
    error: result.error,
  };
}

/**
 * KnowFlow の1イテレーションを実行します。
 */
async function runKnowFlowIteration(
  database: typeof defaultDb = defaultDb,
  customRunWorkerOnce?: typeof runWorkerOnce,
): Promise<RunOnceResult> {
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
  return await runOnce(queueRepository, handler, {
    workerId: `background-manager-${process.pid}`,
  });
}

async function runKnowFlowKeywordSeedIteration(
  database: typeof defaultDb = defaultDb,
  customRunKeywordSeederOnce?: typeof runKeywordSeederOnce,
): Promise<KeywordSeederRunResult> {
  const runSeeder = customRunKeywordSeederOnce ?? runKeywordSeederOnce;
  return await runSeeder({ database });
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
            hasMoreTasks = false;
            return;
          }

          try {
            // 個別タスクにハードタイムアウト (30分) を設定
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const timeoutSignal = new Promise<TaskOutcome>((_, reject) => {
              timeoutId = setTimeout(
                () => reject(new Error('Task execution timed out after 1800000ms')),
                30 * 60 * 1000,
              );
            });

            let outcome: TaskOutcome;
            try {
              outcome = await Promise.race([
                runTask(task.type, JSON.parse(task.payload) as TaskPayload, deps),
                timeoutSignal,
              ]);
            } finally {
              if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
              }
            }

            if (!outcome.ok) {
              const detail = outcome.error ? ` error=${outcome.error}` : '';
              throw new Error(`Task outcome failed: ${outcome.summary}.${detail}`);
            }

            if (outcome.partialFailures > 0) {
              console.error(
                `[TaskRunner] Task ${task.id} (${task.type}) completed with partial failures: ${outcome.partialFailures}. ${outcome.summary}`,
              );
            } else {
              console.error(
                `[TaskRunner] Task ${task.id} (${task.type}) completed. ${outcome.summary}`,
              );
            }

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
