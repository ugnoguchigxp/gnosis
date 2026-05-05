import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { entities, experienceLogs, sessionKnowledgeCandidates } from '../../../db/schema.js';
import { generateEmbeddings } from '../../memory.js';

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

  const entityEmbeddings = await generateEmbeddings(
    pendingEntities.map((ent) => `${ent.name}: ${ent.description || ''}`),
    { type: 'passage', priority: 'low' },
  );
  for (const [index, ent] of pendingEntities.entries()) {
    const embedding = entityEmbeddings[index];
    if (!embedding) continue;
    await db.update(entities).set({ embedding }).where(sql`${entities.id} = ${ent.id}`);
    totalProcessed++;
  }

  // 2. Experience Logs の欠損確認
  const pendingLogs = await db
    .select({ id: experienceLogs.id, content: experienceLogs.content })
    .from(experienceLogs)
    .where(isNull(experienceLogs.embedding))
    .limit(batchSize);

  const logEmbeddings = await generateEmbeddings(
    pendingLogs.map((log) => log.content),
    { type: 'passage', priority: 'low' },
  );
  for (const [index, log] of pendingLogs.entries()) {
    const embedding = logEmbeddings[index];
    if (!embedding) continue;
    await db.update(experienceLogs).set({ embedding }).where(sql`${experienceLogs.id} = ${log.id}`);
    totalProcessed++;
  }

  // 3. Session Knowledge Candidates の欠損確認
  // テーブル未作成環境（古いDB）ではこの処理をスキップして、KnowFlow全体の詰まりを防ぐ。
  const tableCheck = await db.execute(
    sql`select to_regclass('public.session_knowledge_candidates') as table_name`,
  );
  const hasSessionKnowledgeCandidates = Boolean(tableCheck.rows[0]?.table_name);

  if (hasSessionKnowledgeCandidates) {
    const pendingCandidates = await db
      .select({
        id: sessionKnowledgeCandidates.id,
        title: sessionKnowledgeCandidates.title,
        statement: sessionKnowledgeCandidates.statement,
      })
      .from(sessionKnowledgeCandidates)
      .where(
        and(
          isNull(sessionKnowledgeCandidates.embedding),
          eq(sessionKnowledgeCandidates.keep, true),
        ),
      )
      .limit(batchSize);

    const candidateEmbeddings = await generateEmbeddings(
      pendingCandidates.map((candidate) => `${candidate.title}\n${candidate.statement}`),
      { type: 'passage', priority: 'low' },
    );
    for (const [index, candidate] of pendingCandidates.entries()) {
      const embedding = candidateEmbeddings[index];
      if (!embedding) continue;
      await db
        .update(sessionKnowledgeCandidates)
        .set({ embedding })
        .where(sql`${sessionKnowledgeCandidates.id} = ${candidate.id}`);
      totalProcessed++;
    }
  }

  return { processed: totalProcessed };
}
