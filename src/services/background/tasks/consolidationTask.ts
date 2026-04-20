import { and, count, eq, sql } from 'drizzle-orm';
import { config } from '../../../config.js';
import { db } from '../../../db/index.js';
import { vibeMemories } from '../../../db/schema.js';
import { consolidateEpisodes } from '../../consolidation.js';

export type ConsolidationTaskOptions = {
  minRawCount?: number;
  maxFailures?: number;
};

export type ConsolidationTaskResult = {
  eligibleGroups: number;
  attemptedGroups: number;
  succeededGroups: number;
  skippedGroups: number;
  failedGroups: number;
  createdEpisodes: number;
  failures: Array<{
    sessionId: string;
    sourceTask: string | null;
    message: string;
  }>;
};

/**
 * ストーリー集約タスク。
 * 未処理の raw メモが一定数溜まっているセッションを自動的に見つけ出し、
 * 順次 consolidateEpisodes を実行します。
 */
export async function consolidationTask(
  options: ConsolidationTaskOptions = {},
): Promise<ConsolidationTaskResult> {
  const minRawCount = Math.max(
    1,
    Math.trunc(options.minRawCount ?? config.backgroundWorker.minRawCount),
  );
  const maxFailures = Math.max(0, Math.trunc(options.maxFailures ?? 0));

  // 1. 集約対象（未処理 raw メモが閾値以上の (session, task) ペア）を検索
  const eligibleGroups = await db
    .select({
      sessionId: vibeMemories.sessionId,
      sourceTask: vibeMemories.sourceTask,
      count: count(vibeMemories.id),
    })
    .from(vibeMemories)
    .where(and(eq(vibeMemories.memoryType, 'raw'), eq(vibeMemories.isSynthesized, false)))
    .groupBy(vibeMemories.sessionId, vibeMemories.sourceTask)
    .having(sql`count(${vibeMemories.id}) >= ${minRawCount}`);

  const taskResult: ConsolidationTaskResult = {
    eligibleGroups: eligibleGroups.length,
    attemptedGroups: 0,
    succeededGroups: 0,
    skippedGroups: 0,
    failedGroups: 0,
    createdEpisodes: 0,
    failures: [],
  };

  if (eligibleGroups.length === 0) {
    return taskResult;
  }

  console.error(
    `[ConsolidationTask] Found ${eligibleGroups.length} groups eligible for consolidation.`,
  );

  // 2. 各グループに対して集約を実行
  for (const group of eligibleGroups) {
    taskResult.attemptedGroups += 1;
    const taskLabel = group.sourceTask ? `task: ${group.sourceTask}` : 'general work';

    try {
      console.error(
        `[ConsolidationTask] Starting consolidation for session: ${group.sessionId} (${taskLabel}, ${group.count} raw memories)`,
      );

      const result = await consolidateEpisodes(group.sessionId, {
        minRawCount,
        sourceTask: group.sourceTask ?? undefined,
      });

      if (result) {
        taskResult.succeededGroups += 1;
        taskResult.createdEpisodes += 1;
        console.error(
          `[ConsolidationTask] Successfully created episode: ${result.episodeId} for session: ${group.sessionId} (${taskLabel})`,
        );
      } else {
        taskResult.skippedGroups += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      taskResult.failedGroups += 1;
      taskResult.failures.push({
        sessionId: group.sessionId,
        sourceTask: group.sourceTask ?? null,
        message,
      });
      console.error(
        `[ConsolidationTask] Failed to consolidate session ${group.sessionId} (${taskLabel}):`,
        err,
      );
    }
  }

  if (taskResult.failedGroups > maxFailures) {
    const failurePreview = taskResult.failures
      .slice(0, 3)
      .map((f) => `${f.sessionId}[${f.sourceTask ?? 'general'}]: ${f.message}`)
      .join(' | ');
    throw new Error(
      `[ConsolidationTask] failedGroups=${taskResult.failedGroups} exceeded maxFailures=${maxFailures}. ${failurePreview}`,
    );
  }

  return taskResult;
}
