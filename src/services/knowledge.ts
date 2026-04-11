import { desc, eq, ilike, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  knowledgeClaims,
  knowledgeRelations,
  knowledgeSources,
  knowledgeTopics,
} from '../db/schema.js';

export type KnowledgeClaimResult = {
  topic: string;
  text: string;
  confidence: number;
};

export type DetailedKnowledge = {
  topic: string;
  aliases: string[];
  confidence: number;
  coverage: number;
  claims: { text: string; confidence: number; sourceIds: string[] }[];
  relations: { type: string; targetTopic: string; confidence: number }[];
  sources: { url: string; title: string | null; domain: string | null }[];
};

/**
 * knowFlow が書き込んだ knowledge_claims テーブルをテキスト検索します。
 */
export async function searchKnowledgeClaims(
  query: string,
  limit = 5,
): Promise<KnowledgeClaimResult[]> {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 8);

  if (words.length === 0) return [];

  try {
    const conditions = words.map((w) => ilike(knowledgeClaims.text, `%${w}%`));

    const results = await db
      .select({
        topic: knowledgeTopics.canonicalTopic,
        text: knowledgeClaims.text,
        confidence: knowledgeClaims.confidence,
      })
      .from(knowledgeClaims)
      .innerJoin(knowledgeTopics, eq(knowledgeClaims.topicId, knowledgeTopics.id))
      .where(or(...conditions))
      .orderBy(desc(knowledgeClaims.confidence))
      .limit(limit);

    return results;
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

    return {
      topic: topic.canonicalTopic,
      aliases: (topic.aliases as string[]) || [],
      confidence: topic.confidence,
      coverage: topic.coverage,
      // biome-ignore lint/suspicious/noExplicitAny: cast required for returned Knowledge interface compatibility
      claims: claims as any,
      relations,
      sources,
    };
  } catch {
    return null;
  }
}
