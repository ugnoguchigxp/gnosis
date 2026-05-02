import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { entities, experienceLogs, sessionKnowledgeCandidates } from '../../../db/schema.js';
import { generateEmbedding } from '../../memory.js';

/**
 * 埋め込みベクトルが欠損しているレコードを特定し、一括で生成します。
 */
export async function embeddingBatchTask(batchSize = 20): Promise<{ processed: number }> {
  let totalProcessed = 0;

  // 1. Entities の欠損確認
  const pendingEntities = await db
    .select({ id: entities.id, name: entities.name, description: entities.description })
    .from(entities)
    .where(isNull(entities.embedding))
    .limit(batchSize);

  for (const ent of pendingEntities) {
    const text = `${ent.name}: ${ent.description || ''}`;
    const embedding = await generateEmbedding(text);
    await db.update(entities).set({ embedding }).where(sql`id = ${ent.id}`);
    totalProcessed++;
  }

  // 2. Experience Logs の欠損確認
  const pendingLogs = await db
    .select({ id: experienceLogs.id, content: experienceLogs.content })
    .from(experienceLogs)
    .where(isNull(experienceLogs.embedding))
    .limit(batchSize);

  for (const log of pendingLogs) {
    const embedding = await generateEmbedding(log.content);
    await db.update(experienceLogs).set({ embedding }).where(sql`id = ${log.id}`);
    totalProcessed++;
  }

  // 3. Session Knowledge Candidates の欠損確認
  const pendingCandidates = await db
    .select({
      id: sessionKnowledgeCandidates.id,
      title: sessionKnowledgeCandidates.title,
      statement: sessionKnowledgeCandidates.statement,
    })
    .from(sessionKnowledgeCandidates)
    .where(
      and(isNull(sessionKnowledgeCandidates.embedding), eq(sessionKnowledgeCandidates.keep, true)),
    )
    .limit(batchSize);

  for (const candidate of pendingCandidates) {
    const embedding = await generateEmbedding(`${candidate.title}\n${candidate.statement}`);
    await db.update(sessionKnowledgeCandidates).set({ embedding }).where(sql`id = ${candidate.id}`);
    totalProcessed++;
  }

  return { processed: totalProcessed };
}
