import { and, count, eq, sql } from 'drizzle-orm';
import { config } from '../../../config.js';
import { db } from '../../../db/index.js';
import { vibeMemories } from '../../../db/schema.js';
import { consolidateEpisodes } from '../../consolidation.js';

/**
 * ストーリー集約タスク。
 * 未処理の raw メモが一定数溜まっているセッションを自動的に見つけ出し、
 * 順次 consolidateEpisodes を実行します。
 */
export async function consolidationTask(): Promise<void> {
  const minRawCount = config.backgroundWorker.minRawCount;

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

  if (eligibleGroups.length === 0) {
    return;
  }

  console.error(
    `[ConsolidationTask] Found ${eligibleGroups.length} groups eligible for consolidation.`,
  );

  // 2. 各グループに対して集約を実行
  for (const group of eligibleGroups) {
    try {
      const taskLabel = group.sourceTask ? `task: ${group.sourceTask}` : 'general work';
      console.error(
        `[ConsolidationTask] Starting consolidation for session: ${group.sessionId} (${taskLabel}, ${group.count} raw memories)`,
      );

      const result = await consolidateEpisodes(group.sessionId, {
        minRawCount,
        sourceTask: group.sourceTask ?? undefined,
      });

      if (result) {
        console.error(
          `[ConsolidationTask] Successfully created episode: ${result.episodeId} for session: ${group.sessionId} (${taskLabel})`,
        );
      }
    } catch (err) {
      console.error(
        `[ConsolidationTask] Failed to consolidate session ${group.sessionId} (task: ${group.sourceTask}):`,
        err,
      );
    }
  }
}
