import { eq, sql } from 'drizzle-orm';
import { type LlmLogEvent, runLlmTask } from '../../../adapters/llm.js';
import type { Retriever } from '../../../adapters/retriever/mcpRetriever.js';
import { type BudgetConfig, type LlmClientConfig, config } from '../../../config.js';
import { db as defaultDb } from '../../../db/index.js';
import { entities, relations } from '../../../db/schema.js';
import { generateEntityId } from '../../../utils/entityId.js';
import { embeddingBatchTask } from '../../background/tasks/embeddingBatchTask.js';
import { synthesisTask } from '../../background/tasks/synthesisTask.js';
import { distillSessionKnowledge } from '../../sessionSummary/engine.js';
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
  FAILED_RETRY_MS,
  generateTopicStateEntityId,
  hashSearchAttempt,
  isKnowflowTopicSuppressed,
  isoAfter,
} from '../state/topicState.js';
import type { EvidenceClaim, EvidenceSource } from '../verifier';
import { verifyEvidence } from '../verifier';
import type { TaskExecutionResult, TaskHandler } from './loop';
import { PipelineOrchestrator, type PipelineResult } from './pipeline.js';

const MAX_INITIAL_QUERIES = 3;
const MAX_FETCHED_PAGES_PER_TASK = 5;
const MAX_CONTENT_CHARS = 6000;
const MIN_USEFULNESS_SCORE = 0.65;
const MIN_EMERGENT_TOPIC_SCORE = 0.6;
const MIN_EMERGENT_DIMENSION_SCORE = 0.45;
const HIGH_IMPORTANCE_PRIORITY = 80;
const WITHHELD_REGISTRATION_RETRY_MS = 60 * 24 * 60 * 60 * 1000;

type SystemTaskType = 'synthesis' | 'embedding_batch' | 'session_distillation';

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
  database?: typeof defaultDb;
  recordTopicState?: boolean;

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

const buildFallbackQueries = (topic: string): string[] => {
  const base = topic.trim();
  if (!base) return [];
  return [base, `${base} overview`, `${base} best practices`];
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
        usefulPageFound: false,
        usefulPageCount: 0,
        requiredUsefulPageCount: requiredUsefulPageCount(task),
        fetchedPageCount: 0,
        diagnostics: {
          outcome: 'llm_degraded',
          messages: ['LLM degraded during query generation; MCP search was skipped.'],
        },
      };
    }

    const rawQueries = queryResult.output.queries
      .map((query) => query.trim())
      .filter((query) => query.length > 0);
    const queries =
      rawQueries.length > 0
        ? rawQueries.slice(0, MAX_INITIAL_QUERIES)
        : buildFallbackQueries(task.topic).slice(0, MAX_INITIAL_QUERIES);

    if (rawQueries.length === 0) {
      logger({
        event: 'retriever.mcp.query_generation.empty',
        taskId: task.id,
        topic: task.topic,
        fallbackQueries: queries,
        level: 'warn',
      });
    }
    const allClaims: EvidenceClaim[] = [];
    const allSources: EvidenceSource[] = [];
    const allNormalized: SourceRef[] = [];
    const allRelations: Relation[] = [];
    const allEmergentTopics: NonNullable<FlowEvidence['emergentTopics']> = [];
    const seenEmergentTopics = new Set<string>();
    const fetchedPageUrls = new Set<string>();
    const searchQueries: string[] = [];
    const usefulDomains = new Set<string>();
    const diagnosticMessages: string[] = [];
    let searchErrorCount = 0;
    let noSearchResultCount = 0;
    let fetchErrorCount = 0;
    let notUsefulCount = 0;
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
        searchErrorCount += 1;
        diagnosticMessages.push(
          `Search failed for "${query}": ${
            searchError instanceof Error ? searchError.message : String(searchError)
          }`,
        );
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
        noSearchResultCount += 1;
        diagnosticMessages.push(`No search results for "${query}".`);
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
            notUsefulCount += 1;
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
          fetchErrorCount += 1;
          diagnosticMessages.push(
            `Fetch/extract failed for ${url}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    const diagnosticsMessages = [
      ...(rawQueries.length === 0
        ? ['Query generation returned empty queries. Fallback query set was used.']
        : []),
      ...diagnosticMessages,
    ];

    const diagnostics: FlowEvidence['diagnostics'] =
      usefulDomains.size > 0 || allClaims.length > 0
        ? { outcome: 'ok', messages: diagnosticsMessages.slice(0, 5) }
        : fetchedPageUrls.size > 0 && notUsefulCount > 0
          ? { outcome: 'no_useful_pages', messages: diagnosticsMessages.slice(0, 5) }
          : fetchErrorCount > 0
            ? { outcome: 'fetch_failed', messages: diagnosticsMessages.slice(0, 5) }
            : searchErrorCount > 0 && queryCountUsed === 0
              ? { outcome: 'search_failed', messages: diagnosticsMessages.slice(0, 5) }
              : noSearchResultCount > 0
                ? { outcome: 'no_search_results', messages: diagnosticsMessages.slice(0, 5) }
                : { outcome: 'no_evidence_collected', messages: diagnosticsMessages.slice(0, 5) };

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
      diagnostics,
    };
  };
};

const EMPTY_EVIDENCE: FlowEvidence = {
  claims: [],
  sources: [],
  relations: [],
  normalizedSources: [],
  queryCountUsed: 0,
  usefulPageFound: false,
  usefulPageCount: 0,
  fetchedPageCount: 0,
};

type TopicExplorationOutcome = {
  stateId: string;
  status: 'explored' | 'exhausted' | 'failed';
  outcome: string;
  description: string;
  metadata: Record<string, unknown>;
  confidence: number;
  relationWeight: number;
};

const uniqueStrings = (values: Array<string | undefined>, limit: number): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
};

const truncateForState = (value: string, maxChars = 300): string => {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 3)}...` : trimmed;
};

const sourceLabel = (source: SourceRef | EvidenceSource): string | undefined => {
  const url = 'url' in source ? source.url : undefined;
  const domain = source.domain ?? (url ? hostnameForUrl(url) : undefined);
  const title = 'title' in source ? source.title : undefined;
  const label = [title, domain].filter(Boolean).join(' - ');
  if (url && label) return `${label}: ${url}`;
  return url ?? (label || undefined);
};

export const buildTopicExplorationOutcome = (input: {
  task: TopicTask;
  evidence: FlowEvidence;
  result?: PipelineResult;
  now?: Date;
}): TopicExplorationOutcome => {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const fetchedPageCount = input.evidence.fetchedPageCount ?? 0;
  const usefulPageCount =
    input.evidence.usefulPageCount ?? (input.evidence.usefulPageFound ? 1 : 0);
  const requiredUsefulPageCount = input.evidence.requiredUsefulPageCount ?? 1;
  const verification = verifyEvidence({
    topic: input.task.topic,
    claims: input.evidence.claims,
    sources: input.evidence.sources,
    now: now.getTime(),
  });
  const flowResult = input.result?.phases.flowExecution.data;
  const registrationDecision = flowResult?.registrationDecision;
  const registrationAllowed = registrationDecision?.allow ?? verification.acceptedClaims.length > 0;
  const knowledgeWithheldByGate =
    usefulPageCount >= requiredUsefulPageCount &&
    verification.acceptedClaims.length > 0 &&
    registrationDecision?.allow === false;
  const status =
    input.result && !input.result.ok
      ? 'failed'
      : knowledgeWithheldByGate
        ? 'exhausted'
        : usefulPageCount >= requiredUsefulPageCount
          ? 'explored'
          : 'exhausted';
  const outcome =
    status === 'failed'
      ? 'pipeline_failed'
      : usefulPageCount >= requiredUsefulPageCount && registrationAllowed
        ? 'claims_recorded'
        : usefulPageCount >= requiredUsefulPageCount && verification.acceptedClaims.length > 0
          ? 'claims_withheld_by_registration_gate'
          : usefulPageCount >= requiredUsefulPageCount
            ? 'useful_pages_without_accepted_claims'
            : fetchedPageCount === 0
              ? input.evidence.diagnostics?.outcome ?? 'no_evidence_collected'
              : usefulPageCount === 0
                ? 'no_useful_pages'
                : 'insufficient_independent_sources';

  const stateId = generateTopicStateEntityId(input.task.topic);
  const acceptedClaimSamples = uniqueStrings(
    verification.acceptedClaims.map((claim) => truncateForState(claim.text, 500)),
    5,
  );
  const rejectedClaimSamples = uniqueStrings(
    verification.rejectedClaims.map((item) =>
      truncateForState(`${item.claim.text} [${item.reasons.join(', ')}]`, 500),
    ),
    5,
  );
  const conflictSamples = uniqueStrings(
    verification.conflicts.map((conflict) =>
      truncateForState(`${conflict.leftClaim} <> ${conflict.rightClaim}`, 500),
    ),
    3,
  );
  const sourceSamples = uniqueStrings(
    [
      ...(input.evidence.normalizedSources ?? []).map(sourceLabel),
      ...input.evidence.sources.map(sourceLabel),
    ],
    5,
  );
  const searchQueries = uniqueStrings(input.evidence.searchQueries ?? [], 5);
  const diagnosticMessages = uniqueStrings(input.evidence.diagnostics?.messages ?? [], 5);
  const resultSummary = input.result?.summary || flowResult?.summary;
  const countLine = [
    `accepted=${verification.acceptedClaims.length}`,
    `rejected=${verification.rejectedClaims.length}`,
    `conflicts=${verification.conflicts.length}`,
    `gaps=${flowResult?.gaps.length ?? 0}`,
    `fetched=${fetchedPageCount}`,
    `useful=${usefulPageCount}/${requiredUsefulPageCount}`,
    registrationDecision
      ? `registration=${registrationDecision.allow ? 'allow' : 'skip'}`
      : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(', ');
  const heading = knowledgeWithheldByGate
    ? 'KF_NO_KNOWLEDGE_RECORDED'
    : status === 'explored'
      ? 'KF_KNOWLEDGE_RECORDED'
      : status === 'failed'
        ? 'KF_PIPELINE_FAILED'
        : 'KF_NO_KNOWLEDGE';
  const descriptionParts = [
    heading,
    `Outcome: ${outcome}; ${countLine}.`,
    resultSummary ? `Summary: ${truncateForState(resultSummary, 500)}` : undefined,
    acceptedClaimSamples.length > 0
      ? `Accepted findings:\n${acceptedClaimSamples.map((claim) => `- ${claim}`).join('\n')}`
      : undefined,
    rejectedClaimSamples.length > 0
      ? `Rejected findings:\n${rejectedClaimSamples.map((claim) => `- ${claim}`).join('\n')}`
      : undefined,
    conflictSamples.length > 0
      ? `Conflicts:\n${conflictSamples.map((claim) => `- ${claim}`).join('\n')}`
      : undefined,
    sourceSamples.length > 0
      ? `Sources:\n${sourceSamples.map((source) => `- ${source}`).join('\n')}`
      : undefined,
    searchQueries.length > 0 ? `Search queries: ${searchQueries.join(' | ')}` : undefined,
    diagnosticMessages.length > 0
      ? `Diagnostics: ${diagnosticMessages
          .map((message) => truncateForState(message, 240))
          .join(' | ')}`
      : undefined,
    input.task.expansion?.whyResearch
      ? `Original selection reason: ${truncateForState(input.task.expansion.whyResearch, 500)}`
      : undefined,
  ].filter((part): part is string => Boolean(part));

  const metadata = {
    kind: 'knowflow_topic_state',
    source: 'knowflow',
    seedEntityId: input.task.expansion?.seedEntityId,
    parentTaskId: input.task.expansion?.parentTaskId,
    sourceUrl: input.task.expansion?.sourceUrl,
    whyResearch: input.task.expansion?.whyResearch,
    status,
    knowflowStatus: status,
    outcome,
    lastKnowflowTaskId: input.task.id,
    lastKnowflowUpdatedAt: nowIso,
    lastKnowflowAttemptedAt: nowIso,
    ...(input.result?.ok ? { lastKnowflowCompletedAt: nowIso } : {}),
    usefulPageFound: input.evidence.usefulPageFound ?? false,
    usefulPageCount,
    requiredUsefulPageCount,
    fetchedPageCount,
    queryCountUsed: input.evidence.queryCountUsed ?? 0,
    searchQueries,
    resultSummary,
    acceptedClaimCount: verification.acceptedClaims.length,
    registrationAllowed,
    noKnowledgeRecorded: knowledgeWithheldByGate,
    registrationDecisionReason: registrationDecision?.reason,
    registrationDecisionConfidence: registrationDecision?.confidence,
    rejectedClaimCount: verification.rejectedClaims.length,
    conflictCount: verification.conflicts.length,
    gapCount: flowResult?.gaps.length ?? 0,
    acceptedClaimSamples,
    rejectedClaimSamples,
    conflictSamples,
    sourceSamples,
    diagnostics: input.evidence.diagnostics,
    pipelineOk: input.result?.ok,
    pipelineError: input.result && !input.result.ok ? input.result.summary : undefined,
    evidenceCollectionOk: input.result?.phases.evidenceCollection.ok,
    evidenceCollectionError: input.result?.phases.evidenceCollection.error,
    flowExecutionOk: input.result?.phases.flowExecution.ok,
    flowExecutionError: input.result?.phases.flowExecution.error,
    ...(status === 'exhausted'
      ? {
          exhaustedAt: nowIso,
          exhaustedReason:
            outcome === 'claims_withheld_by_registration_gate'
              ? 'LLM registration gate judged this topic not ready for persistent knowledge.'
              : outcome === 'insufficient_independent_sources'
                ? 'Useful evidence was found, but the required independent source count was not met within fetch budget.'
                : outcome === 'no_useful_pages'
                  ? 'Fetched pages were not useful enough for this topic.'
                  : 'No evidence was collected for this topic.',
          exhaustedQueryHash: hashSearchAttempt({
            topic: input.task.topic,
            queries: searchQueries,
          }),
          retryAfter: isoAfter(
            now,
            outcome === 'claims_withheld_by_registration_gate'
              ? WITHHELD_REGISTRATION_RETRY_MS
              : EXHAUSTED_RETRY_MS,
          ),
        }
      : status === 'failed'
        ? {
            failedAt: nowIso,
            failureReason: input.result?.summary ?? 'KnowFlow pipeline failed.',
            retryAfter: isoAfter(now, FAILED_RETRY_MS),
          }
        : {
            exploredAt: nowIso,
            lastExploredAt: nowIso,
            cooldownUntil: isoAfter(now, EXPLORED_COOLDOWN_MS),
          }),
  };

  return {
    stateId,
    status,
    outcome,
    description: descriptionParts.join('\n\n'),
    metadata,
    confidence: status === 'explored' ? 0.8 : status === 'failed' ? 0.25 : 0.4,
    relationWeight: status === 'explored' ? 0.8 : status === 'failed' ? 0.25 : 0.4,
  };
};

const recordTopicExplorationOutcome = async (input: {
  task: TopicTask;
  evidence: FlowEvidence;
  result?: PipelineResult;
  logger: StructuredLogger;
  database?: typeof defaultDb;
}): Promise<void> => {
  const outcome = buildTopicExplorationOutcome({
    task: input.task,
    evidence: input.evidence,
    result: input.result,
  });
  const database = input.database ?? defaultDb;

  await database
    .insert(entities)
    .values({
      id: outcome.stateId,
      type: 'knowflow_topic_state',
      name: input.task.topic,
      description: outcome.description,
      communityId: input.task.expansion?.seedCommunityId,
      metadata: outcome.metadata,
      confidence: outcome.confidence,
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
    })
    .returning({ id: entities.id });

  if (input.task.expansion?.seedEntityId && input.task.expansion.seedEntityId !== outcome.stateId) {
    await database
      .insert(relations)
      .values({
        sourceId: input.task.expansion.seedEntityId,
        targetId: outcome.stateId,
        relationType: input.task.expansion.relationType ?? 'expands',
        weight: outcome.relationWeight,
        confidence: outcome.confidence,
        sourceTask: input.task.id,
        provenance: 'knowflow',
      })
      .onConflictDoNothing();
  }

  input.logger({
    event: 'knowflow.topic.status_updated',
    taskId: input.task.id,
    topic: input.task.topic,
    stateId: outcome.stateId,
    status: outcome.status,
    outcome: outcome.outcome,
    fetchedPageCount: input.evidence.fetchedPageCount ?? 0,
    usefulPageCount: input.evidence.usefulPageCount ?? (input.evidence.usefulPageFound ? 1 : 0),
    requiredUsefulPageCount: input.evidence.requiredUsefulPageCount ?? 1,
    level: 'info',
  });
};

const enqueueEmergentTopics = async (input: {
  task: TopicTask;
  evidence: FlowEvidence;
  queueRepository?: QueueRepository;
  logger: StructuredLogger;
  database?: typeof defaultDb;
}): Promise<number> => {
  const topics = input.evidence.emergentTopics ?? [];
  if (!input.queueRepository || topics.length === 0) {
    return 0;
  }
  const database = input.database ?? defaultDb;

  let seedEntity: typeof entities.$inferSelect | undefined;
  if (input.task.expansion?.seedEntityId) {
    [seedEntity] = await database
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
    const [existingConcept] = await database
      .select({ id: entities.id, metadata: entities.metadata })
      .from(entities)
      .where(eq(entities.id, conceptId))
      .limit(1);
    const [existingState] = await database
      .select({ id: entities.id, metadata: entities.metadata })
      .from(entities)
      .where(eq(entities.id, stateId))
      .limit(1);
    const shouldSkipQueue =
      isKnowflowTopicSuppressed(existingState?.metadata) ||
      isKnowflowTopicSuppressed(existingConcept?.metadata);

    await database
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
      await database
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
    await database
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
      await database
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

function parseSystemTask(task: TopicTask): {
  type: SystemTaskType;
  payload: Record<string, unknown>;
} | null {
  if (!task.topic.startsWith('__system__/')) return null;
  const metadata =
    task.metadata && typeof task.metadata === 'object'
      ? (task.metadata as Record<string, unknown>)
      : {};
  const systemTask =
    metadata.systemTask && typeof metadata.systemTask === 'object'
      ? (metadata.systemTask as Record<string, unknown>)
      : null;
  if (!systemTask) return null;
  const type = systemTask.type;
  if (type !== 'synthesis' && type !== 'embedding_batch' && type !== 'session_distillation') {
    return null;
  }
  const payload =
    systemTask.payload && typeof systemTask.payload === 'object'
      ? (systemTask.payload as Record<string, unknown>)
      : {};
  return { type, payload };
}

async function runSystemTask(task: TopicTask): Promise<TaskExecutionResult | null> {
  const parsed = parseSystemTask(task);
  if (!parsed) return null;

  try {
    if (parsed.type === 'synthesis') {
      const maxFailuresRaw = parsed.payload.maxFailures;
      const maxFailures =
        typeof maxFailuresRaw === 'number' && Number.isFinite(maxFailuresRaw)
          ? Math.max(0, Math.trunc(maxFailuresRaw))
          : 0;
      const result = await synthesisTask({ maxFailures });
      return {
        ok: true,
        summary: `system:synthesis processed=${result.processedMemories} failed=${result.failedCount}`,
      };
    }

    if (parsed.type === 'embedding_batch') {
      const batchSizeRaw = parsed.payload.batchSize;
      const batchSize =
        typeof batchSizeRaw === 'number' && Number.isFinite(batchSizeRaw)
          ? Math.max(1, Math.trunc(batchSizeRaw))
          : 50;
      const result = await embeddingBatchTask(batchSize);
      return {
        ok: true,
        summary: `system:embedding_batch processed=${result.processed}`,
      };
    }

    const sessionId =
      typeof parsed.payload.sessionId === 'string' && parsed.payload.sessionId.trim().length > 0
        ? parsed.payload.sessionId.trim()
        : '';
    if (!sessionId) {
      return { ok: false, error: 'system:session_distillation requires sessionId' };
    }

    const provider =
      parsed.payload.provider === 'auto' ||
      parsed.payload.provider === 'deterministic' ||
      parsed.payload.provider === 'local' ||
      parsed.payload.provider === 'openai' ||
      parsed.payload.provider === 'bedrock'
        ? parsed.payload.provider
        : undefined;
    const result = await distillSessionKnowledge({
      sessionId,
      force: parsed.payload.force === true,
      promote: parsed.payload.promote === true,
      provider,
    });
    const summary = `system:session_distillation session=${sessionId} status=${result.status} keep=${result.keptCount} drop=${result.droppedCount}`;
    if (result.status === 'succeeded') {
      return { ok: true, summary };
    }
    return {
      ok: false,
      error: summary,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

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
    const systemTaskResult = await runSystemTask(task);
    if (systemTaskResult) return systemTaskResult;

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
      evaluateRegistration: async (input) => {
        try {
          const decision = await runLlmTask(
            {
              task: 'registration_decision',
              context: {
                topic: input.topic,
                verifierSummary: input.verifierSummary,
                acceptedClaims: input.acceptedClaims.slice(0, 8),
                sourceCount: input.sources.length,
                uniqueDomainCount: new Set(
                  input.sources
                    .map((source) => source.domain?.trim().toLowerCase())
                    .filter((domain): domain is string => Boolean(domain && domain.length > 0)),
                ).size,
              },
              requestId: task.id,
            },
            {
              config: options.llmConfig,
              deps: options.llmLogger ? { logger: options.llmLogger } : undefined,
              signal,
            },
          );
          logger({
            event: 'knowflow.registration.decision',
            taskId: task.id,
            topic: task.topic,
            allow: decision.output.allow,
            confidence: decision.output.confidence,
            reason: decision.output.reason,
            level: decision.output.allow ? 'info' : 'warn',
          });
          return decision.output;
        } catch (error) {
          const fallback = {
            allow: input.acceptedClaims.length > 0,
            reason: 'registration_decision_unavailable',
            confidence: 0.4,
          };
          logger({
            event: 'knowflow.registration.decision_fallback',
            taskId: task.id,
            topic: task.topic,
            allow: fallback.allow,
            reason: fallback.reason,
            message: error instanceof Error ? error.message : String(error),
            level: 'warn',
          });
          return fallback;
        }
      },
    });

    const result = await orchestrator.run();
    const registrationDecision = result.phases.flowExecution.data?.registrationDecision;
    const noKnowledgeRecorded = registrationDecision?.allow === false;

    const evidence = result.phases.evidenceCollection.data ?? EMPTY_EVIDENCE;

    if (result.ok) {
      if (noKnowledgeRecorded) {
        logger({
          event: 'knowflow.knowledge.not_recorded',
          taskId: task.id,
          topic: task.topic,
          reason: registrationDecision.reason,
          confidence: registrationDecision.confidence,
          level: 'info',
        });
        result.summary = `${result.summary}; no_knowledge_recorded`;
      }
      try {
        const planned = await enqueueEmergentTopics({
          task,
          evidence,
          queueRepository: options.queueRepository,
          logger,
          database: options.database,
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

    const shouldRecordTopicState = options.recordTopicState ?? Boolean(task.expansion);
    if (shouldRecordTopicState) {
      try {
        await recordTopicExplorationOutcome({
          task,
          evidence,
          result,
          logger,
          database: options.database,
        });
      } catch (error) {
        logger({
          event: 'knowflow.topic.status_update_error',
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
