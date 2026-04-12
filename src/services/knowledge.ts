import { desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  knowledgeClaims,
  knowledgeRelations,
  knowledgeSources,
  knowledgeTopics,
} from '../db/schema.js';

import { DetailedKnowledgeSchema, KnowledgeClaimResultSchema } from '../domain/schemas.js';
import type { DetailedKnowledge, KnowledgeClaimResult } from '../domain/schemas.js';

/**
 * knowFlow が書き込んだ knowledge_claims テーブルをテキスト検索します。
 */
export async function searchKnowledgeClaims(
  query: string,
  limit = 5,
): Promise<KnowledgeClaimResult[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) return [];
  const safeLimit = Math.max(1, Math.trunc(limit));

  const tsvectorExpr = sql`to_tsvector('simple', ${knowledgeClaims.text})`;
  const tsqueryExpr = sql`websearch_to_tsquery('simple', ${normalizedQuery})`;
  const rankExpr = sql<number>`ts_rank_cd(${tsvectorExpr}, ${tsqueryExpr})`;

  try {
    const ftsResults = await db
      .select({
        topic: knowledgeTopics.canonicalTopic,
        text: knowledgeClaims.text,
        confidence: knowledgeClaims.confidence,
        score: rankExpr,
      })
      .from(knowledgeClaims)
      .innerJoin(knowledgeTopics, eq(knowledgeClaims.topicId, knowledgeTopics.id))
      .where(sql`${tsvectorExpr} @@ ${tsqueryExpr}`)
      .orderBy(desc(rankExpr), desc(knowledgeClaims.confidence))
      .limit(safeLimit);

    if (ftsResults.length > 0) {
      return ftsResults.map((r) => KnowledgeClaimResultSchema.parse(r));
    }
  } catch {
    // Fall through to LIKE fallback
  }

  const words = normalizedQuery
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 8);

  if (words.length === 0) return [];

  try {
    const conditions = words.map((w) => ilike(knowledgeClaims.text, `%${w}%`));
    const fallbackResults = await db
      .select({
        topic: knowledgeTopics.canonicalTopic,
        text: knowledgeClaims.text,
        confidence: knowledgeClaims.confidence,
        score: sql<number>`0`,
      })
      .from(knowledgeClaims)
      .innerJoin(knowledgeTopics, eq(knowledgeClaims.topicId, knowledgeTopics.id))
      .where(or(...conditions))
      .orderBy(desc(knowledgeClaims.confidence))
      .limit(safeLimit);
    return fallbackResults.map((r) => KnowledgeClaimResultSchema.parse(r));
  } catch {
    return [];
  }
}

/**
 * 特定のトピックに関する詳細な知識（クレーム、リレーション、ソース）を取得します。
 */
export async function getKnowledgeByTopic(topicName: string): Promise<DetailedKnowledge | null> {
  const canonicalTopic = topicName.trim().toLowerCase().replace(/\s+/g, ' ');

  try {
    const topicRows = await db
      .select()
      .from(knowledgeTopics)
      .where(eq(knowledgeTopics.canonicalTopic, canonicalTopic))
      .limit(1);

    if (topicRows.length === 0) return null;
    const topic = topicRows[0];
    if (!topic) return null;

    const [claims, relations, sources] = await Promise.all([
      db
        .select({
          text: knowledgeClaims.text,
          confidence: knowledgeClaims.confidence,
          sourceIds: knowledgeClaims.sourceIds,
        })
        .from(knowledgeClaims)
        .where(eq(knowledgeClaims.topicId, topic.id)),
      db
        .select({
          type: knowledgeRelations.relationType,
          targetTopic: knowledgeRelations.targetTopic,
          confidence: knowledgeRelations.confidence,
        })
        .from(knowledgeRelations)
        .where(eq(knowledgeRelations.topicId, topic.id)),
      db
        .select({
          url: knowledgeSources.url,
          title: knowledgeSources.title,
          domain: knowledgeSources.domain,
        })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.topicId, topic.id)),
    ]);

    const result = {
      topic: topic.canonicalTopic,
      aliases: (topic.aliases as string[]) || [],
      confidence: topic.confidence,
      coverage: topic.coverage,
      claims: claims.map((c) => ({
        text: c.text,
        confidence: c.confidence,
        sourceIds: (c.sourceIds as string[]) || [],
      })),
      relations,
      sources,
    };

    return DetailedKnowledgeSchema.parse(result);
  } catch (error) {
    console.error(`Error in getKnowledgeByTopic: ${error}`);
    return null;
  }
}
