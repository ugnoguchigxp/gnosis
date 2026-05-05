import { randomUUID } from 'node:crypto';
import { asc, desc, eq, gte, sql } from 'drizzle-orm';
import { runLlmTask } from '../../../adapters/llm.js';
import { config } from '../../../config.js';
import { db as defaultDb } from '../../../db/index.js';
import {
  entities,
  experienceLogs,
  sessionKnowledgeCandidates,
  syncState,
  topicTasks,
} from '../../../db/schema.js';
import { PgJsonbQueueRepository } from '../queue/pgJsonbRepository.js';
import {
  type KeywordSeederRunResult,
  KeywordSeederRunResultSchema,
  type KeywordSource,
  KeywordSourceSchema,
  truncate,
} from './types.js';

const CHECKPOINT_ID = 'knowflow_keyword_cron';
const DEFAULT_SOURCE_FETCH_LIMIT = 10;
const DEFAULT_SOURCE_TEXT_MAX_CHARS = 6000;
const DEFAULT_CONTEXT_MAX_CHARS = 12000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type DatabaseLike = typeof defaultDb;
type QueueRepositoryLike = Pick<PgJsonbQueueRepository, 'enqueue'>;
type SeederLogger = (event: string, payload: Record<string, unknown>) => void;

export type RunKeywordSeederDeps = {
  database?: DatabaseLike;
  queueRepository?: QueueRepositoryLike;
  maxTopics?: number;
  now?: () => Date;
  logger?: SeederLogger;
  sourceLoader?: (input: {
    since: Date;
    limit: number;
    database: DatabaseLike;
  }) => Promise<KeywordSource[]>;
  contextLoader?: (input: {
    sources: KeywordSource[];
    database: DatabaseLike;
  }) => Promise<string>;
  getSinceTime?: (input: {
    database: DatabaseLike;
    now: Date;
    lookbackHours: number;
  }) => Promise<Date>;
  updateCheckpoint?: (input: {
    database: DatabaseLike;
    now: Date;
    cursor: Record<string, unknown>;
  }) => Promise<void>;
  scoutPhrases?: (input: { context: string; maxTopics: number; requestId: string }) => Promise<
    string[]
  >;
};

const defaultLogger: SeederLogger = (event, payload) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...payload,
    }),
  );
};

const getSinceTime = async (
  database: DatabaseLike,
  now: Date,
  lookbackHours: number,
): Promise<Date> => {
  const rows = await database
    .select({ lastSyncedAt: syncState.lastSyncedAt })
    .from(syncState)
    .where(eq(syncState.id, CHECKPOINT_ID))
    .limit(1);

  const fallback = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const lastSyncedAt = rows[0]?.lastSyncedAt;
  if (!lastSyncedAt) return fallback;
  return lastSyncedAt > fallback ? lastSyncedAt : fallback;
};

const updateCheckpoint = async (
  database: DatabaseLike,
  now: Date,
  cursor: Record<string, unknown>,
): Promise<void> => {
  await database
    .insert(syncState)
    .values({
      id: CHECKPOINT_ID,
      lastSyncedAt: now,
      cursor,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: syncState.id,
      set: {
        lastSyncedAt: now,
        cursor,
        updatedAt: now,
      },
    });
};

const defaultSourceLoader = async (input: {
  since: Date;
  limit: number;
  database: DatabaseLike;
}): Promise<KeywordSource[]> => {
  const safeLimit = Math.max(1, Math.trunc(input.limit));
  const experiences = await input.database
    .select({
      id: experienceLogs.id,
      content: experienceLogs.content,
      createdAt: experienceLogs.createdAt,
    })
    .from(experienceLogs)
    .where(gte(experienceLogs.createdAt, input.since))
    .orderBy(asc(experienceLogs.createdAt))
    .limit(safeLimit);

  return experiences.map((row) =>
    KeywordSourceSchema.parse({
      sourceType: 'experience',
      sourceId: row.id,
      content: row.content,
      createdAt: row.createdAt,
    }),
  );
};

const defaultContextLoader = async (input: {
  sources: KeywordSource[];
  database: DatabaseLike;
}): Promise<string> => {
  const recentConcepts = await input.database
    .select({ name: entities.name, description: entities.description, type: entities.type })
    .from(entities)
    .where(sql`${entities.type} <> 'knowflow_topic_state'`)
    .orderBy(desc(entities.createdAt))
    .limit(12);
  const recentQueueTopics = await input.database
    .select({
      payload: topicTasks.payload,
      status: topicTasks.status,
    })
    .from(topicTasks)
    .orderBy(desc(topicTasks.updatedAt))
    .limit(20);
  const recentSessionNotes = await input.database
    .select({
      title: sessionKnowledgeCandidates.title,
      statement: sessionKnowledgeCandidates.statement,
      kind: sessionKnowledgeCandidates.kind,
    })
    .from(sessionKnowledgeCandidates)
    .where(eq(sessionKnowledgeCandidates.keep, true))
    .orderBy(desc(sessionKnowledgeCandidates.updatedAt))
    .limit(8);

  const sourceText = input.sources
    .map(
      (source, index) =>
        `Recent work log ${index + 1} (${source.sourceType}:${source.sourceId}):\n${truncate(
          source.content,
          DEFAULT_SOURCE_TEXT_MAX_CHARS,
        )}`,
    )
    .join('\n\n');

  const knowledgeText = recentConcepts
    .map((item, index) => {
      const description = item.description ? truncate(item.description, 500) : '';
      return `Existing knowledge ${index + 1}: ${item.name} [${item.type}]\n${description}`;
    })
    .join('\n\n');
  const queueText = recentQueueTopics
    .map((item, index) => {
      const payload = isRecord(item.payload) ? item.payload : {};
      const topic = typeof payload.topic === 'string' ? payload.topic : '(unknown topic)';
      const requestedBy = typeof payload.requestedBy === 'string' ? payload.requestedBy : 'unknown';
      return `Recent queue topic ${index + 1}: ${topic} [${item.status}, ${requestedBy}]`;
    })
    .join('\n');
  const sessionText = recentSessionNotes
    .map(
      (item, index) =>
        `Session knowledge ${index + 1}: ${item.title} [${item.kind}]\n${truncate(
          item.statement,
          500,
        )}`,
    )
    .join('\n\n');

  const context = [
    'Local repository and operating context: TypeScript, Bun, PostgreSQL, Drizzle, MCP tools, local LLM routing, knowledge graph operations, tests, background workers, CLI automation, code review.',
    sourceText,
    sessionText,
    knowledgeText,
    queueText,
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n\n---\n\n');

  return truncate(context, DEFAULT_CONTEXT_MAX_CHARS);
};

const parsePhraseLines = (text: string, limit: number): string[] => {
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const line of text.split('\n')) {
    const phrase = line.trim();
    const key = phrase.toLowerCase();
    if (!phrase || seen.has(key)) continue;
    seen.add(key);
    phrases.push(phrase);
    if (phrases.length >= limit) break;
  }
  return phrases;
};

const defaultScoutPhrases = async (input: {
  context: string;
  maxTopics: number;
  requestId: string;
}): Promise<string[]> => {
  const result = await runLlmTask({
    task: 'phrase_scout',
    context: {
      context: input.context,
      max_topics: input.maxTopics,
    },
    requestId: input.requestId,
    priority: 'low',
  });
  return parsePhraseLines(result.text, input.maxTopics);
};

export const runKeywordSeederOnce = async (
  deps: RunKeywordSeederDeps = {},
): Promise<KeywordSeederRunResult> => {
  const database = deps.database ?? defaultDb;
  const queueRepository = deps.queueRepository ?? new PgJsonbQueueRepository(database);
  const sourceLoader = deps.sourceLoader ?? defaultSourceLoader;
  const contextLoader = deps.contextLoader ?? defaultContextLoader;
  const resolveSinceTime =
    deps.getSinceTime ?? ((input) => getSinceTime(input.database, input.now, input.lookbackHours));
  const persistCheckpoint =
    deps.updateCheckpoint ?? ((input) => updateCheckpoint(input.database, input.now, input.cursor));
  const scoutPhrases = deps.scoutPhrases ?? defaultScoutPhrases;
  const logger = deps.logger ?? defaultLogger;
  const now = deps.now?.() ?? new Date();

  if (!config.knowflow.keywordCron.enabled) {
    const disabled = KeywordSeederRunResultSchema.parse({
      runId: randomUUID(),
      sources: 0,
      phrases: 0,
      enqueued: 0,
      skipped: 0,
      deduped: 0,
    });
    logger('knowflow.phrase_scout.disabled', disabled);
    return disabled;
  }

  const runId = randomUUID();
  const maxTopics = Math.max(
    1,
    Math.trunc(deps.maxTopics ?? config.knowflow.keywordCron.maxTopics),
  );
  const since = await resolveSinceTime({
    database,
    now,
    lookbackHours: config.knowflow.keywordCron.lookbackHours,
  });

  const sources = await sourceLoader({
    since,
    limit: Math.max(DEFAULT_SOURCE_FETCH_LIMIT, maxTopics),
    database,
  });

  let phrases: string[] = [];
  try {
    const context = await contextLoader({ sources, database });
    phrases = await scoutPhrases({ context, maxTopics, requestId: runId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger('knowflow.phrase_scout.failed', {
      runId,
      error: message,
    });
    throw new Error(`Phrase Scout failed: ${message}`);
  }

  let enqueued = 0;
  let deduped = 0;
  for (const phrase of phrases) {
    const result = await queueRepository.enqueue({
      topic: phrase,
      mode: 'directed',
      source: 'cron',
      sourceGroup: 'phrase-scout',
      requestedBy: 'phrase-scout',
      metadata: {
        source: 'phrase_scout',
        runId,
      },
    });
    if (result.deduped) {
      deduped += 1;
    } else {
      enqueued += 1;
    }
  }

  await persistCheckpoint({
    database,
    now,
    cursor: {
      runId,
      since: since.toISOString(),
      sources: sources.length,
      phrases: phrases.length,
      enqueued,
      deduped,
    },
  });

  const result = KeywordSeederRunResultSchema.parse({
    runId,
    sources: sources.length,
    phrases: phrases.length,
    enqueued,
    skipped: Math.max(0, phrases.length - enqueued - deduped),
    deduped,
  });

  logger('knowflow.phrase_scout.completed', result);
  return result;
};
