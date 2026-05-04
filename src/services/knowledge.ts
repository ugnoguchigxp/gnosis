import { desc, eq, ilike, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  entities,
  knowledgeClaims,
  knowledgeRelations,
  knowledgeSources,
  knowledgeTopics,
} from '../db/schema.js';

import { DetailedKnowledgeSchema, KnowledgeClaimResultSchema } from '../domain/schemas.js';
import type { DetailedKnowledge, KnowledgeClaimResult } from '../domain/schemas.js';
import { searchEntityKnowledge } from './entityKnowledge.js';

const parseStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const getMetadataRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const mapEntitySearchResults = (
  results: Awaited<ReturnType<typeof searchEntityKnowledge>>,
): KnowledgeClaimResult[] =>
  results.map((result) =>
    KnowledgeClaimResultSchema.parse({
      topic: result.title,
      text: result.content,
      confidence: result.confidence,
      score: result.score,
    }),
  );

/**
 * Entity-first knowledge search.
 *
 * KnowFlow の Research Note は通常の entities として保存されるため、まず entities を検索します。
 * 旧 knowledge_claims は過去データ互換のフォールバックとしてだけ扱います。
 */
export async function searchKnowledgeClaims(
  query: string,
  limit = 5,
): Promise<KnowledgeClaimResult[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) return [];
  const safeLimit = Math.max(1, Math.trunc(limit));

  const entityResults = await searchEntityKnowledge({
    query: normalizedQuery,
    type: 'all',
    limit: safeLimit,
  });
  if (entityResults.length > 0) {
    return mapEntitySearchResults(entityResults);
  }

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
    // Fall through to direct text matching.
  }

  try {
    const fallbackResults = await db
      .select({
        topic: knowledgeTopics.canonicalTopic,
        text: knowledgeClaims.text,
        confidence: knowledgeClaims.confidence,
        score: sql<number>`0`,
      })
      .from(knowledgeClaims)
      .innerJoin(knowledgeTopics, eq(knowledgeClaims.topicId, knowledgeTopics.id))
      .where(ilike(knowledgeClaims.text, `%${normalizedQuery}%`))
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
  const canonicalTopic = topicName.trim().toLowerCase().split(' ').filter(Boolean).join(' ');

  try {
    const topicRows = await db
      .select()
      .from(knowledgeTopics)
      .where(eq(knowledgeTopics.canonicalTopic, canonicalTopic))
      .limit(1);

    if (topicRows.length === 0) {
      return getEntityKnowledgeByTopic(topicName);
    }
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

async function getEntityKnowledgeByTopic(topicName: string): Promise<DetailedKnowledge | null> {
  const normalizedTopic = topicName.trim();
  if (!normalizedTopic) return null;

  const rows = await db
    .select({
      id: entities.id,
      type: entities.type,
      name: entities.name,
      description: entities.description,
      metadata: entities.metadata,
      confidence: entities.confidence,
    })
    .from(entities)
    .where(sql`lower(${entities.name}) = lower(${normalizedTopic})`)
    .limit(1);
  const entity = rows[0];
  if (!entity?.description) return null;

  const metadata = getMetadataRecord(entity.metadata);
  const referenceUrls = parseStringArray(metadata.referenceUrls);
  return DetailedKnowledgeSchema.parse({
    topic: entity.name,
    aliases: [],
    confidence: entity.confidence,
    coverage: 1,
    claims: [
      {
        text: entity.description,
        confidence: entity.confidence,
        sourceIds: referenceUrls,
      },
    ],
    relations: [],
    sources: referenceUrls.map((url) => ({
      url,
      title: null,
      domain: null,
    })),
  });
}
