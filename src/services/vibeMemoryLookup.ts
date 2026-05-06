import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { vibeMemories } from '../db/schema.js';
import { generateEmbedding } from './memory.js';

type DbClient = Pick<typeof db, 'select' | 'update'>;
type GenerateQueryEmbedding = typeof generateEmbedding;

export type VibeMemorySearchMode = 'hybrid' | 'vector' | 'like';
export type VibeMemorySearchSource = 'vector' | 'like';
export type VibeMemoryFetchRangeSource = 'explicit_range' | 'query_match' | 'prefix_fallback';

export type VibeMemorySearchInput = {
  query: string;
  mode?: VibeMemorySearchMode;
  limit?: number;
  sessionId?: string;
  memoryType?: 'raw';
  maxSnippetChars?: number;
};

export type VibeMemorySearchOutput = {
  items: Array<{
    id: string;
    sessionId: string;
    createdAt: string;
    source: VibeMemorySearchSource;
    matchSources: VibeMemorySearchSource[];
    score: number;
    snippet: string;
  }>;
  retrieval: {
    query: string;
    mode: VibeMemorySearchMode;
    vectorHitCount: number;
    likeHitCount: number;
    returnedCount: number;
    embeddingStatus: 'used' | 'unavailable' | 'not_attempted';
  };
  degraded?: { code: string; message: string };
};

export type VibeMemoryFetchInput = {
  id: string;
  query?: string;
  start?: number;
  end?: number;
  maxChars?: number;
};

export type VibeMemoryFetchOutput = {
  id: string;
  sessionId: string;
  createdAt: string;
  range: {
    start: number;
    end: number;
    totalChars: number;
    source: VibeMemoryFetchRangeSource;
  };
  excerpts: Array<{ text: string; matched: boolean; start: number; end: number }>;
  text: string;
  truncated: boolean;
  degraded?: { code: string; message: string };
};

type SearchRow = {
  id: string;
  sessionId: string;
  content: string;
  createdAt: Date | string;
  score: number | string | null;
};

type FetchRow = {
  id: string;
  sessionId: string;
  content: string;
  createdAt: Date | string;
};

type InternalSearchCandidate = {
  id: string;
  sessionId: string;
  content: string;
  createdAt: string;
  source: VibeMemorySearchSource;
  matchSources: VibeMemorySearchSource[];
  score: number;
};

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_SNIPPET_CHARS = 240;
const MAX_SNIPPET_CHARS = 1000;
const DEFAULT_FETCH_CHARS = 1000;
const MAX_FETCH_CHARS = 5000;

function clampInt(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultValue;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeCreatedAt(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function clampScore(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(1, Math.max(0, numeric));
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function findPhraseIndex(
  content: string,
  query?: string,
): { index: number; length: number } | null {
  const normalizedQuery = query?.trim();
  if (!normalizedQuery) return null;
  const index = content.toLowerCase().indexOf(normalizedQuery.toLowerCase());
  return index >= 0 ? { index, length: normalizedQuery.length } : null;
}

function queryTokens(query?: string): string[] {
  return Array.from(
    new Set(
      (query ?? '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  );
}

function findTokenIndex(content: string, query?: string): { index: number; length: number } | null {
  const lower = content.toLowerCase();
  let best: { index: number; length: number } | null = null;
  for (const token of queryTokens(query)) {
    const index = lower.indexOf(token);
    if (index < 0) continue;
    if (!best || index < best.index) {
      best = { index, length: token.length };
    }
  }
  return best;
}

function windowAroundMatch(
  content: string,
  match: { index: number; length: number },
  maxChars: number,
): { start: number; end: number } {
  if (content.length <= maxChars) return { start: 0, end: content.length };
  const matchCenter = match.index + Math.floor(match.length / 2);
  let start = Math.max(0, matchCenter - Math.floor(maxChars / 2));
  const end = Math.min(content.length, start + maxChars);
  if (end - start < maxChars) {
    start = Math.max(0, end - maxChars);
  }
  return { start, end };
}

function buildSearchSnippet(content: string, query: string, maxChars: number): string {
  const match = findPhraseIndex(content, query);
  if (!match) return compactText(content.slice(0, maxChars));
  const { start, end } = windowAroundMatch(content, match, maxChars);
  return compactText(content.slice(start, end));
}

function toSearchCandidate(
  row: SearchRow,
  source: VibeMemorySearchSource,
): InternalSearchCandidate {
  return {
    id: row.id,
    sessionId: row.sessionId,
    content: row.content,
    createdAt: normalizeCreatedAt(row.createdAt),
    source,
    matchSources: [source],
    score: source === 'like' ? 1 : clampScore(row.score),
  };
}

function mergeCandidates(candidates: InternalSearchCandidate[]): InternalSearchCandidate[] {
  const byId = new Map<string, InternalSearchCandidate>();
  for (const candidate of candidates) {
    const current = byId.get(candidate.id);
    if (!current) {
      byId.set(candidate.id, { ...candidate, matchSources: [...candidate.matchSources] });
      continue;
    }
    if (!current.matchSources.includes(candidate.source)) {
      current.matchSources.push(candidate.source);
    }
    if (
      candidate.score > current.score ||
      (candidate.score === current.score && candidate.source === 'vector')
    ) {
      current.score = candidate.score;
      current.source = candidate.source;
      current.content = candidate.content;
      current.createdAt = candidate.createdAt;
      current.sessionId = candidate.sessionId;
    }
  }
  return [...byId.values()].map((candidate) => ({
    ...candidate,
    matchSources: candidate.matchSources.sort((a, b) => {
      if (a === b) return 0;
      return a === 'vector' ? -1 : 1;
    }),
  }));
}

function sortCandidates(candidates: InternalSearchCandidate[]): InternalSearchCandidate[] {
  return candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.matchSources.length !== a.matchSources.length) {
      return b.matchSources.length - a.matchSources.length;
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function buildBaseWhere(memoryType: 'raw', sessionId?: string) {
  return sessionId
    ? and(eq(vibeMemories.memoryType, memoryType), eq(vibeMemories.sessionId, sessionId))
    : eq(vibeMemories.memoryType, memoryType);
}

async function searchVectorRows(
  input: {
    memoryType: 'raw';
    sessionId?: string;
    limit: number;
    embedding: number[];
  },
  database: DbClient,
): Promise<SearchRow[]> {
  const embeddingStr = JSON.stringify(input.embedding);
  const similarity = sql<number>`1 - (${vibeMemories.embedding} <=> ${embeddingStr}::vector)`;
  const whereClause = input.sessionId
    ? and(
        eq(vibeMemories.memoryType, input.memoryType),
        eq(vibeMemories.sessionId, input.sessionId),
        sql`${vibeMemories.embedding} IS NOT NULL`,
      )
    : and(
        eq(vibeMemories.memoryType, input.memoryType),
        sql`${vibeMemories.embedding} IS NOT NULL`,
      );

  return database
    .select({
      id: vibeMemories.id,
      sessionId: vibeMemories.sessionId,
      content: vibeMemories.content,
      createdAt: vibeMemories.createdAt,
      score: similarity.mapWith(Number),
    })
    .from(vibeMemories)
    .where(whereClause)
    .orderBy((fields) => desc(fields.score))
    .limit(input.limit);
}

async function searchLikeRows(
  input: { query: string; memoryType: 'raw'; sessionId?: string; limit: number },
  database: DbClient,
): Promise<SearchRow[]> {
  const whereClause = and(
    buildBaseWhere(input.memoryType, input.sessionId),
    sql`position(lower(${input.query}) in lower(${vibeMemories.content})) > 0`,
  );

  return database
    .select({
      id: vibeMemories.id,
      sessionId: vibeMemories.sessionId,
      content: vibeMemories.content,
      createdAt: vibeMemories.createdAt,
      score: sql<number>`1`.mapWith(Number),
    })
    .from(vibeMemories)
    .where(whereClause)
    .orderBy(desc(vibeMemories.createdAt))
    .limit(input.limit);
}

export async function searchVibeMemories(
  input: VibeMemorySearchInput,
  deps: { database?: DbClient; generateQueryEmbedding?: GenerateQueryEmbedding } = {},
): Promise<VibeMemorySearchOutput> {
  const query = input.query.trim();
  const mode = input.mode ?? 'hybrid';
  const memoryType = input.memoryType ?? 'raw';
  const limit = clampInt(input.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  const maxSnippetChars = clampInt(
    input.maxSnippetChars,
    DEFAULT_SNIPPET_CHARS,
    1,
    MAX_SNIPPET_CHARS,
  );
  const candidateLimit = Math.max(limit * 3, 10);
  const database = deps.database ?? db;
  const generateQueryEmbedding = deps.generateQueryEmbedding ?? generateEmbedding;
  let vectorRows: SearchRow[] = [];
  let likeRows: SearchRow[] = [];
  let embeddingStatus: VibeMemorySearchOutput['retrieval']['embeddingStatus'] = 'not_attempted';
  let degraded: VibeMemorySearchOutput['degraded'];

  if (query.length === 0) {
    return {
      items: [],
      retrieval: {
        query,
        mode,
        vectorHitCount: 0,
        likeHitCount: 0,
        returnedCount: 0,
        embeddingStatus,
      },
      degraded: { code: 'INVALID_QUERY', message: 'query must not be blank.' },
    };
  }

  if (mode === 'vector' || mode === 'hybrid') {
    try {
      const embedding = await generateQueryEmbedding(query, { type: 'query', priority: 'high' });
      embeddingStatus = 'used';
      vectorRows = await searchVectorRows(
        { memoryType, sessionId: input.sessionId, limit: candidateLimit, embedding },
        database,
      );
    } catch (error) {
      embeddingStatus = 'unavailable';
      degraded = {
        code: 'EMBEDDING_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (mode === 'like' || mode === 'hybrid') {
    likeRows = await searchLikeRows(
      { query, memoryType, sessionId: input.sessionId, limit: candidateLimit },
      database,
    );
  }

  const merged = sortCandidates(
    mergeCandidates([
      ...vectorRows.map((row) => toSearchCandidate(row, 'vector')),
      ...likeRows.map((row) => toSearchCandidate(row, 'like')),
    ]),
  ).slice(0, limit);

  return {
    items: merged.map((candidate) => ({
      id: candidate.id,
      sessionId: candidate.sessionId,
      createdAt: candidate.createdAt,
      source: candidate.source,
      matchSources: candidate.matchSources,
      score: candidate.score,
      snippet: buildSearchSnippet(candidate.content, query, maxSnippetChars),
    })),
    retrieval: {
      query,
      mode,
      vectorHitCount: vectorRows.length,
      likeHitCount: likeRows.length,
      returnedCount: merged.length,
      embeddingStatus,
    },
    ...(degraded ? { degraded } : {}),
  };
}

function buildMissingFetchOutput(id: string, code: string, message: string): VibeMemoryFetchOutput {
  return {
    id,
    sessionId: '',
    createdAt: '',
    range: { start: 0, end: 0, totalChars: 0, source: 'prefix_fallback' },
    excerpts: [],
    text: '',
    truncated: false,
    degraded: { code, message },
  };
}

function invalidRangeOutput(
  id: string,
  row: FetchRow,
  code: string,
  message: string,
): VibeMemoryFetchOutput {
  return {
    id,
    sessionId: row.sessionId,
    createdAt: normalizeCreatedAt(row.createdAt),
    range: { start: 0, end: 0, totalChars: row.content.length, source: 'explicit_range' },
    excerpts: [],
    text: '',
    truncated: false,
    degraded: { code, message },
  };
}

function normalizeExplicitRange(
  input: VibeMemoryFetchInput,
  totalChars: number,
  maxChars: number,
): { start: number; end: number; truncated: boolean } | { errorCode: string; message: string } {
  const hasStart = typeof input.start === 'number';
  const hasEnd = typeof input.end === 'number';
  const rawEnd = hasEnd ? Math.trunc(input.end ?? 0) : undefined;
  const clampedEnd = rawEnd === undefined ? undefined : Math.min(rawEnd, totalChars);
  const startRaw = hasStart
    ? Math.trunc(input.start ?? 0)
    : Math.max(0, (clampedEnd ?? 0) - maxChars);
  const endRaw = rawEnd ?? startRaw + maxChars;

  if (startRaw < 0 || endRaw < 0 || endRaw <= startRaw) {
    return {
      errorCode: 'INVALID_RANGE',
      message: 'start/end must define a non-empty non-negative range.',
    };
  }
  if (startRaw >= totalChars) {
    return { errorCode: 'RANGE_OUT_OF_BOUNDS', message: 'start is outside the memory content.' };
  }

  const requestedEnd = Math.min(endRaw, totalChars);
  const cappedEnd = Math.min(requestedEnd, startRaw + maxChars);
  return {
    start: startRaw,
    end: cappedEnd,
    truncated: cappedEnd < endRaw || cappedEnd < totalChars || startRaw > 0,
  };
}

async function fetchMemoryRow(id: string, database: DbClient): Promise<FetchRow | undefined> {
  const rows = await database
    .select({
      id: vibeMemories.id,
      sessionId: vibeMemories.sessionId,
      content: vibeMemories.content,
      createdAt: vibeMemories.createdAt,
    })
    .from(vibeMemories)
    .where(eq(vibeMemories.id, id))
    .limit(1);
  return rows[0];
}

async function updateReferenceCount(id: string, database: DbClient): Promise<void> {
  try {
    await database
      .update(vibeMemories)
      .set({
        referenceCount: sql`${vibeMemories.referenceCount} + 1`,
        lastReferencedAt: new Date(),
      })
      .where(eq(vibeMemories.id, id));
  } catch {
    // Reference counters are observational; excerpt retrieval should not fail because of them.
  }
}

export async function fetchVibeMemory(
  input: VibeMemoryFetchInput,
  deps: { database?: DbClient } = {},
): Promise<VibeMemoryFetchOutput> {
  const maxChars = clampInt(input.maxChars, DEFAULT_FETCH_CHARS, 1, MAX_FETCH_CHARS);
  const database = deps.database ?? db;
  const row = await fetchMemoryRow(input.id, database);
  if (!row) {
    return buildMissingFetchOutput(
      input.id,
      'MEMORY_NOT_FOUND',
      'The requested memory was not found.',
    );
  }

  const totalChars = row.content.length;
  const hasExplicitRange = typeof input.start === 'number' || typeof input.end === 'number';
  let start = 0;
  let end = Math.min(totalChars, maxChars);
  let source: VibeMemoryFetchRangeSource = 'prefix_fallback';
  let matched = false;
  let degraded: VibeMemoryFetchOutput['degraded'];
  let truncated = totalChars > maxChars;

  if (hasExplicitRange) {
    const range = normalizeExplicitRange(input, totalChars, maxChars);
    if ('errorCode' in range) {
      return invalidRangeOutput(input.id, row, range.errorCode, range.message);
    }
    start = range.start;
    end = range.end;
    source = 'explicit_range';
    truncated = range.truncated;
  } else {
    const match =
      findPhraseIndex(row.content, input.query) ?? findTokenIndex(row.content, input.query);
    if (match) {
      const range = windowAroundMatch(row.content, match, maxChars);
      start = range.start;
      end = range.end;
      source = 'query_match';
      matched = true;
      truncated = start > 0 || end < totalChars;
    } else {
      degraded = {
        code: 'NO_EXACT_EXCERPT_MATCH',
        message: input.query
          ? 'No exact phrase or token match was found; returning the beginning of the memory.'
          : 'No query or range was provided; returning the beginning of the memory.',
      };
    }
  }

  const text = row.content.slice(start, end);
  await updateReferenceCount(row.id, database);
  return {
    id: row.id,
    sessionId: row.sessionId,
    createdAt: normalizeCreatedAt(row.createdAt),
    range: { start, end, totalChars, source },
    excerpts: [{ text, matched, start, end }],
    text,
    truncated,
    ...(degraded ? { degraded } : {}),
  };
}
