import { createHash } from 'node:crypto';
import { searchMemoriesByType } from './memory.js';

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

export async function searchKnowledgeV2(input: SearchKnowledgeV2Input) {
  const taskText = `${input.taskGoal ?? ''} ${input.query ?? ''}`.trim();
  if (taskText.length < 8) {
    return {
      taskContext: null,
      groups: [],
      flatTopHits: [],
      suggestedNextAction: 'refine_query',
      degraded: { reason: 'insufficient_task_context' },
    };
  }
  return {
    taskContext: {
      intent: input.intent ?? 'edit',
      files: input.files ?? [],
      changeTypes: input.changeTypes ?? [],
      technologies: input.technologies ?? [],
    },
    groups: [],
    flatTopHits: [],
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

export async function recordTaskNote(input: {
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
  confidence?: number;
  source?: 'manual' | 'task' | 'review' | 'onboarding' | 'import';
}) {
  return {
    saved: input.content.trim().length > 0,
    entityId: `note/${createHash('sha256').update(input.content).digest('hex').slice(0, 12)}`,
    kind: input.kind ?? 'observation',
    category: input.category ?? 'reference',
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
