import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLocalLlmRetriever } from '../../adapters/retriever/mcpRetriever.js';
// KnowFlow 関連のインポート (Port from scripts/worker.ts)
import { config } from '../../config.js';
import { db as defaultDb } from '../../db/index.js';
import { withGlobalSemaphore } from '../../utils/lock.js';
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
import { distillSessionKnowledge } from '../sessionSummary/engine.js';
import { scheduler } from './scheduler.js';
import { embeddingBatchTask } from './tasks/embeddingBatchTask.js';
import { synthesisTask } from './tasks/synthesisTask.js';

interface TaskPayload {
  batchSize?: number;
  maxFailures?: number;
  sessionId?: string;
  force?: boolean;
  promote?: boolean;
  provider?: 'auto' | 'deterministic' | 'local' | 'openai' | 'bedrock';
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

type BackgroundTaskRunRecord = {
  taskId: string;
  taskType: string;
  ok: boolean;
  processed?: boolean;
  summary?: string;
  error?: string;
  stats?: Record<string, unknown>;
};

type ProcessQueueDeps = {
  database: typeof defaultDb;
  runWorkerOnce?: typeof runWorkerOnce;
  runKeywordSeederOnce?: typeof runKeywordSeederOnce;
  recordBackgroundTaskRun?: (input: BackgroundTaskRunRecord) => Promise<void>;
};

async function recordBackgroundTaskRun(input: BackgroundTaskRunRecord): Promise<void> {
  const logPath = join(process.cwd(), 'logs', 'runs', 'background-manager.jsonl');
  const payload = {
    ts: new Date().toISOString(),
    runId: 'background-manager',
    event: input.ok ? 'background.task.completed' : 'background.task.failed',
    data: input,
  };

  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(payload)}\n`);
  } catch (error) {
    console.error('[TaskRunner] Failed to record background task run:', error);
  }
}

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
      const processed = result.phrases > 0 || result.enqueued > 0 || result.skipped > 0;

      return {
        ok: true,
        processed,
        summary: `sources=${result.sources} phrases=${result.phrases} enqueued=${result.enqueued} skipped=${result.skipped} deduped=${result.deduped}`,
        partialFailures: 0,
        stats: result,
      };
    }

    case 'session_distillation': {
      const sessionId =
        typeof payload.sessionId === 'string' && payload.sessionId.trim().length > 0
          ? payload.sessionId.trim()
          : null;
      if (!sessionId) {
        return {
          ok: false,
          processed: true,
          summary: 'sessionId is required for session_distillation task',
          partialFailures: 1,
          error: 'sessionId is required',
        };
      }

      const result = await distillSessionKnowledge({
        sessionId,
        force: payload.force === true,
        promote: payload.promote === true,
        provider: payload.provider,
      });

      return {
        ok: result.status === 'succeeded',
        processed: true,
        summary: `session=${result.sessionKey} status=${result.status} keep=${
          result.keptCount
        } drop=${result.droppedCount} promoted=${result.promotedCount}${
          result.errorKind ? ` errorKind=${result.errorKind}` : ''
        }`,
        partialFailures: result.status === 'succeeded' ? 0 : 1,
        error: result.errorKind
          ? `${result.errorKind}${result.error ? `: ${result.error}` : ''}`
          : result.error,
        stats: {
          distillationId: result.distillationId,
          turnCount: result.turnCount,
          messageCount: result.messageCount,
          modelProvider: result.modelProvider,
          errorKind: result.errorKind,
        },
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
 * KnowFlow のイテレーションを実行します。
 * スループット向上のため、1回の起動で最大10タスクまで連続して処理を試みます。
 */
async function runKnowFlowIteration(
  database: typeof defaultDb = defaultDb,
  customRunWorkerOnce?: typeof runWorkerOnce,
): Promise<RunOnceResult> {
  const queueRepository = new PgJsonbQueueRepository(database);
  const knowledgeRepository = new PgKnowledgeRepository({}, database);
  const retriever = createLocalLlmRetriever(config.localLlmPath);
  try {
    const evidenceProvider = createMcpEvidenceProvider(retriever, {
      llmConfig: config.knowflow.llm,
      getExistingKnowledge: (topic) => knowledgeRepository.getByTopic(topic),
    });
    const handler = createKnowFlowTaskHandler({
      evidenceProvider,
    });

    const runOnce = customRunWorkerOnce ?? runWorkerOnce;
    const MAX_TASKS_PER_ITERATION = 10;
    let processedCount = 0;
    let lastResult: RunOnceResult = { processed: false };

    for (let i = 0; i < MAX_TASKS_PER_ITERATION; i++) {
      const result = await runOnce(queueRepository, handler, {
        workerId: `background-manager-${process.pid}`,
      });

      if (!result.processed) {
        break;
      }

      processedCount++;
      lastResult = result;

      // もしタスクが失敗（タイムアウト等）した場合は、一旦止めて次の tick に譲る
      if (result.status === 'failed') {
        break;
      }
    }

    // 1つでも処理した場合は processed: true を返す
    if (processedCount > 0) {
      return {
        processed: true,
        taskId:
          processedCount > 1
            ? `multi-batch (${processedCount})`
            : lastResult.processed
              ? lastResult.taskId
              : 'unknown',
        status: lastResult.processed ? lastResult.status : 'done',
        error: lastResult.processed ? lastResult.error : undefined,
      };
    }

    return { processed: false };
  } finally {
    // NOTE: Singleton retriever is now managed globally.
    // We don't disconnect here to keep the process alive and reuse it.
  }
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
  deps: ProcessQueueDeps = { database: defaultDb },
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
                () => reject(new Error('Task execution timed out after 600000ms')),
                10 * 60 * 1000,
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

            await (deps.recordBackgroundTaskRun ?? recordBackgroundTaskRun)({
              taskId: task.id,
              taskType: task.type,
              ok: true,
              processed: outcome.processed,
              summary: outcome.summary,
              stats: outcome.stats,
            });
            customScheduler.updateTaskStatus(task.id, 'completed');
            customScheduler.deleteTask(task.id);
          } catch (error) {
            console.error(`[TaskRunner] Task ${task.id} (${task.type}) failed:`, error);

            const errorMessage =
              error instanceof Error ? `${error.message}\n${error.stack}` : String(error);

            await (deps.recordBackgroundTaskRun ?? recordBackgroundTaskRun)({
              taskId: task.id,
              taskType: task.type,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
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
