import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { and, asc, eq, gte } from 'drizzle-orm';
import { type KeywordEvalAlias, config } from '../../../config.js';
import { db as defaultDb } from '../../../db/index.js';
import { experienceLogs, syncState, vibeMemories } from '../../../db/schema.js';
import { PgJsonbQueueRepository } from '../queue/pgJsonbRepository.js';
import { KeywordEvaluationRepository } from './evaluationRepository.js';
import { parseJsonFromLlmText, runPromptWithAlias } from './llmRouter.js';
import {
  type KeywordEvaluationItem,
  KeywordEvaluationResponseSchema,
  type KeywordEvaluationRow,
  type KeywordSeederRunResult,
  KeywordSeederRunResultSchema,
  type KeywordSource,
  KeywordSourceSchema,
  normalizeTopic,
  truncate,
} from './types.js';

const CHECKPOINT_ID = 'knowflow_keyword_cron';
const DEFAULT_SOURCE_FETCH_LIMIT = 10;
const DEFAULT_SOURCE_TEXT_MAX_CHARS = 6000;
const DEFAULT_MAX_ITEMS_PER_SOURCE = 3;

type DatabaseLike = typeof defaultDb;

type QueueRepositoryLike = Pick<PgJsonbQueueRepository, 'enqueue'>;

type SeederLogger = (event: string, payload: Record<string, unknown>) => void;

export type RunKeywordSeederDeps = {
  database?: DatabaseLike;
  queueRepository?: QueueRepositoryLike;
  evaluationRepository?: KeywordEvaluationRepository;
  now?: () => Date;
  logger?: SeederLogger;
  sourceLoader?: (input: {
    since: Date;
    limit: number;
    database: DatabaseLike;
  }) => Promise<KeywordSource[]>;
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
  evaluateSource?: (input: {
    source: KeywordSource;
    alias: KeywordEvalAlias;
    fallbackAlias?: KeywordEvalAlias;
    maxItems: number;
  }) => Promise<{ items: KeywordEvaluationItem[]; aliasUsed: KeywordEvalAlias }>;
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

const promptTemplatePromise = readFile(
  new URL('../prompts/keyword_seed_evaluation.md', import.meta.url),
  'utf-8',
);

const renderPrompt = (
  template: string,
  input: {
    sourceType: string;
    sourceId: string;
    maxItems: number;
    sourceText: string;
  },
): string => {
  return template
    .replaceAll('{{source_type}}', input.sourceType)
    .replaceAll('{{source_id}}', input.sourceId)
    .replaceAll('{{max_items}}', String(input.maxItems))
    .replaceAll('{{source_text}}', input.sourceText);
};

const parseEvaluationItems = (raw: string): KeywordEvaluationItem[] => {
  const parsed = parseJsonFromLlmText<unknown>(raw);
  const output = KeywordEvaluationResponseSchema.parse(parsed);
  return output.items;
};

const dedupeItemsByTopic = (items: KeywordEvaluationItem[]): KeywordEvaluationItem[] => {
  const seen = new Set<string>();
  const out: KeywordEvaluationItem[] = [];

  for (const item of items) {
    const key = normalizeTopic(item.topic).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
};

const defaultEvaluateSource = async (input: {
  source: KeywordSource;
  alias: KeywordEvalAlias;
  fallbackAlias?: KeywordEvalAlias;
  maxItems: number;
}): Promise<{ items: KeywordEvaluationItem[]; aliasUsed: KeywordEvalAlias }> => {
  const template = await promptTemplatePromise;
  const prompt = renderPrompt(template, {
    sourceType: input.source.sourceType,
    sourceId: input.source.sourceId,
    maxItems: input.maxItems,
    sourceText: truncate(input.source.content, DEFAULT_SOURCE_TEXT_MAX_CHARS),
  });

  const routed = await runPromptWithAlias(prompt, {
    alias: input.alias,
    fallbackAlias: input.fallbackAlias,
    maxTokens: 1200,
    timeoutMs: config.knowflow.llm.timeoutMs,
  });
  const parsedItems = parseEvaluationItems(routed.output);
  const items = dedupeItemsByTopic(parsedItems).slice(0, Math.max(1, input.maxItems));
  return { items, aliasUsed: routed.aliasUsed };
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

  const [episodes, experiences] = await Promise.all([
    input.database
      .select({
        id: vibeMemories.id,
        content: vibeMemories.content,
        createdAt: vibeMemories.createdAt,
      })
      .from(vibeMemories)
      .where(
        and(
          eq(vibeMemories.memoryType, 'episode'),
          gte(vibeMemories.createdAt, input.since),
          eq(vibeMemories.isSynthesized, false),
        ),
      )
      .orderBy(asc(vibeMemories.createdAt))
      .limit(safeLimit),
    input.database
      .select({
        id: experienceLogs.id,
        content: experienceLogs.content,
        createdAt: experienceLogs.createdAt,
      })
      .from(experienceLogs)
      .where(gte(experienceLogs.createdAt, input.since))
      .orderBy(asc(experienceLogs.createdAt))
      .limit(safeLimit),
  ]);

  const sources = [
    ...episodes.map((row) =>
      KeywordSourceSchema.parse({
        sourceType: 'episode',
        sourceId: row.id,
        content: row.content,
        createdAt: row.createdAt,
      }),
    ),
    ...experiences.map((row) =>
      KeywordSourceSchema.parse({
        sourceType: 'experience',
        sourceId: row.id,
        content: row.content,
        createdAt: row.createdAt,
      }),
    ),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  return sources.slice(0, safeLimit);
};

export const runKeywordSeederOnce = async (
  deps: RunKeywordSeederDeps = {},
): Promise<KeywordSeederRunResult> => {
  const database = deps.database ?? defaultDb;
  const queueRepository = deps.queueRepository ?? new PgJsonbQueueRepository(database);
  const evaluationRepository =
    deps.evaluationRepository ?? new KeywordEvaluationRepository(database);
  const sourceLoader = deps.sourceLoader ?? defaultSourceLoader;
  const resolveSinceTime =
    deps.getSinceTime ?? ((input) => getSinceTime(input.database, input.now, input.lookbackHours));
  const persistCheckpoint =
    deps.updateCheckpoint ?? ((input) => updateCheckpoint(input.database, input.now, input.cursor));
  const evaluateSource = deps.evaluateSource ?? defaultEvaluateSource;
  const logger = deps.logger ?? defaultLogger;
  const now = deps.now?.() ?? new Date();

  if (!config.knowflow.keywordCron.enabled) {
    const disabled = KeywordSeederRunResultSchema.parse({
      runId: randomUUID(),
      aliasUsed: config.knowflow.keywordCron.evalModelAlias,
      threshold: config.knowflow.keywordCron.minResearchScore,
      sources: 0,
      evaluated: 0,
      enqueued: 0,
      skipped: 0,
      deduped: 0,
    });
    logger('knowflow.keyword_seeder.disabled', disabled);
    return disabled;
  }

  const runId = randomUUID();
  const primaryAlias = config.knowflow.keywordCron.evalModelAlias;
  const fallbackAlias = config.knowflow.keywordCron.evalFallbackAlias;
  const threshold = config.knowflow.keywordCron.minResearchScore;
  const maxTopics = config.knowflow.keywordCron.maxTopics;
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

  const evaluationRows: KeywordEvaluationRow[] = [];
  let enqueued = 0;
  let skipped = 0;
  let deduped = 0;
  let fallbackAliasUsed: KeywordEvalAlias | undefined;

  const maxParallel = config.knowflow.keywordCron.maxParallelEvaluations;
  const sourceQueue = [...sources];

  const processSource = async (source: KeywordSource) => {
    try {
      const evaluated = await evaluateSource({
        source,
        alias: primaryAlias,
        fallbackAlias,
        maxItems: DEFAULT_MAX_ITEMS_PER_SOURCE,
      });

      if (evaluated.aliasUsed !== primaryAlias) {
        fallbackAliasUsed = evaluated.aliasUsed;
      }

      for (const item of evaluated.items) {
        const topic = normalizeTopic(item.topic);
        if (!topic) continue;

        // Note: enqueued check here is a soft limit as parallel workers might overlap slightly,
        // but since JS is single-threaded between awaits, this is mostly safe.
        const shouldEnqueue = item.search_score > threshold && enqueued < maxTopics;
        let enqueuedTaskId: string | undefined;
        const decision: 'enqueued' | 'skipped' = shouldEnqueue ? 'enqueued' : 'skipped';

        if (shouldEnqueue) {
          const enqueueResult = await queueRepository.enqueue({
            topic,
            mode: 'directed',
            source: 'cron',
            sourceGroup: 'keyword-seeder',
            requestedBy: 'keyword-seeder',
            priority: 1,
            evaluation: {
              category: item.category,
              whyResearch: item.why_research,
              searchScore: item.search_score,
              termDifficultyScore: item.term_difficulty_score,
              uncertaintyScore: item.uncertainty_score,
              scoreEvaluatedAt: now.toISOString(),
            },
          });
          enqueuedTaskId = enqueueResult.task.id;
          enqueued += 1;
          if (enqueueResult.deduped) {
            deduped += 1;
          }
        } else {
          skipped += 1;
        }

        evaluationRows.push({
          runId,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          topic,
          category: item.category,
          whyResearch: item.why_research,
          searchScore: item.search_score,
          termDifficultyScore: item.term_difficulty_score,
          uncertaintyScore: item.uncertainty_score,
          threshold,
          decision,
          enqueuedTaskId,
          modelAlias: evaluated.aliasUsed,
          createdAt: now,
        });
      }
    } catch (error) {
      logger('knowflow.keyword_seeder.source_failed', {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const workers = [];
  const workerCount = Math.min(maxParallel, sources.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(
      (async () => {
        while (sourceQueue.length > 0) {
          const source = sourceQueue.shift();
          if (source) {
            await processSource(source);
          }
        }
      })(),
    );
  }

  await Promise.all(workers);

  await evaluationRepository.saveEvaluations(evaluationRows);
  await persistCheckpoint({
    database,
    now,
    cursor: {
      runId,
      since: since.toISOString(),
      evaluated: evaluationRows.length,
      enqueued,
      skipped,
      aliasUsed: primaryAlias,
      fallbackAliasUsed,
    },
  });

  const result = KeywordSeederRunResultSchema.parse({
    runId,
    aliasUsed: primaryAlias,
    fallbackAliasUsed,
    threshold,
    sources: sources.length,
    evaluated: evaluationRows.length,
    enqueued,
    skipped,
    deduped,
  });

  logger('knowflow.keyword_seeder.completed', result);
  return result;
};
