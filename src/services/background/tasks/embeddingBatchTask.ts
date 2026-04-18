import { and, isNull, sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { entities, experienceLogs, vibeMemories } from '../../../db/schema.js';
import { withGlobalSemaphore } from '../../../utils/lock.js';
import { generateEmbedding } from '../../memory.js';

/**
 * 埋め込みベクトルが欠損しているレコードを特定し、一括で生成します。
 */
export async function embeddingBatchTask(batchSize = 20): Promise<{ processed: number }> {
  let totalProcessed = 0;

  // 1. Vibe Memories の欠損確認
  const pendingMemories = await db
    .select({ id: vibeMemories.id, content: vibeMemories.content })
    .from(vibeMemories)
    .where(isNull(vibeMemories.embedding))
    .limit(batchSize);

  for (const mem of pendingMemories) {
    await withGlobalSemaphore('heavy-model', 2, async () => {
      const embedding = await generateEmbedding(mem.content);
      await db.update(vibeMemories).set({ embedding }).where(sql`id = ${mem.id}`);
      totalProcessed++;
    });
  }

  // 2. Entities の欠損確認
  const pendingEntities = await db
    .select({ id: entities.id, name: entities.name, description: entities.description })
    .from(entities)
    .where(isNull(entities.embedding))
    .limit(batchSize);

  for (const ent of pendingEntities) {
    await withGlobalSemaphore('heavy-model', 2, async () => {
      const text = `${ent.name}: ${ent.description || ''}`;
      const embedding = await generateEmbedding(text);
      await db.update(entities).set({ embedding }).where(sql`id = ${ent.id}`);
      totalProcessed++;
    });
  }

  // 3. Experience Logs の欠損確認
  const pendingLogs = await db
    .select({ id: experienceLogs.id, content: experienceLogs.content })
    .from(experienceLogs)
    .where(isNull(experienceLogs.embedding))
    .limit(batchSize);

  for (const log of pendingLogs) {
    await withGlobalSemaphore('heavy-model', 2, async () => {
      const embedding = await generateEmbedding(log.content);
      await db.update(experienceLogs).set({ embedding }).where(sql`id = ${log.id}`);
      totalProcessed++;
    });
  }

  return { processed: totalProcessed };
}
