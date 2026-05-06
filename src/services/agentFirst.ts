import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { entities, experienceLogs } from '../db/schema.js';
import { searchEntityKnowledgeDetailed } from './entityKnowledge.js';
import { generateEmbedding, searchMemoriesByType } from './memory.js';

export type KnowledgeKind =
  | 'project_doc'
  | 'rule'
  | 'procedure'
  | 'skill'
  | 'decision'
  | 'lesson'
  | 'observation'
  | 'risk'
  | 'command_recipe'
  | 'reference';

export type KnowledgeCategory =
  | 'project_overview'
  | 'architecture'
  | 'mcp'
  | 'memory'
  | 'workflow'
  | 'testing'
  | 'operation'
  | 'debugging'
  | 'coding_convention'
  | 'security'
  | 'performance'
  | 'reference';

export type TaskChangeType =
  | 'frontend'
  | 'backend'
  | 'api'
  | 'auth'
  | 'db'
  | 'docs'
  | 'test'
  | 'mcp'
  | 'refactor'
  | 'config'
  | 'build'
  | 'review';

export const REQUIRED_PRIMARY_TOOLS = [
  'initial_instructions',
  'agentic_search',
  'search_knowledge',
  'record_task_note',
  'review_task',
  'doctor',
] as const;

export type SearchKnowledgeV2Input = {
  query?: string;
  taskGoal?: string;
  files?: string[];
  changeTypes?: TaskChangeType[];
  technologies?: string[];
  intent?: 'plan' | 'edit' | 'debug' | 'review' | 'finish';
};

type SearchEntityKnowledgeFn = typeof searchEntityKnowledgeDetailed;
type AgentFirstDbClient = Pick<typeof db, 'insert'>;
type GenerateKnowledgeEmbedding = typeof generateEmbedding;

export type AgenticSearchInput = {
  userRequest: string;
  repoPath?: string;
  files?: string[];
  changeTypes?: TaskChangeType[];
  technologies?: string[];
  intent?: 'plan' | 'edit' | 'debug' | 'review' | 'finish';
  queryPhrases?: string[];
};

export type AgenticSearchTaskEnvelope = {
  request: string;
  intent: 'plan' | 'edit' | 'debug' | 'review' | 'finish';
  repoPath?: string;
  files: string[];
  changeTypes: TaskChangeType[];
  technologies: string[];
  tokens: string[];
};

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'する', 'して', 'こと']);

export function buildAgenticSearchTaskEnvelope(
  input: AgenticSearchInput,
): AgenticSearchTaskEnvelope {
  const tokens = Array.from(
    new Set(
      input.userRequest
        .toLowerCase()
        .split(/[^a-z0-9_\-/\u3040-\u30ff\u3400-\u9fff]+/u)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2 && !STOP_WORDS.has(t)),
    ),
  ).slice(0, 24);

  return {
    request: input.userRequest,
    intent: input.intent ?? 'edit',
    repoPath: input.repoPath,
    files: input.files ?? [],
    changeTypes: input.changeTypes ?? [],
    technologies: input.technologies ?? [],
    tokens,
  };
}

export function selectAgenticSearchPhrases(task: AgenticSearchTaskEnvelope): string[] {
  return Array.from(
    new Set([
      ...task.changeTypes,
      ...task.technologies,
      ...task.files.flatMap((file) => file.split('/').slice(-2)),
      ...task.tokens,
    ]),
  )
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 16);
}

const pushSearchText = (parts: string[], value: string | undefined): void => {
  const normalized = value?.trim().replace(/\s+/g, ' ');
  if (normalized) parts.push(normalized);
};

export function buildKnowledgeQueryText(input: SearchKnowledgeV2Input): string {
  const parts: string[] = [];
  pushSearchText(parts, input.taskGoal);
  pushSearchText(parts, input.query);
  for (const file of input.files ?? []) pushSearchText(parts, file);
  for (const changeType of input.changeTypes ?? []) pushSearchText(parts, changeType);
  for (const technology of input.technologies ?? []) pushSearchText(parts, technology);
  pushSearchText(parts, input.intent);

  return Array.from(new Set(parts)).join(' ').slice(0, 1200).trim();
}

export async function searchKnowledgeV2(
  input: SearchKnowledgeV2Input,
  deps: { searchEntityKnowledge?: SearchEntityKnowledgeFn } = {},
) {
  const taskText = buildKnowledgeQueryText(input);
  if (taskText.length < 8) {
    return {
      taskContext: null,
      groups: [],
      flatTopHits: [],
      suggestedNextAction: 'refine_query',
      degraded: { reason: 'insufficient_task_context' },
    };
  }

  const search = deps.searchEntityKnowledge ?? searchEntityKnowledgeDetailed;
  const { results: hits, telemetry } = await search({
    query: taskText,
    type: 'all',
    limit: 10,
  });
  const flatTopHits = hits.map((hit) => ({
    id: hit.id,
    type: hit.type,
    title: hit.title,
    content: hit.content,
    score: hit.score,
    source: hit.source,
    matchSources: hit.matchSources,
    sourceScores: hit.sourceScores,
    confidence: hit.confidence,
    metadata: hit.metadata,
  }));
  const grouped = new Map<string, typeof flatTopHits>();
  for (const hit of flatTopHits) {
    const group = hit.type || 'unknown';
    const current = grouped.get(group) ?? [];
    current.push(hit);
    grouped.set(group, current);
  }

  return {
    taskContext: {
      intent: input.intent ?? 'edit',
      files: input.files ?? [],
      changeTypes: input.changeTypes ?? [],
      technologies: input.technologies ?? [],
    },
    retrieval: {
      queryText: telemetry.queryText,
      mode: 'merged_embedding_and_lexical',
      vectorHitCount: telemetry.vectorHitCount,
      exactHitCount: telemetry.exactHitCount,
      fullTextHitCount: telemetry.fullTextHitCount,
      directTextHitCount: telemetry.directTextHitCount,
      recentFallbackUsed: telemetry.recentFallbackUsed,
      embeddingStatus: telemetry.embeddingStatus,
      mergedCandidateCount: telemetry.mergedCandidateCount,
    },
    groups: Array.from(grouped.entries()).map(([type, items]) => ({
      type,
      items,
    })),
    flatTopHits,
  };
}

export async function agenticSearch(input: AgenticSearchInput) {
  const task = buildAgenticSearchTaskEnvelope(input);
  const selectedPhrases =
    input.queryPhrases && input.queryPhrases.length > 0
      ? input.queryPhrases
      : selectAgenticSearchPhrases(task);
  const usedKnowledge: Array<{
    id: string;
    title: string;
    summary: string;
    reason: string;
    kind?: string;
    category?: string;
  }> = [];

  try {
    const memories = await searchMemoriesByType(
      [task.request, ...selectedPhrases].join(' '),
      'raw',
      6,
    );
    for (const memory of memories) {
      const meta =
        memory.metadata && typeof memory.metadata === 'object'
          ? (memory.metadata as Record<string, unknown>)
          : {};
      usedKnowledge.push({
        id: String(memory.id),
        title:
          typeof meta.title === 'string' && meta.title.trim().length > 0
            ? meta.title
            : `memory:${String(memory.id)}`,
        summary: String(memory.content ?? ''),
        reason: `memory similarity ${Number(memory.similarity ?? 0).toFixed(4)}`,
        kind: typeof meta.kind === 'string' ? meta.kind : undefined,
        category: typeof meta.category === 'string' ? meta.category : undefined,
      });
    }
  } catch {
    // Keep no_relevant_knowledge and let caller fallback to web search.
  }

  const result = {
    task,
    selectedPhrases,
    decision:
      usedKnowledge.length > 0 ? ('use_knowledge' as const) : ('no_relevant_knowledge' as const),
    usedKnowledge,
  };

  return result;
}

const normalizeStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0)
    : [];

const uniqueStrings = (values: string[]): string[] => Array.from(new Set(values));

const deriveKnowledgeTitle = (content: string, title?: string): string => {
  const normalizedTitle = title?.trim();
  if (normalizedTitle) return normalizedTitle;
  return content.split(/\r?\n/)[0]?.trim().slice(0, 96) || 'Untitled knowledge note';
};

const searchableMetadataText = (metadata: Record<string, unknown>): string => {
  const terms: string[] = [];
  for (const key of [
    'kind',
    'category',
    'purpose',
    'intent',
    'source',
    'taskId',
    'tags',
    'files',
    'evidence',
    'triggerPhrases',
    'appliesWhen',
    'changeTypes',
    'technologies',
  ]) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) {
      terms.push(value.trim());
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) terms.push(item.trim());
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          for (const nested of Object.values(item)) {
            if (typeof nested === 'string' && nested.trim()) terms.push(nested.trim());
          }
        }
      }
    }
  }
  return uniqueStrings(terms).join(' ');
};

const buildTaskNoteEmbeddingText = (
  title: string,
  content: string,
  metadata: Record<string, unknown>,
): string =>
  [title, content, searchableMetadataText(metadata)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');

export async function recordTaskNote(
  input: {
    content: string;
    taskId?: string;
    kind?: KnowledgeKind;
    category?: KnowledgeCategory;
    title?: string;
    purpose?: string;
    tags?: string[];
    evidence?: Array<{ type?: string; value?: string; uri?: string }>;
    files?: string[];
    metadata?: Record<string, unknown>;
    triggerPhrases?: string[];
    appliesWhen?: string[];
    intent?: 'plan' | 'edit' | 'debug' | 'review' | 'finish';
    changeTypes?: TaskChangeType[];
    technologies?: string[];
    confidence?: number;
    source?: 'manual' | 'task' | 'review' | 'onboarding' | 'import';
  },
  deps: {
    database?: AgentFirstDbClient;
    generateKnowledgeEmbedding?: GenerateKnowledgeEmbedding;
  } = {},
) {
  const content = input.content.trim();
  if (content.length === 0) {
    return {
      saved: false,
      entityId: null,
      kind: input.kind ?? 'observation',
      category: input.category ?? 'reference',
      failureFirewallCandidateState: { saved: false, reason: 'empty_content' },
    };
  }

  const database = deps.database ?? db;
  const generateKnowledgeEmbedding = deps.generateKnowledgeEmbedding ?? generateEmbedding;
  const rawMetadata = typeof input.metadata === 'object' && input.metadata ? input.metadata : {};
  const title = deriveKnowledgeTitle(content, input.title);
  const tags = uniqueStrings(
    (input.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean),
  );
  const triggerPhrases = uniqueStrings([
    ...normalizeStringArray(rawMetadata.triggerPhrases),
    ...normalizeStringArray(input.triggerPhrases),
  ]);
  const appliesWhen = uniqueStrings([
    ...normalizeStringArray(rawMetadata.appliesWhen),
    ...normalizeStringArray(input.appliesWhen),
  ]);
  const hasFirewallTag = tags.includes('failure-firewall');
  const hasGoldenPathTag = tags.includes('golden-path');
  const noteHash = createHash('sha256').update(content).digest('hex');
  const entityId = `note/${noteHash.slice(0, 12)}`;
  const kind = input.kind ?? 'observation';
  const category = input.category ?? 'reference';
  const source = input.source ?? 'manual';
  const now = new Date();
  const metadata = {
    ...rawMetadata,
    title,
    tags,
    source,
    kind,
    category,
    purpose: input.purpose ?? undefined,
    taskId: input.taskId ?? undefined,
    files: input.files ?? [],
    evidence: input.evidence ?? [],
    confidence: input.confidence ?? undefined,
    triggerPhrases,
    appliesWhen,
    intent: input.intent ?? rawMetadata.intent ?? undefined,
    changeTypes: uniqueStrings([
      ...normalizeStringArray(rawMetadata.changeTypes),
      ...(input.changeTypes ?? []),
    ]),
    technologies: uniqueStrings([
      ...normalizeStringArray(rawMetadata.technologies),
      ...(input.technologies ?? []),
    ]),
    recordedBy: 'record_task_note',
    recordedAt: now.toISOString(),
  };
  let embeddingStatus: 'stored' | 'unavailable' = 'unavailable';
  let embedding: number[] | null = null;

  let failureFirewallCandidateState:
    | { saved: false; reason: string }
    | { saved: true; type: 'failure' | 'success'; scenarioId: string } = {
    saved: false,
    reason: 'no_firewall_tags',
  };

  try {
    embedding = await generateKnowledgeEmbedding(
      buildTaskNoteEmbeddingText(title, content, metadata),
      {
        type: 'passage',
        priority: 'normal',
      },
    );
    embeddingStatus = 'stored';
  } catch {
    embeddingStatus = 'unavailable';
  }

  await database
    .insert(entities)
    .values({
      id: entityId,
      type: kind,
      name: title,
      description: content,
      embedding,
      metadata,
      confidence: input.confidence ?? 0.6,
      provenance: source,
      scope: 'task_note',
      freshness: now,
    })
    .onConflictDoUpdate({
      target: entities.id,
      set: {
        type: sql`excluded.type`,
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        embedding: sql`COALESCE(excluded.embedding, ${entities.embedding})`,
        metadata: sql`COALESCE(${entities.metadata}, '{}'::jsonb) || excluded.metadata`,
        confidence: sql`COALESCE(excluded.confidence, ${entities.confidence})`,
        provenance: sql`excluded.provenance`,
        scope: sql`excluded.scope`,
        freshness: sql`excluded.freshness`,
      },
    });

  if (hasFirewallTag || hasGoldenPathTag) {
    const type: 'failure' | 'success' = hasGoldenPathTag ? 'success' : 'failure';
    const scenarioId =
      typeof rawMetadata.scenarioId === 'string' && rawMetadata.scenarioId.trim().length > 0
        ? rawMetadata.scenarioId
        : `firewall-${noteHash.slice(0, 12)}`;

    const experienceMetadata = {
      ...metadata,
      ...(hasGoldenPathTag
        ? {
            pathId: typeof rawMetadata.pathId === 'string' ? rawMetadata.pathId : entityId,
            pathType:
              typeof rawMetadata.pathType === 'string' ? rawMetadata.pathType : 'record_task_note',
            reusableSteps: Array.isArray(rawMetadata.reusableSteps)
              ? rawMetadata.reusableSteps
              : [],
            blockWhenMissing: Array.isArray(rawMetadata.blockWhenMissing)
              ? rawMetadata.blockWhenMissing
              : [],
            riskSignals: Array.isArray(rawMetadata.riskSignals) ? rawMetadata.riskSignals : [],
          }
        : {
            patternId: typeof rawMetadata.patternId === 'string' ? rawMetadata.patternId : entityId,
            patternType:
              typeof rawMetadata.patternType === 'string'
                ? rawMetadata.patternType
                : 'record_task_note',
            severity: typeof rawMetadata.severity === 'string' ? rawMetadata.severity : 'warning',
            riskSignals: Array.isArray(rawMetadata.riskSignals) ? rawMetadata.riskSignals : [],
            matchHints: Array.isArray(rawMetadata.matchHints) ? rawMetadata.matchHints : [],
            requiredEvidence: Array.isArray(rawMetadata.requiredEvidence)
              ? rawMetadata.requiredEvidence
              : [],
          }),
    };

    await database.insert(experienceLogs).values({
      sessionId: 'mcp-record-task-note',
      scenarioId,
      attempt: 1,
      type,
      failureType:
        type === 'failure'
          ? typeof rawMetadata.failureType === 'string'
            ? rawMetadata.failureType
            : 'record_task_note'
          : null,
      content,
      metadata: experienceMetadata,
    });
    failureFirewallCandidateState = { saved: true, type, scenarioId };
  }

  return {
    saved: true,
    entityId,
    kind,
    category,
    embeddingStatus,
    failureFirewallCandidateState,
  };
}

export function buildToolSnapshotForDoctor(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
) {
  return tools.map((tool) => ({
    name: tool.name,
    schemaHash: createHash('sha256')
      .update(JSON.stringify(tool.inputSchema ?? {}))
      .digest('hex'),
    descriptionHash: createHash('sha256')
      .update(tool.description ?? '')
      .digest('hex'),
  }));
}

export async function resolveStaleMetadataSignal(input: {
  clientSnapshot?: Array<{
    name: string;
    schemaHash?: string;
    descriptionHash?: string;
    schemaVersion?: string;
    descriptionVersion?: string;
  }>;
}) {
  if (!input.clientSnapshot || input.clientSnapshot.length === 0) {
    return { status: 'unknown', reasons: ['client_snapshot_unavailable'], evidence: [] };
  }
  return { status: 'fresh', reasons: [], evidence: [] };
}

export async function buildDoctorRuntimeHealth() {
  return {
    toolVisibility: {
      status: 'ok' as const,
      exposedToolCount: REQUIRED_PRIMARY_TOOLS.length,
      requiredPrimaryTools: [...REQUIRED_PRIMARY_TOOLS],
      presentPrimaryTools: [...REQUIRED_PRIMARY_TOOLS],
      missingPrimaryTools: [],
    },
    db: { status: 'ok' as const },
    knowledgeIndex: { status: 'unknown' as const, staleAfterHours: 72 },
  };
}

export async function buildActivateProjectResult(repoPath: string, stage: string) {
  return {
    repoPath,
    stage,
    knowledgeIndex: {
      totalActive: 0,
      byKind: { rule: 0 },
      topItems: [],
    },
  };
}
