import { sql } from 'drizzle-orm';
import { type LlmLogEvent, runLlmTask } from '../../../adapters/llm.js';
import type { Retriever } from '../../../adapters/retriever/mcpRetriever.js';
import { type LlmClientConfig, config } from '../../../config.js';
import { db as defaultDb } from '../../../db/index.js';
import { entities } from '../../../db/schema.js';
import { generateEntityId } from '../../../utils/entityId.js';
import { embeddingBatchTask } from '../../background/tasks/embeddingBatchTask.js';
import { synthesisTask } from '../../background/tasks/synthesisTask.js';
import { distillSessionKnowledge } from '../../sessionSummary/engine.js';
import type { TopicTask } from '../domain/task';
import type { Knowledge } from '../knowledge/types';
import { type StructuredLogger, defaultStructuredLogger } from '../ops/logger';
import { MetricsCollector } from '../ops/metrics';
import type { TaskExecutionResult, TaskHandler } from './loop';

const MAX_FETCHED_PAGES_PER_TASK = 1;
const MAX_CONTENT_CHARS = 800;

type SystemTaskType = 'synthesis' | 'embedding_batch' | 'session_distillation';

export type KnowFlowEvidence = {
  researchNote?: string;
  referenceUrls?: string[];
  queryCountUsed?: number;
  searchQueries?: string[];
  usefulPageFound?: boolean;
  usefulPageCount?: number;
  fetchedPageCount?: number;
  diagnostics?: {
    outcome?:
      | 'ok'
      | 'search_failed'
      | 'no_search_results'
      | 'fetch_failed'
      | 'no_fetched_pages'
      | 'no_research_note';
    messages?: string[];
  };
};

export type EvidenceProvider = (task: TopicTask, signal?: AbortSignal) => Promise<KnowFlowEvidence>;

export type CreateKnowFlowTaskHandlerOptions = {
  evidenceProvider?: EvidenceProvider;
  cronRunWindowMs?: number;
  logger?: StructuredLogger;
  metrics?: MetricsCollector;
  now?: () => number;
  database?: typeof defaultDb;
};

export type McpEvidenceProviderOptions = {
  logger?: StructuredLogger;
  llmConfig?: Partial<LlmClientConfig>;
  llmLogger?: (event: LlmLogEvent) => void;
  runLlmTask?: typeof runLlmTask;
  getExistingKnowledge?: (topic: string) => Promise<Knowledge | null>;
};

type ParsedSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

const uniqueStrings = (values: string[], limit = values.length): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
    if (output.length >= limit) break;
  }
  return output;
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

const parseResultLine = (line: string): ParsedSearchResult | undefined => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('- ')) return undefined;

  const body = trimmed.slice(2).trim();
  const marker = ' (http';
  const markerIndex = body.lastIndexOf(marker);
  if (markerIndex < 0 || !body.endsWith(')')) return undefined;

  const title = body.slice(0, markerIndex).trim();
  const url = body.slice(markerIndex + 2, body.length - 1).trim();
  if (!title || !url.startsWith('http')) return undefined;
  return { title, url, snippet: '' };
};

const parseSearchResults = (text: string): ParsedSearchResult[] => {
  const results: ParsedSearchResult[] = [];
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseResultLine(lines[index] ?? '');
    if (!parsed) continue;

    const snippetParts: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const next = lines[cursor] ?? '';
      if (next.trim().startsWith('- ')) break;
      const snippet = next.trim();
      if (snippet) snippetParts.push(snippet);
      cursor += 1;
    }
    index = cursor - 1;
    results.push({ ...parsed, snippet: snippetParts.join(' ') });
  }

  return uniqueByUrl(results);
};

const truncateContent = (contentRaw: string): string => {
  const marker = 'Markdown Content:\n';
  const markerIndex = contentRaw.indexOf(marker);
  const body = markerIndex >= 0 ? contentRaw.slice(markerIndex + marker.length) : contentRaw;
  if (body.length <= MAX_CONTENT_CHARS) return body;
  return `${body.slice(0, MAX_CONTENT_CHARS)}\n\n[truncated]`;
};

const formatFetchedSourceTexts = (contents: string[]): string =>
  contents.map((content, index) => `Source text ${index + 1}:\n${content}`).join('\n\n---\n\n');

const formatSeedContext = (task: TopicTask): string => {
  return `Task topic: ${task.topic}`;
};

const formatExistingKnowledge = (knowledge: Knowledge | null): string => {
  if (!knowledge) return '';
  const claims = knowledge.claims
    .slice(0, 5)
    .map((claim) => claim.text.trim())
    .filter(Boolean);
  const aliases = knowledge.aliases.slice(0, 5).filter(Boolean);
  return [
    `Known topic: ${knowledge.canonicalTopic}`,
    aliases.length > 0 ? `Aliases: ${aliases.join(', ')}` : undefined,
    claims.length > 0
      ? `Existing notes:\n${claims.map((claim) => `- ${claim}`).join('\n')}`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
};

const isUsableResearchNote = (topic: string, note: string | undefined): note is string => {
  const trimmed = note?.trim();
  if (!trimmed) return false;
  return trimmed !== topic.trim();
};

export const createMcpEvidenceProvider = (
  retriever: Retriever,
  options?: McpEvidenceProviderOptions,
): EvidenceProvider => {
  const logger = options?.logger ?? defaultStructuredLogger;
  const _runLlmTask = options?.runLlmTask ?? runLlmTask;

  return async (task, signal): Promise<KnowFlowEvidence> => {
    logger({
      event: 'retriever.mcp.start',
      taskId: task.id,
      topic: task.topic,
      level: 'info',
    });

    const searchQueries = uniqueStrings([task.topic], config.knowflow.worker.maxQueriesPerTask);
    const fetchedUrls: string[] = [];
    const fetchedContents: string[] = [];
    const diagnostics: string[] = [];
    let queryCountUsed = 0;
    let searchErrorCount = 0;
    let noSearchResultCount = 0;
    let fetchErrorCount = 0;

    for (const query of searchQueries) {
      if (fetchedUrls.length >= MAX_FETCHED_PAGES_PER_TASK) break;

      let searchResultText: string;
      try {
        searchResultText = await retriever.search(query, signal);
      } catch (error) {
        searchErrorCount += 1;
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.push(`Search failed for ${query}: ${message}`);
        logger({
          event: 'retriever.mcp.search_error',
          taskId: task.id,
          query,
          message,
          level: 'warn',
        });
        continue;
      }

      queryCountUsed += 1;
      const searchResults = parseSearchResults(searchResultText).slice(
        0,
        MAX_FETCHED_PAGES_PER_TASK,
      );
      if (searchResults.length === 0) {
        noSearchResultCount += 1;
        diagnostics.push(`No search results for ${query}.`);
        logger({
          event: 'retriever.mcp.no_search_results',
          taskId: task.id,
          query,
          level: 'warn',
        });
        continue;
      }

      for (const result of searchResults) {
        if (fetchedUrls.length >= MAX_FETCHED_PAGES_PER_TASK) break;
        if (fetchedUrls.includes(result.url)) continue;

        try {
          const content = truncateContent(await retriever.fetch(result.url, signal));
          fetchedUrls.push(result.url);
          fetchedContents.push(content);
          logger({
            event: 'retriever.mcp.fetch.done',
            taskId: task.id,
            url: result.url,
            chars: content.length,
            level: 'info',
          });
        } catch (error) {
          fetchErrorCount += 1;
          const message = error instanceof Error ? error.message : String(error);
          diagnostics.push(`Fetch failed for ${result.url}: ${message}`);
          logger({
            event: 'retriever.mcp.fetch_error',
            taskId: task.id,
            url: result.url,
            message,
            level: 'warn',
          });
        }
      }
    }

    if (fetchedContents.length === 0) {
      const outcome =
        fetchErrorCount > 0
          ? 'fetch_failed'
          : searchErrorCount > 0 && queryCountUsed === 0
            ? 'search_failed'
            : noSearchResultCount > 0
              ? 'no_search_results'
              : 'no_fetched_pages';
      return {
        referenceUrls: fetchedUrls,
        queryCountUsed,
        searchQueries,
        usefulPageFound: false,
        usefulPageCount: 0,
        fetchedPageCount: fetchedUrls.length,
        diagnostics: { outcome, messages: diagnostics.slice(0, 5) },
      };
    }

    const existingKnowledge = options?.getExistingKnowledge
      ? await options.getExistingKnowledge(task.topic)
      : null;

    const noteResult = await _runLlmTask(
      {
        task: 'research_note',
        context: {
          topic: task.topic,
          seed_context: formatSeedContext(task),
          existing_knowledge: formatExistingKnowledge(existingKnowledge),
          source_texts: formatFetchedSourceTexts(fetchedContents),
        },
        requestId: task.id,
      },
      {
        config: options?.llmConfig,
        deps: options?.llmLogger ? { logger: options.llmLogger } : undefined,
        signal,
      },
    );

    const researchNote = noteResult.text.trim();
    const usableNote = isUsableResearchNote(task.topic, researchNote) ? researchNote : undefined;

    return {
      researchNote: usableNote,
      referenceUrls: fetchedUrls,
      queryCountUsed,
      searchQueries,
      usefulPageFound: Boolean(usableNote),
      usefulPageCount: usableNote ? 1 : 0,
      fetchedPageCount: fetchedUrls.length,
      diagnostics: {
        outcome: usableNote ? 'ok' : 'no_research_note',
        messages: diagnostics.slice(0, 5),
      },
    };
  };
};

const EMPTY_EVIDENCE: KnowFlowEvidence = {
  referenceUrls: [],
  queryCountUsed: 0,
  usefulPageFound: false,
  usefulPageCount: 0,
  fetchedPageCount: 0,
  diagnostics: { outcome: 'no_research_note', messages: [] },
};

const defaultEvidenceProvider: EvidenceProvider = async () => EMPTY_EVIDENCE;

const recordResearchNote = async (input: {
  task: TopicTask;
  evidence: KnowFlowEvidence;
  logger: StructuredLogger;
  database?: typeof defaultDb;
}): Promise<boolean> => {
  if (!isUsableResearchNote(input.task.topic, input.evidence.researchNote)) {
    return false;
  }

  const database = input.database ?? defaultDb;
  const referenceUrls = uniqueStrings(input.evidence.referenceUrls ?? []);
  const conceptId = generateEntityId('concept', input.task.topic);
  const now = new Date();

  await database
    .insert(entities)
    .values({
      id: conceptId,
      type: 'concept',
      name: input.task.topic,
      description: input.evidence.researchNote.trim(),
      metadata: {
        kind: 'knowflow_research_note',
        source: 'knowflow',
        referenceUrls,
        lastKnowflowTaskId: input.task.id,
        lastKnowflowCompletedAt: now.toISOString(),
        fetchedPageCount: input.evidence.fetchedPageCount ?? referenceUrls.length,
        queryCountUsed: input.evidence.queryCountUsed ?? 0,
        searchQueries: input.evidence.searchQueries ?? [],
      },
      confidence: null,
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
        confidence: null,
        provenance: sql`excluded.provenance`,
        scope: sql`excluded.scope`,
        freshness: sql`excluded.freshness`,
      },
    });

  input.logger({
    event: 'knowflow.research_note.recorded',
    taskId: input.task.id,
    topic: input.task.topic,
    conceptId,
    referenceUrlCount: referenceUrls.length,
    level: 'info',
  });
  return true;
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
    return { ok: false, error: summary };
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
  const evidenceProvider = options.evidenceProvider ?? defaultEvidenceProvider;
  const cronRunWindowMs = Math.max(
    1,
    Math.trunc(options.cronRunWindowMs ?? config.knowflow.worker.cronRunWindowMs),
  );
  let cronRunWindowStartedAt = 0;
  let cronRunConsumed = 0;

  return async (task, signal): Promise<TaskExecutionResult> => {
    const systemTaskResult = await runSystemTask(task);
    if (systemTaskResult) return systemTaskResult;

    const now = options.now?.() ?? Date.now();
    if (
      cronRunWindowStartedAt === 0 ||
      now < cronRunWindowStartedAt ||
      now - cronRunWindowStartedAt >= cronRunWindowMs
    ) {
      cronRunWindowStartedAt = now;
      cronRunConsumed = 0;
    }

    try {
      const evidence = await evidenceProvider(task, signal);
      const recorded = await recordResearchNote({
        task,
        evidence,
        logger,
        database: options.database,
      });

      metrics.record({
        taskId: task.id,
        source: task.source,
        ok: recorded,
        changed: recorded,
        retries: task.attempts,
        recordedNotes: recorded ? 1 : 0,
        missedNotes: recorded ? 0 : 1,
        conflicts: 0,
      });

      if (!recorded) {
        const outcome = evidence.diagnostics?.outcome ?? 'no_research_note';
        const detail = evidence.diagnostics?.messages?.[0];
        logger({
          event: 'knowflow.research_note.not_recorded',
          taskId: task.id,
          topic: task.topic,
          outcome,
          message: detail,
          level: 'warn',
        });
        return {
          ok: false,
          error: detail ? `${outcome}: ${detail}` : outcome,
        };
      }

      if (task.source !== 'user') {
        cronRunConsumed += 1;
      }

      return {
        ok: true,
        summary: `research_note_recorded fetched=${evidence.fetchedPageCount ?? 0} references=${
          evidence.referenceUrls?.length ?? 0
        } cronRunConsumed=${cronRunConsumed}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      metrics.record({
        taskId: task.id,
        source: task.source,
        ok: false,
        retries: task.attempts,
        recordedNotes: 0,
        missedNotes: 0,
        conflicts: 0,
      });
      logger({
        event: 'task.flow.error',
        taskId: task.id,
        topic: task.topic,
        error: message,
        level: 'error',
      });
      return { ok: false, error: message };
    }
  };
};
