import { type LlmLogEvent, runLlmTask } from '../../../adapters/llm.js';
import type { Retriever } from '../../../adapters/retriever/mcpRetriever.js';
import { type BudgetConfig, type LlmClientConfig, config } from '../../../config.js';
import type { TopicTask } from '../domain/task';
import type { FlowEvidence } from '../flows/types';
import { GapPlanner } from '../gap/planner.js';
import type { Knowledge, KnowledgeUpsertInput } from '../knowledge/types';
import type { Relation, SourceRef } from '../knowledge/types';
import { extractEvidenceFromText } from '../ops/evidenceExtractor';
import { type StructuredLogger, defaultStructuredLogger } from '../ops/logger';
import { MetricsCollector } from '../ops/metrics';
import type { QueueRepository } from '../queue/repository';
import type { EvidenceClaim, EvidenceSource } from '../verifier';
import type { TaskExecutionResult, TaskHandler } from './loop';
import { PipelineOrchestrator } from './pipeline.js';

const MAX_INITIAL_QUERIES = 3;
const MAX_URLS_PER_QUERY = 2;

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
    let queryCountUsed = 0;

    for (const query of queries) {
      if (queryCountUsed >= config.knowflow.worker.maxQueriesPerTask) break; // Hard limit

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

      // Simple regex to find URLs in search result snippets
      const urls = [...searchResultText.matchAll(/https?:\/\/[^\s\)]+/g)]
        .map((m) => m[0])
        .slice(0, MAX_URLS_PER_QUERY);

      for (const url of urls) {
        try {
          const startTime = Date.now();
          const contentRaw = await retriever.fetch(url, signal);
          // ローカルLLMの過負荷（ハング）を防ぐため、コンテンツを切り詰め
          const MAX_CONTENT_CHARS = 6000;
          const content =
            contentRaw.length > MAX_CONTENT_CHARS
              ? `${contentRaw.slice(0, MAX_CONTENT_CHARS)}\n\n[...Truncated from ${
                  contentRaw.length
                } chars...]`
              : contentRaw;

          const extracted = await _extractEvidence({
            topic: task.topic,
            url,
            title: query,
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
      queryCountUsed,
    };
  };
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
