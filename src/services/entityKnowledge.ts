import { and, desc, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { entities } from '../db/schema.js';
import { generateEmbedding } from './memory.js';

export type EntityKnowledgeSearchType =
  | 'lesson'
  | 'rule'
  | 'procedure'
  | 'concept'
  | 'reference'
  | 'all';

export type EntityKnowledgeSearchSource =
  | 'vector'
  | 'exact'
  | 'full_text'
  | 'direct_text'
  | 'recent';

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
  source: EntityKnowledgeSearchSource;
  matchSources: EntityKnowledgeSearchSource[];
  sourceScores: Partial<Record<EntityKnowledgeSearchSource, number>>;
};

export type EntityKnowledgeSearchTelemetry = {
  queryText: string;
  vectorHitCount: number;
  exactHitCount: number;
  fullTextHitCount: number;
  directTextHitCount: number;
  recentFallbackUsed: boolean;
  embeddingStatus: 'used' | 'unavailable' | 'not_attempted';
  mergedCandidateCount: number;
};

type EntityKnowledgeDbClient = Pick<typeof db, 'select'>;
type GenerateQueryEmbedding = typeof generateEmbedding;

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

const recentFallbackTypes = [
  'lesson',
  'rule',
  'constraint',
  'procedure',
  'skill',
  'command_recipe',
  'project_doc',
  'reference',
  'decision',
];

const sourcePriority: Record<EntityKnowledgeSearchSource, number> = {
  exact: 5,
  vector: 4,
  full_text: 3,
  direct_text: 2,
  recent: 1,
};

const entityTypePriority: Record<string, number> = {
  procedure: 7,
  skill: 6,
  command_recipe: 5,
  rule: 4,
  constraint: 3,
  lesson: 2,
  decision: 1,
};

const getEntityTypePriority = (type: string | undefined): number => {
  if (!type) return 0;
  return entityTypePriority[type] ?? 0;
};

const exactMetadataArrayFields = [
  'triggerPhrases',
  'appliesWhen',
  'tags',
  'files',
  'changeTypes',
  'technologies',
] as const;

const exactMetadataScalarFields = ['intent', 'category', 'kind', 'source', 'title'] as const;

const exactMetadataConditions = (query: string) => {
  const terms = Array.from(new Set([query, query.toLowerCase()])).filter(Boolean);
  return terms.flatMap((term) => [
    ...exactMetadataArrayFields.map(
      (field) => sql`${entities.metadata} @> ${JSON.stringify({ [field]: [term] })}::jsonb`,
    ),
    ...exactMetadataScalarFields.map(
      (field) => sql`${entities.metadata} @> ${JSON.stringify({ [field]: term })}::jsonb`,
    ),
  ]);
};

const weightedScore = (source: EntityKnowledgeSearchSource, rawScore: number): number => {
  if (source === 'exact') return Math.max(1, rawScore);
  if (source === 'direct_text') return Math.max(0.2, rawScore);
  if (source === 'recent') return Math.max(0.05, rawScore);
  return rawScore;
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
  source: EntityKnowledgeSearchSource,
): EntityKnowledgeSearchResult[] =>
  rows
    .filter((row) => row.content && row.content.trim().length > 0)
    .map((row) => ({
      ...row,
      content: row.content ?? '',
      score: weightedScore(source, Number(row.score ?? 0)),
      source,
      matchSources: [source],
      sourceScores: { [source]: Number(row.score ?? 0) },
    }));

const rowTime = (value: Date | null | undefined): number => {
  if (!value) return 0;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
};

const mergeResults = (
  resultSets: EntityKnowledgeSearchResult[][],
): EntityKnowledgeSearchResult[] => {
  const byId = new Map<string, EntityKnowledgeSearchResult>();

  for (const result of resultSets.flat()) {
    const existing = byId.get(result.id);
    if (!existing) {
      byId.set(result.id, { ...result });
      continue;
    }

    const matchSources = Array.from(new Set([...existing.matchSources, ...result.matchSources]));
    const sourceScores = { ...existing.sourceScores, ...result.sourceScores };
    const better = result.score > existing.score;
    byId.set(result.id, {
      ...(better ? result : existing),
      matchSources,
      sourceScores,
      score: Math.max(existing.score, result.score),
    });
  }

  return Array.from(byId.values()).sort((a, b) => {
    const scoreDelta = b.score - a.score;
    if (scoreDelta !== 0) return scoreDelta;

    const priorityDelta =
      Math.max(...b.matchSources.map((source) => sourcePriority[source])) -
      Math.max(...a.matchSources.map((source) => sourcePriority[source]));
    if (priorityDelta !== 0) return priorityDelta;

    const typeDelta = getEntityTypePriority(b.type) - getEntityTypePriority(a.type);
    if (typeDelta !== 0) return typeDelta;

    const freshnessDelta = rowTime(b.freshness) - rowTime(a.freshness);
    if (freshnessDelta !== 0) return freshnessDelta;
    return rowTime(b.createdAt) - rowTime(a.createdAt);
  });
};

export async function searchEntityKnowledgeDetailed(input: {
  query: string;
  type?: EntityKnowledgeSearchType;
  limit?: number;
  database?: EntityKnowledgeDbClient;
  generateQueryEmbedding?: GenerateQueryEmbedding;
}): Promise<{
  results: EntityKnowledgeSearchResult[];
  telemetry: EntityKnowledgeSearchTelemetry;
}> {
  const query = input.query.trim();
  if (!query) {
    return {
      results: [],
      telemetry: {
        queryText: '',
        vectorHitCount: 0,
        exactHitCount: 0,
        fullTextHitCount: 0,
        directTextHitCount: 0,
        recentFallbackUsed: false,
        embeddingStatus: 'not_attempted',
        mergedCandidateCount: 0,
      },
    };
  }

  const limit = normalizeLimit(input.limit);
  const candidateLimit = Math.max(limit * 3, 10);
  const type = input.type ?? 'all';
  const database = input.database ?? db;
  const generateQueryEmbedding = input.generateQueryEmbedding ?? generateEmbedding;
  const searchableText = sql<string>`concat_ws(' ', ${entities.name}, ${entities.description}, ${entities.metadata}::text)`;
  const tsvectorExpr = sql`to_tsvector('simple', ${searchableText})`;
  const tsqueryExpr = sql`websearch_to_tsquery('simple', ${query})`;
  const rankExpr = sql<number>`ts_rank_cd(${tsvectorExpr}, ${tsqueryExpr})`;
  const metadataExactConditions = exactMetadataConditions(query);
  let telemetry: EntityKnowledgeSearchTelemetry = {
    queryText: query,
    vectorHitCount: 0,
    exactHitCount: 0,
    fullTextHitCount: 0,
    directTextHitCount: 0,
    recentFallbackUsed: false,
    embeddingStatus: 'not_attempted',
    mergedCandidateCount: 0,
  };
  let exactResults: EntityKnowledgeSearchResult[] = [];
  let vectorResults: EntityKnowledgeSearchResult[] = [];
  let fullTextResults: EntityKnowledgeSearchResult[] = [];
  let directTextResults: EntityKnowledgeSearchResult[] = [];
  let recentResults: EntityKnowledgeSearchResult[] = [];

  try {
    const rows = await database
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
        score: sql<number>`1`,
      })
      .from(entities)
      .where(
        and(
          ...baseConditions(type),
          or(
            sql`lower(${entities.id}) = lower(${query})`,
            sql`lower(${entities.name}) = lower(${query})`,
            ...metadataExactConditions,
          ),
        ),
      )
      .orderBy(desc(entities.freshness), desc(entities.createdAt))
      .limit(candidateLimit);
    exactResults = mapRows(rows, 'exact');
  } catch {
    exactResults = [];
  }

  try {
    const embedding = await generateQueryEmbedding(query, { type: 'query', priority: 'high' });
    const embeddingStr = JSON.stringify(embedding);
    const similarityExpr = sql<number>`1 - (${entities.embedding} <=> ${embeddingStr}::vector)`;
    const rows = await database
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
        score: similarityExpr,
      })
      .from(entities)
      .where(and(...baseConditions(type), isNotNull(entities.embedding)))
      .orderBy(desc(similarityExpr), desc(entities.freshness), desc(entities.createdAt))
      .limit(candidateLimit);
    vectorResults = mapRows(rows, 'vector');
    telemetry = { ...telemetry, embeddingStatus: 'used' };
  } catch {
    telemetry = { ...telemetry, embeddingStatus: 'unavailable' };
  }

  try {
    const rows = await database
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
      .limit(candidateLimit);
    fullTextResults = mapRows(rows, 'full_text');
  } catch {
    fullTextResults = [];
  }

  try {
    const rows = await database
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
          sql`position(lower(${query}) in lower(${searchableText})) > 0`,
        ),
      )
      .orderBy(desc(entities.freshness), desc(entities.createdAt))
      .limit(candidateLimit);
    directTextResults = mapRows(rows, 'direct_text');
  } catch {
    directTextResults = [];
  }

  const mergedWithoutRecent = mergeResults([
    exactResults,
    vectorResults,
    fullTextResults,
    directTextResults,
  ]);

  if (mergedWithoutRecent.length === 0) {
    const recentConditions = [...baseConditions(type)];
    if (type === 'all') {
      recentConditions.push(inArray(entities.type, recentFallbackTypes));
    }
    const rows = await database
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
      .where(and(...recentConditions))
      .orderBy(desc(entities.freshness), desc(entities.createdAt))
      .limit(limit);
    recentResults = mapRows(rows, 'recent');
  }

  const merged = mergeResults([
    exactResults,
    vectorResults,
    fullTextResults,
    directTextResults,
    recentResults,
  ]);
  telemetry = {
    ...telemetry,
    exactHitCount: exactResults.length,
    vectorHitCount: vectorResults.length,
    fullTextHitCount: fullTextResults.length,
    directTextHitCount: directTextResults.length,
    recentFallbackUsed: recentResults.length > 0,
    mergedCandidateCount: merged.length,
  };

  return {
    results: merged.slice(0, limit),
    telemetry,
  };
}

export async function searchEntityKnowledge(input: {
  query: string;
  type?: EntityKnowledgeSearchType;
  limit?: number;
  database?: EntityKnowledgeDbClient;
  generateQueryEmbedding?: GenerateQueryEmbedding;
}): Promise<EntityKnowledgeSearchResult[]> {
  const detailed = await searchEntityKnowledgeDetailed(input);
  return detailed.results;
}
