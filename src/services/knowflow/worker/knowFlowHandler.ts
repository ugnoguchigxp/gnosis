import { type LlmLogEvent, runLlmTask } from '../../../adapters/llm.js';
import type { Retriever } from '../../../adapters/retriever/mcpRetriever.js';
import { type BudgetConfig, type LlmClientConfig, config } from '../../../config.js';
import type { TopicTask } from '../domain/task';
import { runCronFlow } from '../flows/cronFlow';
import type { FlowEvidence } from '../flows/types';
import { runUserFlow } from '../flows/userFlow';
import type { Knowledge, KnowledgeUpsertInput } from '../knowledge/types';
import type { Relation, SourceRef } from '../knowledge/types';
import { extractEvidenceFromText } from '../ops/evidenceExtractor';
import { type StructuredLogger, defaultStructuredLogger } from '../ops/logger';
import { MetricsCollector } from '../ops/metrics';
import type { EvidenceClaim, EvidenceSource } from '../verifier';
import type { TaskExecutionResult, TaskHandler } from './loop';

const MAX_INITIAL_QUERIES = 3;
const MAX_URLS_PER_QUERY = 2;

export type KnowledgeRepositoryLike = {
  getByTopic: (topic: string) => Promise<Knowledge | null>;
  merge: (input: KnowledgeUpsertInput) => Promise<{ knowledge: Knowledge; changed: boolean }>;
};

export type EvidenceProvider = (task: TopicTask) => Promise<FlowEvidence>;

export type CreateKnowFlowTaskHandlerOptions = {
  repository: KnowledgeRepositoryLike;
  evidenceProvider?: EvidenceProvider;
  budget?: Partial<BudgetConfig>;
  cronRunWindowMs?: number;
  logger?: StructuredLogger;
  metrics?: MetricsCollector;
  now?: () => number;
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

  return async (task): Promise<FlowEvidence> => {
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
        searchResultText = await retriever.search(query);
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
          const content = await retriever.fetch(url);
          const extracted = await _extractEvidence({
            topic: task.topic,
            url,
            title: query, // Use query as title fallback
            text: content,
            requestId: task.id,
            llmConfig: options?.llmConfig,
            llmLogger: options?.llmLogger,
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

const defaultEvidenceProvider: EvidenceProvider = async (task) => {
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

  return async (task): Promise<TaskExecutionResult> => {
    const now = options.now?.() ?? Date.now();
    logger({
      event: 'task.flow.start',
      taskId: task.id,
      topic: task.topic,
      source: task.source,
      mode: task.mode,
      level: 'info',
    });

    try {
      const evidence = await evidenceProvider(task);

      if (task.source === 'user') {
        const userResult = await runUserFlow({
          topic: task.topic,
          evidence,
          repository: options.repository,
          userBudget: budget.userBudget,
          now,
        });

        metrics.record({
          taskId: task.id,
          source: 'user',
          ok: true,
          changed: userResult.changed,
          retries: task.attempts,
          acceptedClaims: userResult.acceptedClaims,
          rejectedClaims: userResult.rejectedClaims,
          conflicts: userResult.conflicts,
        });

        logger({
          event: 'task.flow.done',
          taskId: task.id,
          source: task.source,
          changed: userResult.changed,
          acceptedClaims: userResult.acceptedClaims,
          rejectedClaims: userResult.rejectedClaims,
          conflicts: userResult.conflicts,
          gaps: userResult.gaps,
          reportSummary: userResult.report.summary,
          level: 'info',
        });

        return {
          ok: true,
          summary: `${userResult.summary}; report=${userResult.report.summary}`,
        };
      }

      if (
        cronRunWindowStartedAt === 0 ||
        now < cronRunWindowStartedAt ||
        now - cronRunWindowStartedAt >= cronRunWindowMs
      ) {
        cronRunWindowStartedAt = now;
        cronRunConsumed = 0;
      }

      const cronResult = await runCronFlow({
        topic: task.topic,
        evidence,
        repository: options.repository,
        cronBudget: budget.cronBudget,
        cronRunBudget: budget.cronRunBudget,
        cronRunConsumed,
        now,
      });
      cronRunConsumed = cronResult.runConsumedBudget;

      metrics.record({
        taskId: task.id,
        source: 'cron',
        ok: true,
        changed: cronResult.changed,
        retries: task.attempts,
        acceptedClaims: cronResult.acceptedClaims,
        rejectedClaims: cronResult.rejectedClaims,
        conflicts: cronResult.conflicts,
      });

      logger({
        event: 'task.flow.done',
        taskId: task.id,
        source: task.source,
        changed: cronResult.changed,
        acceptedClaims: cronResult.acceptedClaims,
        rejectedClaims: cronResult.rejectedClaims,
        conflicts: cronResult.conflicts,
        gaps: cronResult.gaps,
        cronRunConsumed,
        level: 'info',
      });

      return {
        ok: true,
        summary: `${cronResult.summary}; cronRunConsumed=${cronRunConsumed}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      metrics.record({
        taskId: task.id,
        source: task.source,
        ok: false,
        retries: task.attempts,
        acceptedClaims: 0,
        rejectedClaims: 0,
        conflicts: 0,
      });
      logger({
        event: 'task.flow.error',
        taskId: task.id,
        source: task.source,
        message,
        level: 'error',
      });
      return {
        ok: false,
        error: message,
      };
    }
  };
};
