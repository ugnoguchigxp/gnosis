import { eq, sql } from 'drizzle-orm';
import { type LlmLogEvent, runLlmTask } from '../../../adapters/llm.js';
import type { Retriever } from '../../../adapters/retriever/mcpRetriever.js';
import { type BudgetConfig, type LlmClientConfig, config } from '../../../config.js';
import { db as defaultDb } from '../../../db/index.js';
import { entities, relations } from '../../../db/schema.js';
import { generateEntityId } from '../../../utils/entityId.js';
import type { TopicTask } from '../domain/task';
import type { FlowEvidence } from '../flows/types';
import { GapPlanner } from '../gap/planner.js';
import type { Knowledge, KnowledgeUpsertInput } from '../knowledge/types';
import type { Relation, SourceRef } from '../knowledge/types';
import { extractEvidenceFromText } from '../ops/evidenceExtractor';
import { type StructuredLogger, defaultStructuredLogger } from '../ops/logger';
import { MetricsCollector } from '../ops/metrics';
import type { QueueRepository } from '../queue/repository';
import {
  EXHAUSTED_RETRY_MS,
  EXPLORED_COOLDOWN_MS,
  generateTopicStateEntityId,
  hashSearchAttempt,
  isKnowflowTopicSuppressed,
  isoAfter,
} from '../state/topicState.js';
import type { EvidenceClaim, EvidenceSource } from '../verifier';
import type { TaskExecutionResult, TaskHandler } from './loop';
import { PipelineOrchestrator } from './pipeline.js';

const MAX_INITIAL_QUERIES = 3;
const MAX_FETCHED_PAGES_PER_TASK = 5;
const MAX_CONTENT_CHARS = 6000;
const MIN_USEFULNESS_SCORE = 0.65;
const MIN_EMERGENT_TOPIC_SCORE = 0.6;
const MIN_EMERGENT_DIMENSION_SCORE = 0.45;
const HIGH_IMPORTANCE_PRIORITY = 80;

export type KnowledgeRepositoryLike = {
  getByTopic: (topic: string) => Promise<Knowledge | null>;
  merge: (input: KnowledgeUpsertInput) => Promise<{ knowledge: Knowledge; changed: boolean }>;
};

export type EvidenceProvider = (task: TopicTask, signal?: AbortSignal) => Promise<FlowEvidence>;

export type CreateKnowFlowTaskHandlerOptions = {
  repository: KnowledgeRepositoryLike;
  evidenceProvider?: EvidenceProvider;
  budget?: Partial<BudgetConfig>;
  cronRunWindowMs?: number;
  logger?: StructuredLogger;
  metrics?: MetricsCollector;
  now?: () => number;

  // For GapPlanner
  queueRepository?: QueueRepository;
  llmConfig?: Partial<LlmClientConfig>;
  llmLogger?: (event: LlmLogEvent) => void;
};

export type McpEvidenceProviderOptions = {
  logger?: StructuredLogger;
  llmConfig?: Partial<LlmClientConfig>;
  llmLogger?: (event: LlmLogEvent) => void;
  runLlmTask?: typeof runLlmTask;
  extractEvidence?: typeof extractEvidenceFromText;
};

type ParsedSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

const uniqueByUrl = (items: ParsedSearchResult[]): ParsedSearchResult[] => {
  const seen = new Set<string>();
  const out: ParsedSearchResult[] = [];
  for (const item of items) {
    const url = item.url.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ...item, url });
  }
  return out;
};

const parseSearchResults = (text: string): ParsedSearchResult[] => {
  const results: ParsedSearchResult[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    const match = line.match(/^-\s+(.+?)\s+\((https?:\/\/[^)]+)\)$/);
    if (!match) continue;

    const snippetParts: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor] ?? '';
      if (next.trim().startsWith('- ')) break;
      if (next.trim()) snippetParts.push(next.trim());
      index = cursor;
    }

    results.push({
      title: match[1],
      url: match[2],
      snippet: snippetParts.join(' '),
    });
  }
  return uniqueByUrl(results);
};

const truncateContent = (contentRaw: string): string =>
  contentRaw.length > MAX_CONTENT_CHARS
    ? `${contentRaw.slice(0, MAX_CONTENT_CHARS)}\n\n[...Truncated from ${
        contentRaw.length
      } chars...]`
    : contentRaw;

const normalizeTopicKey = (topic: string): string =>
  topic.trim().toLowerCase().replace(/\s+/g, ' ');

const allowedExpansionRelation = (value: string | undefined): string => {
  switch (value) {
    case 'expands':
    case 'supports':
    case 'depends_on':
    case 'used_for':
    case 'alternative_to':
    case 'contradicts':
    case 'related_to':
      return value;
    default:
      return 'expands';
  }
};

const requiredUsefulPageCount = (task: TopicTask): number =>
  task.priority >= HIGH_IMPORTANCE_PRIORITY ? 2 : 1;

const hostnameForUrl = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
};

const emergentTopicQualityScore = (item: {
  score: number;
  noveltyScore?: number;
  specificityScore?: number;
  actionabilityScore?: number;
  communityFitScore?: number;
}): number => {
  const novelty = item.noveltyScore ?? item.score;
  const specificity = item.specificityScore ?? item.score;
  const actionability = item.actionabilityScore ?? item.score;
  const communityFit = item.communityFitScore ?? item.score;
  return Number(
    (
      item.score * 0.35 +
      novelty * 0.2 +
      specificity * 0.2 +
      actionability * 0.2 +
      communityFit * 0.05
    ).toFixed(4),
  );
};

const collectEmergentTopics = async (input: {
  runLlmTask: typeof runLlmTask;
  task: TopicTask;
  query: string;
  url: string;
  title: string;
  text: string;
  seenEmergentTopics: Set<string>;
  logger: StructuredLogger;
  llmConfig?: Partial<LlmClientConfig>;
  llmLogger?: (event: LlmLogEvent) => void;
  signal?: AbortSignal;
}): Promise<NonNullable<FlowEvidence['emergentTopics']>> => {
  try {
    const emergent = await input.runLlmTask(
      {
        task: 'emergent_topic_extraction',
        context: {
          topic: input.task.topic,
          query: input.query,
          url: input.url,
          title: input.title,
          text: input.text,
        },
        requestId: input.task.id,
      },
      {
        config: input.llmConfig,
        deps: input.llmLogger ? { logger: input.llmLogger } : undefined,
        signal: input.signal,
      },
    );

    const collected: NonNullable<FlowEvidence['emergentTopics']> = [];
    for (const item of emergent.output.items) {
      const noveltyScore = item.noveltyScore ?? item.score;
      const specificityScore = item.specificityScore ?? item.score;
      const actionabilityScore = item.actionabilityScore ?? item.score;
      const communityFitScore = item.communityFitScore ?? item.score;
      const qualityScore = emergentTopicQualityScore({
        score: item.score,
        noveltyScore,
        specificityScore,
        actionabilityScore,
        communityFitScore,
      });
      if (
        qualityScore < MIN_EMERGENT_TOPIC_SCORE ||
        specificityScore < MIN_EMERGENT_DIMENSION_SCORE ||
        actionabilityScore < MIN_EMERGENT_DIMENSION_SCORE
      ) {
        continue;
      }
      const key = normalizeTopicKey(item.topic);
      if (
        !key ||
        key === normalizeTopicKey(input.task.topic) ||
        input.seenEmergentTopics.has(key)
      ) {
        continue;
      }
      input.seenEmergentTopics.add(key);
      collected.push({
        topic: item.topic.trim(),
        whyResearch: item.whyResearch,
        relationType: allowedExpansionRelation(item.relationType),
        score: qualityScore,
        noveltyScore,
        specificityScore,
        actionabilityScore,
        communityFitScore,
        sourceUrl: input.url,
      });
    }
    return collected;
  } catch (error) {
    input.logger({
      event: 'knowflow.emergent_topics.extract_error',
      taskId: input.task.id,
      topic: input.task.topic,
      url: input.url,
      message: error instanceof Error ? error.message : String(error),
      level: 'warn',
    });
    return [];
  }
};

export const createMcpEvidenceProvider = (
  retriever: Retriever,
  options?: McpEvidenceProviderOptions,
): EvidenceProvider => {
  const logger = options?.logger ?? defaultStructuredLogger;
  const _runLlmTask = options?.runLlmTask ?? runLlmTask;
  const _extractEvidence = options?.extractEvidence ?? extractEvidenceFromText;

  return async (task, signal): Promise<FlowEvidence> => {
    logger({
      event: 'retriever.mcp.start',
      taskId: task.id,
      topic: task.topic,
      level: 'info',
    });

    const queryResult = await _runLlmTask(
      {
        task: 'query_generation',
        context: { topic: task.topic },
        requestId: task.id,
      },
      {
        config: options?.llmConfig,
        deps: options?.llmLogger ? { logger: options.llmLogger } : undefined,
        signal,
      },
    );

    // LLMがdegradedの場合（フォールバック出力）はMCP検索をスキップ
    if (queryResult.degraded) {
      logger({
        event: 'retriever.mcp.skipped',
        taskId: task.id,
        topic: task.topic,
        level: 'warn',
        message: 'LLM degraded, skipping MCP search to avoid connection errors',
      });
      return {
        claims: [],
        sources: [],
        normalizedSources: [],
        relations: [],
        queryCountUsed: 0,
      };
    }

    const queries = queryResult.output.queries.slice(0, MAX_INITIAL_QUERIES);
    const allClaims: EvidenceClaim[] = [];
    const allSources: EvidenceSource[] = [];
    const allNormalized: SourceRef[] = [];
    const allRelations: Relation[] = [];
    const allEmergentTopics: NonNullable<FlowEvidence['emergentTopics']> = [];
    const seenEmergentTopics = new Set<string>();
    const fetchedPageUrls = new Set<string>();
    const searchQueries: string[] = [];
    const usefulDomains = new Set<string>();
    const requiredUsefulPages = requiredUsefulPageCount(task);
    let queryCountUsed = 0;

    for (const query of queries) {
      if (queryCountUsed >= config.knowflow.worker.maxQueriesPerTask) break; // Hard limit
      if (fetchedPageUrls.size >= MAX_FETCHED_PAGES_PER_TASK) break;
      if (usefulDomains.size >= requiredUsefulPages) break;

      let searchResultText: string;
      try {
        searchResultText = await retriever.search(query, signal);
      } catch (searchError) {
        logger({
          event: 'retriever.mcp.search_error',
          taskId: task.id,
          query,
          message: searchError instanceof Error ? searchError.message : String(searchError),
          level: 'warn',
        });
        continue; // 検索失敗は次のクエリへ
      }
      queryCountUsed += 1;
      searchQueries.push(query);

      const searchResults = parseSearchResults(searchResultText);
      if (searchResults.length === 0) {
        logger({
          event: 'retriever.mcp.no_search_results',
          taskId: task.id,
          query,
          level: 'warn',
        });
        continue;
      }

      const selectionResult = await _runLlmTask(
        {
          task: 'search_result_selection',
          context: {
            topic: task.topic,
            query,
            max_pages: MAX_FETCHED_PAGES_PER_TASK,
            results: searchResults.slice(0, 10),
          },
          requestId: task.id,
        },
        {
          config: options?.llmConfig,
          deps: options?.llmLogger ? { logger: options.llmLogger } : undefined,
          signal,
        },
      );

      const searchResultByUrl = new Map(searchResults.map((result) => [result.url, result]));
      const selectedUrls = selectionResult.output.selected
        .map((item) => item.url)
        .filter((url) => searchResultByUrl.has(url));
      const urls =
        selectedUrls.length > 0
          ? [...new Set(selectedUrls)].slice(0, MAX_FETCHED_PAGES_PER_TASK)
          : searchResults.map((result) => result.url).slice(0, MAX_FETCHED_PAGES_PER_TASK);

      for (const url of urls) {
        if (fetchedPageUrls.size >= MAX_FETCHED_PAGES_PER_TASK) break;
        if (fetchedPageUrls.has(url)) continue;
        fetchedPageUrls.add(url);

        try {
          const startTime = Date.now();
          const contentRaw = await retriever.fetch(url, signal);
          const content = truncateContent(contentRaw);
          const searchResult = searchResultByUrl.get(url);
          allEmergentTopics.push(
            ...(await collectEmergentTopics({
              runLlmTask: _runLlmTask,
              task,
              query,
              url,
              title: searchResult?.title ?? query,
              text: content,
              seenEmergentTopics,
              logger,
              llmConfig: options?.llmConfig,
              llmLogger: options?.llmLogger,
              signal,
            })),
          );

          const usefulness = await _runLlmTask(
            {
              task: 'page_usefulness_evaluation',
              context: {
                topic: task.topic,
                query,
                url,
                title: searchResult?.title ?? query,
                snippet: searchResult?.snippet ?? '',
                text: content,
              },
              requestId: task.id,
            },
            {
              config: options?.llmConfig,
              deps: options?.llmLogger ? { logger: options.llmLogger } : undefined,
              signal,
            },
          );

          if (!usefulness.output.useful || usefulness.output.score < MIN_USEFULNESS_SCORE) {
            logger({
              event: 'retriever.mcp.fetch_not_useful',
              taskId: task.id,
              url,
              score: usefulness.output.score,
              reason: usefulness.output.reason,
              level: 'info',
            });
            continue;
          }

          const extracted = await _extractEvidence({
            topic: task.topic,
            url,
            title: searchResult?.title ?? query,
            text: content,
            requestId: task.id,
            llmConfig: options?.llmConfig,
            llmLogger: options?.llmLogger,
            signal,
          });

          const durationMs = Date.now() - startTime;
          logger({
            event: 'retriever.mcp.fetch_and_extract.done',
            taskId: task.id,
            url,
            durationMs,
            claims: extracted.claims.length,
            level: 'info',
          });

          allClaims.push(...extracted.claims);
          allSources.push(...extracted.sources);
          allNormalized.push(...(extracted.normalizedSources ?? []));
          allRelations.push(...(extracted.relations ?? []));

          usefulDomains.add(hostnameForUrl(url));
          if (usefulDomains.size >= requiredUsefulPages) {
            break;
          }
        } catch (error) {
          logger({
            event: 'retriever.mcp.fetch_error',
            taskId: task.id,
            url,
            message: error instanceof Error ? error.message : String(error),
            level: 'warn',
          });
        }
      }
    }

    return {
      claims: allClaims,
      sources: allSources,
      normalizedSources: allNormalized,
      relations: allRelations,
      emergentTopics: allEmergentTopics,
      queryCountUsed,
      searchQueries,
      usefulPageFound: usefulDomains.size > 0,
      usefulPageCount: usefulDomains.size,
      requiredUsefulPageCount: requiredUsefulPages,
      fetchedPageCount: fetchedPageUrls.size,
    };
  };
};

const markTopicExplorationResult = async (input: {
  task: TopicTask;
  evidence: FlowEvidence;
  logger: StructuredLogger;
}): Promise<void> => {
  const fetchedPageCount = input.evidence.fetchedPageCount ?? 0;
  const usefulPageCount =
    input.evidence.usefulPageCount ?? (input.evidence.usefulPageFound ? 1 : 0);
  const requiredUsefulPageCount = input.evidence.requiredUsefulPageCount ?? 1;
  const status =
    usefulPageCount >= requiredUsefulPageCount
      ? 'explored'
      : fetchedPageCount > 0
        ? 'exhausted'
        : undefined;
  if (!status) {
    return;
  }

  const stateId = generateTopicStateEntityId(input.task.topic);
  const now = new Date();
  const nowIso = now.toISOString();
  const metadata = {
    kind: 'knowflow_topic_state',
    source: 'knowflow',
    seedEntityId: input.task.expansion?.seedEntityId,
    parentTaskId: input.task.expansion?.parentTaskId,
    sourceUrl: input.task.expansion?.sourceUrl,
    whyResearch: input.task.expansion?.whyResearch,
    status,
    knowflowStatus: status,
    lastKnowflowTaskId: input.task.id,
    lastKnowflowUpdatedAt: nowIso,
    usefulPageFound: input.evidence.usefulPageFound ?? false,
    usefulPageCount,
    requiredUsefulPageCount,
    fetchedPageCount,
    searchQueries: input.evidence.searchQueries ?? [],
    ...(status === 'exhausted'
      ? {
          exhaustedAt: nowIso,
          exhaustedReason:
            usefulPageCount > 0
              ? 'Useful evidence was found, but the required independent source count was not met within fetch budget.'
              : 'No useful page found within fetch budget.',
          exhaustedQueryHash: hashSearchAttempt({
            topic: input.task.topic,
            queries: input.evidence.searchQueries,
          }),
          retryAfter: isoAfter(now, EXHAUSTED_RETRY_MS),
        }
      : {
          exploredAt: nowIso,
          lastExploredAt: nowIso,
          cooldownUntil: isoAfter(now, EXPLORED_COOLDOWN_MS),
        }),
  };

  await defaultDb
    .insert(entities)
    .values({
      id: stateId,
      type: 'knowflow_topic_state',
      name: input.task.topic,
      description:
        status === 'exhausted'
          ? 'KnowFlow tried to deepen this topic but did not find a sufficiently useful page.'
          : 'KnowFlow has already explored this topic.',
      communityId: input.task.expansion?.seedCommunityId,
      metadata,
      confidence: status === 'explored' ? 0.8 : 0.4,
      provenance: 'knowflow',
      scope: 'on_demand',
      freshness: now,
    })
    .onConflictDoUpdate({
      target: entities.id,
      set: {
        description: sql`excluded.description`,
        communityId: sql`COALESCE(${entities.communityId}, excluded.community_id)`,
        metadata: sql`${entities.metadata} || excluded.metadata`,
        confidence: sql`GREATEST(COALESCE(${entities.confidence}, 0), excluded.confidence)`,
        provenance: sql`excluded.provenance`,
        freshness: sql`excluded.freshness`,
      },
    })
    .returning({ id: entities.id });

  if (input.task.expansion?.seedEntityId && input.task.expansion.seedEntityId !== stateId) {
    await defaultDb
      .insert(relations)
      .values({
        sourceId: input.task.expansion.seedEntityId,
        targetId: stateId,
        relationType: input.task.expansion.relationType ?? 'expands',
        weight: status === 'explored' ? 0.8 : 0.4,
        confidence: status === 'explored' ? 0.8 : 0.4,
        sourceTask: input.task.id,
        provenance: 'knowflow',
      })
      .onConflictDoNothing();
  }

  input.logger({
    event: 'knowflow.topic.status_updated',
    taskId: input.task.id,
    topic: input.task.topic,
    stateId,
    status,
    fetchedPageCount,
    usefulPageCount,
    requiredUsefulPageCount,
    level: 'info',
  });
};

const enqueueEmergentTopics = async (input: {
  task: TopicTask;
  evidence: FlowEvidence;
  queueRepository?: QueueRepository;
  logger: StructuredLogger;
}): Promise<number> => {
  const topics = input.evidence.emergentTopics ?? [];
  if (!input.queueRepository || topics.length === 0) {
    return 0;
  }

  let seedEntity: typeof entities.$inferSelect | undefined;
  if (input.task.expansion?.seedEntityId) {
    [seedEntity] = await defaultDb
      .select()
      .from(entities)
      .where(eq(entities.id, input.task.expansion.seedEntityId))
      .limit(1);
  }

  let enqueued = 0;
  for (const topic of topics) {
    const relationType = allowedExpansionRelation(topic.relationType);
    const conceptId = generateEntityId('concept', topic.topic);
    const stateId = generateTopicStateEntityId(topic.topic);
    const communityId = seedEntity?.communityId ?? input.task.expansion?.seedCommunityId;
    const [existingConcept] = await defaultDb
      .select({ id: entities.id, metadata: entities.metadata })
      .from(entities)
      .where(eq(entities.id, conceptId))
      .limit(1);
    const [existingState] = await defaultDb
      .select({ id: entities.id, metadata: entities.metadata })
      .from(entities)
      .where(eq(entities.id, stateId))
      .limit(1);
    const shouldSkipQueue =
      isKnowflowTopicSuppressed(existingState?.metadata) ||
      isKnowflowTopicSuppressed(existingConcept?.metadata);

    await defaultDb
      .insert(entities)
      .values({
        id: conceptId,
        type: 'concept',
        name: topic.topic,
        description: topic.whyResearch,
        communityId,
        metadata: {
          kind: 'knowflow_emergent_topic',
          source: 'knowflow',
          parentTaskId: input.task.id,
          seedEntityId: seedEntity?.id ?? input.task.expansion?.seedEntityId,
          sourceUrl: topic.sourceUrl,
          score: topic.score,
          noveltyScore: topic.noveltyScore,
          specificityScore: topic.specificityScore,
          actionabilityScore: topic.actionabilityScore,
          communityFitScore: topic.communityFitScore,
          relationType,
        },
        confidence: topic.score,
        provenance: 'knowflow',
        scope: 'on_demand',
        freshness: new Date(),
      })
      .onConflictDoUpdate({
        target: entities.id,
        set: {
          description: sql`excluded.description`,
          communityId: sql`COALESCE(${entities.communityId}, excluded.community_id)`,
          metadata: sql`${entities.metadata} || excluded.metadata`,
          confidence: sql`GREATEST(COALESCE(${entities.confidence}, 0), excluded.confidence)`,
          provenance: sql`excluded.provenance`,
          freshness: sql`excluded.freshness`,
        },
      });

    if (seedEntity) {
      await defaultDb
        .insert(relations)
        .values({
          sourceId: seedEntity.id,
          targetId: conceptId,
          relationType,
          weight: topic.score,
          confidence: topic.score,
          sourceTask: input.task.id,
          provenance: 'knowflow',
        })
        .onConflictDoNothing();
    }

    if (shouldSkipQueue) {
      continue;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const result = await input.queueRepository.enqueue({
      topic: topic.topic,
      mode: 'explore',
      source: 'cron',
      priority: Math.max(1, Math.floor(input.task.priority * 0.8)),
      requestedBy: 'knowflow-emergent-topic',
      sourceGroup: stateId,
      expansion: {
        seedEntityId: seedEntity?.id ?? input.task.expansion?.seedEntityId,
        seedCommunityId: communityId,
        parentTaskId: input.task.id,
        sourceUrl: topic.sourceUrl,
        whyResearch: topic.whyResearch,
        relationType,
      },
    });
    await defaultDb
      .insert(entities)
      .values({
        id: stateId,
        type: 'knowflow_topic_state',
        name: topic.topic,
        description: `KnowFlow follow-up topic discovered from ${input.task.topic}: ${topic.whyResearch}`,
        communityId,
        metadata: {
          kind: 'knowflow_topic_state',
          source: 'knowflow',
          parentTaskId: input.task.id,
          seedEntityId: seedEntity?.id ?? input.task.expansion?.seedEntityId,
          sourceUrl: topic.sourceUrl,
          whyResearch: topic.whyResearch,
          relationType,
          score: topic.score,
          status: 'queued',
          knowflowStatus: 'queued',
          lastKnowflowQueuedAt: nowIso,
          lastKnowflowTaskId: result.task.id,
        },
        confidence: topic.score,
        provenance: 'knowflow',
        scope: 'on_demand',
        freshness: now,
      })
      .onConflictDoUpdate({
        target: entities.id,
        set: {
          description: sql`excluded.description`,
          communityId: sql`COALESCE(${entities.communityId}, excluded.community_id)`,
          metadata: sql`${entities.metadata} || excluded.metadata`,
          confidence: sql`GREATEST(COALESCE(${entities.confidence}, 0), excluded.confidence)`,
          provenance: sql`excluded.provenance`,
          freshness: sql`excluded.freshness`,
        },
      });

    if (seedEntity) {
      await defaultDb
        .insert(relations)
        .values({
          sourceId: seedEntity.id,
          targetId: stateId,
          relationType,
          weight: topic.score,
          confidence: topic.score,
          sourceTask: input.task.id,
          provenance: 'knowflow',
        })
        .onConflictDoNothing();
    }

    if (!result.deduped) enqueued += 1;
  }

  input.logger({
    event: 'knowflow.emergent_topics.enqueued',
    taskId: input.task.id,
    plannedTasks: enqueued,
    totalCandidates: topics.length,
    level: 'info',
  });

  return enqueued;
};

const defaultEvidenceProvider: EvidenceProvider = async (task, _signal) => {
  const now = Date.now();
  const sourceA = `generated:${task.id}:a`;
  const sourceB = `generated:${task.id}:b`;
  return {
    claims: [
      {
        text: `${task.topic} is an active topic that should be tracked with verified references.`,
        confidence: 0.9,
        sourceIds: [sourceA, sourceB],
      },
    ],
    sources: [
      {
        id: sourceA,
        domain: 'internal.local',
        fetchedAt: now,
        qualityScore: 0.85,
      },
      {
        id: sourceB,
        domain: 'docs.example.com',
        fetchedAt: now,
        qualityScore: 0.8,
      },
    ],
    normalizedSources: [
      {
        id: sourceA,
        url: 'https://internal.local/generated',
        domain: 'internal.local',
        title: 'generated evidence',
        fetchedAt: now,
      },
      {
        id: sourceB,
        url: 'https://docs.example.com/generated',
        domain: 'docs.example.com',
        title: 'generated supporting evidence',
        fetchedAt: now,
      },
    ],
    relations: [],
    queryCountUsed: 2,
  };
};

export const createKnowFlowTaskHandler = (
  options: CreateKnowFlowTaskHandlerOptions,
): TaskHandler => {
  const logger = options.logger ?? defaultStructuredLogger;
  const metrics = options.metrics ?? new MetricsCollector();
  const budget = {
    ...config.knowflow.budget,
    ...options.budget,
  } satisfies BudgetConfig;
  const evidenceProvider = options.evidenceProvider ?? defaultEvidenceProvider;
  const cronRunWindowMs = Math.max(
    1,
    Math.trunc(options.cronRunWindowMs ?? config.knowflow.worker.cronRunWindowMs),
  );
  let cronRunWindowStartedAt = 0;
  let cronRunConsumed = 0;

  const gapPlanner = new GapPlanner({
    repository: options.queueRepository,
    llmConfig: options.llmConfig,
    llmLogger: options.llmLogger,
  });

  return async (task, signal): Promise<TaskExecutionResult> => {
    const now = options.now?.() ?? Date.now();

    // Budget window management
    if (
      cronRunWindowStartedAt === 0 ||
      now < cronRunWindowStartedAt ||
      now - cronRunWindowStartedAt >= cronRunWindowMs
    ) {
      cronRunWindowStartedAt = now;
      cronRunConsumed = 0;
    }

    const orchestrator = new PipelineOrchestrator({
      task,
      repository: options.repository,
      evidenceProvider,
      gapPlanner,
      budget: {
        ...budget,
      },
      cronRunConsumed,
      logger,
      metrics,
      now: () => options.now?.() ?? Date.now(),
      signal,
    });

    const result = await orchestrator.run();

    if (result.ok) {
      try {
        const planned = await enqueueEmergentTopics({
          task,
          evidence: result.phases.evidenceCollection.data ?? {
            claims: [],
            sources: [],
            relations: [],
            normalizedSources: [],
            queryCountUsed: 0,
          },
          queueRepository: options.queueRepository,
          logger,
        });
        await markTopicExplorationResult({
          task,
          evidence: result.phases.evidenceCollection.data ?? {
            claims: [],
            sources: [],
            relations: [],
            normalizedSources: [],
            queryCountUsed: 0,
          },
          logger,
        });
        if (planned > 0 && result.summary.length > 0) {
          result.summary = `${result.summary}; emergent_followups=${planned}`;
        }
      } catch (error) {
        logger({
          event: 'knowflow.emergent_topics.error',
          taskId: task.id,
          topic: task.topic,
          message: error instanceof Error ? error.message : String(error),
          level: 'warn',
        });
      }
    }

    // Update budget consumption if it was a cron flow and result has the data
    if (
      task.source !== 'user' &&
      result.phases.flowExecution.data?.runConsumedBudget !== undefined
    ) {
      cronRunConsumed = result.phases.flowExecution.data.runConsumedBudget;
    }

    if (result.ok) {
      return {
        ok: true,
        summary: result.summary,
      };
    }
    logger({
      event: 'task.flow.error',
      taskId: task.id,
      topic: task.topic,
      error: result.summary,
      level: 'error',
    });
    return {
      ok: false,
      error: result.summary,
    };
  };
};
