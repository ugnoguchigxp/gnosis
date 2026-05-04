import { and, desc, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { entities } from '../db/schema.js';

export type EntityKnowledgeSearchType =
  | 'lesson'
  | 'rule'
  | 'procedure'
  | 'concept'
  | 'reference'
  | 'all';

export type EntityKnowledgeSearchResult = {
  id: string;
  type: string;
  title: string;
  content: string;
  metadata: unknown;
  confidence: number | null;
  referenceCount: number | null;
  freshness: Date | null;
  createdAt: Date;
  score: number;
};

const typeFilterFor = (type: EntityKnowledgeSearchType): string[] | null => {
  if (type === 'all') return null;
  if (type === 'rule') return ['rule', 'constraint'];
  if (type === 'procedure') return ['procedure', 'skill', 'command_recipe'];
  if (type === 'concept') return ['concept', 'pattern', 'library', 'service', 'tool'];
  if (type === 'reference') return ['reference', 'project_doc'];
  return [type];
};

const normalizeLimit = (limit: number | undefined): number => {
  const normalized = Math.trunc(limit ?? 5);
  if (!Number.isFinite(normalized)) return 5;
  return Math.max(1, normalized);
};

const baseConditions = (type: EntityKnowledgeSearchType) => {
  const typeFilter = typeFilterFor(type);
  const conditions = [
    isNotNull(entities.description),
    sql`${entities.type} <> 'knowflow_topic_state'`,
  ];
  if (typeFilter) {
    conditions.push(inArray(entities.type, typeFilter));
  }
  return conditions;
};

const mapRows = (
  rows: Array<{
    id: string;
    type: string;
    title: string;
    content: string | null;
    metadata: unknown;
    confidence: number | null;
    referenceCount: number | null;
    freshness: Date | null;
    createdAt: Date;
    score: number | null;
  }>,
): EntityKnowledgeSearchResult[] =>
  rows
    .filter((row) => row.content && row.content.trim().length > 0)
    .map((row) => ({
      ...row,
      content: row.content ?? '',
      score: Number(row.score ?? 0),
    }));

export async function searchEntityKnowledge(input: {
  query: string;
  type?: EntityKnowledgeSearchType;
  limit?: number;
}): Promise<EntityKnowledgeSearchResult[]> {
  const query = input.query.trim();
  if (!query) return [];
  const limit = normalizeLimit(input.limit);
  const type = input.type ?? 'all';
  const searchableText = sql<string>`concat_ws(' ', ${entities.name}, ${entities.description})`;
  const tsvectorExpr = sql`to_tsvector('simple', ${searchableText})`;
  const tsqueryExpr = sql`websearch_to_tsquery('simple', ${query})`;
  const rankExpr = sql<number>`ts_rank_cd(${tsvectorExpr}, ${tsqueryExpr})`;

  try {
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
        score: rankExpr,
      })
      .from(entities)
      .where(and(...baseConditions(type), sql`${tsvectorExpr} @@ ${tsqueryExpr}`))
      .orderBy(desc(rankExpr), desc(entities.freshness), desc(entities.createdAt))
      .limit(limit);

    const mapped = mapRows(rows);
    if (mapped.length > 0) return mapped;
  } catch {
    // Fall through to direct text matching. Some tsquery inputs are not portable across DB versions.
  }

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
      score: sql<number>`0`,
    })
    .from(entities)
    .where(
      and(
        ...baseConditions(type),
        or(
          sql`position(lower(${query}) in lower(${entities.name})) > 0`,
          sql`position(lower(${query}) in lower(${entities.description})) > 0`,
        ),
      ),
    )
    .orderBy(desc(entities.freshness), desc(entities.createdAt))
    .limit(limit);

  return mapRows(rows);
}
