import { and, desc, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { entities } from '../../../db/schema.js';
import { generateEmbedding } from '../../memory.js';

export type KnowledgeSearchArgs = {
  query: string;
  type: 'lesson' | 'rule' | 'procedure';
  limit?: number;
};

type Degraded = { code: string; message: string };

function normalizeTypeFilter(type: KnowledgeSearchArgs['type']): string[] {
  if (type === 'rule') return ['rule', 'constraint'];
  return [type];
}

async function typedFallback(args: KnowledgeSearchArgs, code: string, message: string) {
  const rows = await db
    .select({
      id: entities.id,
      type: entities.type,
      title: entities.name,
      content: entities.description,
      metadata: entities.metadata,
      confidence: entities.confidence,
      referenceCount: entities.referenceCount,
      freshness: entities.freshness,
      createdAt: entities.createdAt,
    })
    .from(entities)
    .where(inArray(entities.type, normalizeTypeFilter(args.type)))
    .orderBy(
      desc(entities.confidence),
      desc(entities.referenceCount),
      desc(entities.freshness),
      desc(entities.createdAt),
    )
    .limit(args.limit ?? 5);
  return {
    items: rows.map((row) => ({
      id: row.id,
      type: args.type,
      title: row.title,
      content: row.content ?? '',
      source: 'entities',
      score: null,
      metadata: row.metadata,
    })),
    degraded: { code, message } satisfies Degraded,
  };
}

export async function runKnowledgeSearch(args: KnowledgeSearchArgs): Promise<Record<string, unknown>> {
  const limit = args.limit ?? 5;
  const types = normalizeTypeFilter(args.type);
  try {
    let queryEmbedding: number[];
    try {
      queryEmbedding = await generateEmbedding(args.query);
    } catch (error) {
      return typedFallback(
        args,
        'EMBEDDING_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      );
    }

    const embStr = JSON.stringify(queryEmbedding);
    const score = sql<number>`1 - (${entities.embedding} <=> ${embStr}::vector)`;
    const rows = await db
      .select({
        id: entities.id,
        type: entities.type,
        title: entities.name,
        content: entities.description,
        metadata: entities.metadata,
        score,
      })
      .from(entities)
      .where(and(inArray(entities.type, types), isNotNull(entities.embedding)))
      .orderBy((fields) => desc(fields.score))
      .limit(limit);

    if (rows.length === 0) {
      return typedFallback(
        args,
        'VECTOR_SEARCH_UNAVAILABLE',
        'No vector-searchable records for requested type',
      );
    }
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: args.type,
        title: row.title,
        content: row.content ?? '',
        source: 'entities',
        score: row.score,
        metadata: row.metadata,
      })),
    };
  } catch (error) {
    return typedFallback(
      args,
      'VECTOR_SEARCH_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
    );
  }
}
