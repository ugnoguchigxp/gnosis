import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { desc, inArray, sql } from 'drizzle-orm';
import { envBoolean } from '../config.js';
import { GNOSIS_CONSTANTS } from '../constants.js';
import { db } from '../db/index.js';
import { entities, relations } from '../db/schema.js';
import { generateEntityId } from '../utils/entityId.js';
import { lookupFailureFirewallContext } from './failureFirewall/context.js';
import type { FailureFirewallContext } from './failureFirewall/types.js';
import { generateEmbedding, searchMemoriesByType } from './memory.js';
import { runPromptWithMemoryLoopRouter } from './memoryLoopLlmRouter.js';

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

type InferredProjectLanguage = 'TypeScript' | 'JavaScript' | 'Python' | 'Rust' | 'Go' | 'Unknown';

type EntityRow = typeof entities.$inferSelect;
type RelationRow = typeof relations.$inferSelect;

const DEFAULT_KNOWLEDGE_KIND: KnowledgeKind = 'observation';
const DEFAULT_KNOWLEDGE_CATEGORY: KnowledgeCategory = 'reference';
const KNOWLEDGE_KIND_SET = new Set<KnowledgeKind>([
  'project_doc',
  'rule',
  'procedure',
  'skill',
  'decision',
  'lesson',
  'observation',
  'risk',
  'command_recipe',
  'reference',
]);
const KNOWLEDGE_CATEGORY_SET = new Set<KnowledgeCategory>([
  'project_overview',
  'architecture',
  'mcp',
  'memory',
  'workflow',
  'testing',
  'operation',
  'debugging',
  'coding_convention',
  'security',
  'performance',
  'reference',
]);

const TASK_CHANGE_TYPE_SET = new Set<TaskChangeType>([
  'frontend',
  'backend',
  'api',
  'auth',
  'db',
  'docs',
  'test',
  'mcp',
  'refactor',
  'config',
  'build',
  'review',
]);

function relationTypeForKnowledgeKind(kind: KnowledgeKind): string {
  if (kind === 'lesson') return 'captured_lesson';
  if (kind === 'rule') return 'captured_rule';
  if (kind === 'procedure' || kind === 'skill' || kind === 'command_recipe') {
    return 'captured_procedure';
  }
  if (kind === 'decision') return 'captured_decision';
  if (kind === 'risk') return 'captured_risk';
  return 'captured_knowledge';
}

async function linkTaskTraceToKnowledge(input: {
  taskId?: string;
  entityId: string;
  kind: KnowledgeKind;
}) {
  if (!input.taskId || input.taskId === input.entityId) return false;

  const linkedEntities = await db
    .select({ id: entities.id })
    .from(entities)
    .where(inArray(entities.id, [input.taskId, input.entityId]));
  const ids = new Set(linkedEntities.map((row) => row.id));
  if (!ids.has(input.taskId) || !ids.has(input.entityId)) return false;

  await db
    .insert(relations)
    .values({
      sourceId: input.taskId,
      targetId: input.entityId,
      relationType: relationTypeForKnowledgeKind(input.kind),
      weight: 1,
      confidence: 0.8,
      sourceTask: input.taskId,
      provenance: 'task',
    })
    .onConflictDoNothing();

  return true;
}
export const REQUIRED_PRIMARY_TOOLS = [
  'initial_instructions',
  'agentic_search',
  'search_knowledge',
  'record_task_note',
  'review_task',
  'doctor',
] as const;

export type DoctorRuntimeHealth = {
  toolVisibility: {
    status: 'ok' | 'missing_required_primary_tool';
    exposedToolCount: number;
    requiredPrimaryTools: string[];
    presentPrimaryTools: string[];
    missingPrimaryTools: string[];
  };
  db: {
    status: 'ok' | 'unavailable';
    detail?: string;
  };
  knowledgeIndex: {
    status: 'fresh' | 'stale' | 'empty' | 'unknown';
    totalEntities?: number;
    lastUpdatedAt?: string;
    ageHours?: number;
    staleAfterHours: number;
    detail?: string;
  };
};

export type SearchKnowledgeV2Input = {
  query?: string;
  taskGoal?: string;
  preset?: 'task_context' | 'project_characteristics' | 'review_context' | 'procedures' | 'risks';
  kinds?: KnowledgeKind[];
  categories?: KnowledgeCategory[];
  changeTypes?: TaskChangeType[];
  technologies?: string[];
  filterMode?: 'and' | 'or';
  filters?: {
    kinds?: { mode?: 'and' | 'or'; values: KnowledgeKind[] };
    categories?: { mode?: 'and' | 'or'; values: KnowledgeCategory[] };
    tags?: { mode?: 'and' | 'or'; values: string[] };
    files?: { mode?: 'and' | 'or'; values: string[] };
    relationTypes?: { mode?: 'and' | 'or'; values: string[] };
  };
  files?: string[];
  intent?: 'plan' | 'edit' | 'debug' | 'review' | 'finish';
  limitPerCategory?: number;
  maxCategories?: number;
  includeContent?: 'summary' | 'snippet' | 'full';
  grouping?: 'by_category' | 'flat';
  traversal?: {
    enabled?: boolean;
    maxDepth?: number;
    relationTypes?: string[];
  };
};

export type AgenticSearchInput = {
  userRequest: string;
  repoPath?: string;
  files?: string[];
  changeTypes?: TaskChangeType[];
  technologies?: string[];
  intent?: 'plan' | 'edit' | 'debug' | 'review' | 'finish';
  includeRawMemory?: boolean;
  maxCandidates?: number;
  maxReturned?: number;
  localLlm?: {
    enabled?: boolean;
    required?: boolean;
    timeoutMs?: number;
  };
};

type AgenticSearchCandidate = {
  id: string;
  source: 'entity' | 'vibe_memory';
  kind?: string;
  category?: string;
  title: string;
  summary: string;
  reason: string;
  score?: number;
};

type AgenticLlmDecision = {
  id: string;
  decision: 'use' | 'skip' | 'maybe';
  confidence: number;
  reason: string;
  summary?: string;
};

type AppliesWhen = {
  intents: Array<NonNullable<SearchKnowledgeV2Input['intent']>>;
  changeTypes: TaskChangeType[];
  fileGlobs: string[];
  technologies: string[];
  keywords: string[];
  severity?: 'blocking' | 'required' | 'advisory';
};

type TaskContext = {
  query: string;
  intent?: NonNullable<SearchKnowledgeV2Input['intent']>;
  files: string[];
  changeTypes: TaskChangeType[];
  technologies: string[];
  taskText: string;
};

type SearchKnowledgeRefineReason = 'insufficient_task_context' | 'db_unavailable';

type ToolSnapshot = {
  name: string;
  schemaHash?: string;
  descriptionHash?: string;
  schemaVersion?: string;
  descriptionVersion?: string;
};

type NormalizedToolSnapshot = {
  name: string;
  schemaHash: string;
  descriptionHash: string;
};

type AgenticSearchFailureFirewallHint = {
  shouldUse: boolean;
  reason: string;
  suggestedUse: FailureFirewallContext['suggestedUse'];
  riskSignals: string[];
  goldenPathCandidates: Array<{ id: string; title: string; score: number }>;
  failurePatternCandidates: Array<{
    id: string;
    title: string;
    severity: string;
    score: number;
  }>;
  degradedReasons: string[];
};

export type StaleMetadataSignal = {
  status: 'ok' | 'suspected_stale' | 'unknown';
  reasons: Array<
    | 'missing_required_primary_tool'
    | 'tool_schema_version_mismatch'
    | 'tool_description_version_mismatch'
    | 'client_snapshot_unavailable'
  >;
  evidence: Array<{
    tool: string;
    expectedVersion?: string;
    observedVersion?: string;
    detail: string;
  }>;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function asTaskChangeTypeArray(value: unknown): TaskChangeType[] {
  return asStringArray(value).filter((item): item is TaskChangeType =>
    TASK_CHANGE_TYPE_SET.has(item as TaskChangeType),
  );
}

function toSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function buildToolSnapshotForDoctor(
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>,
): NormalizedToolSnapshot[] {
  return tools.map((tool) => ({
    name: tool.name,
    schemaHash: sha256(stableStringify(tool.inputSchema)),
    descriptionHash: sha256(tool.description),
  }));
}

function fallbackCategoryByKind(kind: KnowledgeKind): KnowledgeCategory {
  if (kind === 'rule') return 'coding_convention';
  if (kind === 'procedure' || kind === 'command_recipe') return 'workflow';
  if (kind === 'risk') return 'security';
  if (kind === 'decision') return 'architecture';
  if (kind === 'lesson') return 'debugging';
  return DEFAULT_KNOWLEDGE_CATEGORY;
}

function normalizeKind(rawType: string | null | undefined): KnowledgeKind {
  if (rawType === 'constraint') return 'rule';
  if (rawType === 'task') return 'skill';
  if (rawType && KNOWLEDGE_KIND_SET.has(rawType as KnowledgeKind)) {
    return rawType as KnowledgeKind;
  }
  return DEFAULT_KNOWLEDGE_KIND;
}

function normalizeCategory(rawCategory: unknown, kind: KnowledgeKind): KnowledgeCategory {
  if (
    typeof rawCategory === 'string' &&
    KNOWLEDGE_CATEGORY_SET.has(rawCategory as KnowledgeCategory)
  ) {
    return rawCategory as KnowledgeCategory;
  }
  return fallbackCategoryByKind(kind);
}

function normalizeAppliesWhen(raw: unknown): AppliesWhen {
  const value = asRecord(raw);
  const legacyApplicability = asRecord(value.applicability);
  return {
    intents: asStringArray(value.intents).filter(
      (intent): intent is NonNullable<SearchKnowledgeV2Input['intent']> =>
        ['plan', 'edit', 'debug', 'review', 'finish'].includes(intent),
    ),
    changeTypes: asTaskChangeTypeArray(value.changeTypes),
    fileGlobs: [...asStringArray(value.fileGlobs), ...asStringArray(legacyApplicability.paths)],
    technologies: [
      ...asStringArray(value.technologies),
      ...asStringArray(legacyApplicability.languages),
      ...asStringArray(legacyApplicability.frameworks),
    ].map((item) => item.toLowerCase()),
    keywords: asStringArray(value.keywords).map((item) => item.toLowerCase()),
    severity:
      value.severity === 'blocking' ||
      value.severity === 'required' ||
      value.severity === 'advisory'
        ? value.severity
        : undefined,
  };
}

function inferLanguage(root: string): InferredProjectLanguage[] {
  const langs = new Set<InferredProjectLanguage>();
  if (existsSync(path.join(root, 'tsconfig.json'))) langs.add('TypeScript');
  if (existsSync(path.join(root, 'package.json'))) langs.add('JavaScript');
  if (
    existsSync(path.join(root, 'pyproject.toml')) ||
    existsSync(path.join(root, 'requirements.txt'))
  ) {
    langs.add('Python');
  }
  if (existsSync(path.join(root, 'Cargo.toml'))) langs.add('Rust');
  if (existsSync(path.join(root, 'go.mod'))) langs.add('Go');
  if (langs.size === 0) langs.add('Unknown');
  return [...langs];
}

function normalizeEntity(entity: EntityRow) {
  const metadata = asRecord(entity.metadata);
  const kind = normalizeKind(entity.type);
  const category = normalizeCategory(metadata.category, kind);
  const title = entity.name?.trim() || `Knowledge ${entity.id}`;
  const description = entity.description?.trim() || '';
  const purposeRaw = metadata.purpose;
  const purpose =
    typeof purposeRaw === 'string' && purposeRaw.length > 0
      ? purposeRaw
      : `Use this ${kind} when handling ${category} concerns.`;
  const tags = asStringArray(metadata.tags);
  const files = asStringArray(metadata.files);
  const appliesWhen = normalizeAppliesWhen({
    ...asRecord(metadata.appliesWhen),
    applicability: metadata.applicability,
  });
  const slugRaw = metadata.slug;
  const slug =
    typeof slugRaw === 'string' && slugRaw.length > 0 ? slugRaw : toSlug(title || entity.id);
  const confidence = typeof entity.confidence === 'number' ? entity.confidence : 0.5;
  return {
    entity,
    metadata,
    kind,
    category,
    title,
    description,
    purpose,
    tags,
    files,
    appliesWhen,
    slug,
    confidence,
    scope: entity.scope === 'always' ? 'always' : 'on_demand',
    status: typeof metadata.status === 'string' ? metadata.status : 'active',
  };
}

function splitTerms(value: string): string[] {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((v) => v.trim())
    .filter((v) => v.length > 1);
}

function inferChangeTypesFromText(text: string): TaskChangeType[] {
  const normalized = text.toLowerCase();
  const inferred: TaskChangeType[] = [];
  const add = (type: TaskChangeType, patterns: string[]) => {
    if (patterns.some((pattern) => normalized.includes(pattern))) {
      inferred.push(type);
    }
  };
  add('frontend', ['frontend', 'react', 'svelte', 'ui', 'component', 'page']);
  add('backend', ['backend', 'server', 'service', 'repository', 'controller']);
  add('api', ['api', 'endpoint', 'route', 'openapi']);
  add('auth', ['auth', 'msal', 'login', 'token', 'permission']);
  add('db', ['db', 'database', 'drizzle', 'migration', 'schema', 'sql']);
  add('docs', ['docs', 'document', 'readme', '.md']);
  add('test', ['test', 'spec', 'vitest', 'coverage']);
  add('mcp', ['mcp', 'tool', 'initial_instructions', 'search_knowledge']);
  add('refactor', ['refactor', 'リファクタ']);
  add('config', ['config', 'setting', 'tsconfig', 'biome', 'package.json']);
  add('build', ['build', 'lint', 'typecheck', 'compile']);
  add('review', ['review', 'レビュー']);
  return [...new Set(inferred)];
}

function inferChangeTypesFromFiles(files: string[]): TaskChangeType[] {
  const inferred: TaskChangeType[] = [];
  for (const file of files.map((item) => item.toLowerCase())) {
    if (file.startsWith('apps/') || file.includes('/routes/') || file.endsWith('.svelte')) {
      inferred.push('frontend');
    }
    if (file.startsWith('src/services/') || file.startsWith('src/domain/')) {
      inferred.push('backend');
    }
    if (file.includes('/mcp/') || file.includes('mcp')) inferred.push('mcp');
    if (file.includes('/review/')) inferred.push('review');
    if (file.includes('/db/') || file.startsWith('drizzle/') || file.endsWith('.sql')) {
      inferred.push('db');
    }
    if (file.endsWith('.md') || file.startsWith('docs/')) inferred.push('docs');
    if (file.includes('test/') || file.endsWith('.test.ts') || file.endsWith('.spec.ts')) {
      inferred.push('test');
    }
    if (file.includes('auth')) inferred.push('auth');
    if (file.includes('api') || file.includes('route')) inferred.push('api');
    if (file.endsWith('package.json') || file.endsWith('tsconfig.json') || file.includes('biome')) {
      inferred.push('config');
    }
  }
  return [...new Set(inferred)];
}

function inferTechnologies(input: SearchKnowledgeV2Input, taskText: string): string[] {
  const technologies = new Set((input.technologies ?? []).map((item) => item.toLowerCase()));
  const text = taskText.toLowerCase();
  const files = input.files ?? [];
  if (
    files.some((file) => file.endsWith('.ts') || file.endsWith('.tsx')) ||
    text.includes('typescript')
  ) {
    technologies.add('typescript');
  }
  if (files.some((file) => file.endsWith('.svelte')) || text.includes('svelte')) {
    technologies.add('svelte');
  }
  if (text.includes('react')) technologies.add('react');
  if (text.includes('drizzle')) technologies.add('drizzle');
  if (text.includes('mcp')) technologies.add('mcp');
  if (text.includes('bun')) technologies.add('bun');
  return [...technologies];
}

function shouldLookupFailureFirewallContext(input: AgenticSearchInput): boolean {
  const text = [
    input.userRequest,
    ...(input.files ?? []),
    ...(input.changeTypes ?? []),
    ...(input.technologies ?? []),
  ]
    .join('\n')
    .toLowerCase();
  if ((input.changeTypes ?? []).length > 0 && input.changeTypes?.every((type) => type === 'docs')) {
    return false;
  }
  return /\b(review|security|auth|db|database|schema|migration|cache|mutation|mcp|api|backend|test|verify|commit|failure[-_ ]firewall|golden path)\b/.test(
    text,
  );
}

async function buildFailureFirewallHint(
  input: AgenticSearchInput,
): Promise<AgenticSearchFailureFirewallHint | undefined> {
  if (!shouldLookupFailureFirewallContext(input)) return undefined;
  const context = await lookupFailureFirewallContext({
    repoPath: input.repoPath,
    taskGoal: input.userRequest,
    files: input.files,
    changeTypes: input.changeTypes,
    technologies: input.technologies,
  });
  return {
    shouldUse: context.shouldUse,
    reason: context.reason,
    suggestedUse: context.suggestedUse,
    riskSignals: context.riskSignals,
    goldenPathCandidates: context.goldenPathCandidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      score: candidate.score,
    })),
    failurePatternCandidates: context.failurePatternCandidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      severity: candidate.severity,
      score: candidate.score,
    })),
    degradedReasons: context.degradedReasons,
  };
}

function buildQueryByPreset(input: SearchKnowledgeV2Input): string {
  if (input.query && input.query.trim().length > 0) return input.query.trim();
  if (input.preset === 'procedures') return 'procedure skill command';
  if (input.preset === 'risks') return 'risk lesson rule';
  if (input.preset === 'review_context') return 'review correctness architecture security';
  if (input.preset === 'task_context')
    return `${input.intent ?? 'task'} ${input.taskGoal ?? ''} ${(input.changeTypes ?? []).join(
      ' ',
    )} ${(input.technologies ?? []).join(' ')} ${(input.files ?? []).join(' ')}`.trim();
  if (input.preset === 'project_characteristics') return 'project architecture workflow';
  return '';
}

function buildTaskContext(input: SearchKnowledgeV2Input, query: string): TaskContext {
  const baseText = [
    query,
    input.taskGoal,
    input.intent,
    ...(input.files ?? []),
    ...(input.changeTypes ?? []),
    ...(input.technologies ?? []),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
  const files = input.files ?? [];
  const inferredChangeTypes = [
    ...(input.changeTypes ?? []),
    ...inferChangeTypesFromText(baseText),
    ...inferChangeTypesFromFiles(files),
  ];
  return {
    query,
    intent: input.intent,
    files,
    changeTypes: [...new Set(inferredChangeTypes)],
    technologies: inferTechnologies(input, baseText),
    taskText: baseText.toLowerCase(),
  };
}

function hasConcreteTaskContext(input: SearchKnowledgeV2Input): boolean {
  if (input.preset !== 'task_context') return true;
  const hasGoal = typeof input.taskGoal === 'string' && input.taskGoal.trim().length >= 12;
  const hasQuery = typeof input.query === 'string' && input.query.trim().length >= 12;
  const hasScope =
    (input.files?.length ?? 0) > 0 ||
    (input.changeTypes?.length ?? 0) > 0 ||
    (input.technologies?.length ?? 0) > 0;
  return (hasGoal || hasQuery) && hasScope;
}

function includesByMode(pool: string[], candidate: string[], mode: 'and' | 'or'): boolean {
  if (candidate.length === 0) return true;
  if (pool.length === 0) return false;
  if (mode === 'and') return candidate.every((value) => pool.includes(value));
  return candidate.some((value) => pool.includes(value));
}

function matchWithMode(values: boolean[], mode: 'and' | 'or'): boolean {
  if (values.length === 0) return true;
  if (mode === 'and') return values.every(Boolean);
  return values.some(Boolean);
}

function toNumberVector(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const vector = value.filter((entry): entry is number => typeof entry === 'number');
  return vector.length > 0 ? vector : null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function matchesGlob(file: string, pattern: string): boolean {
  const normalizedFile = file.replace(/\\/g, '/').toLowerCase();
  const normalizedPattern = pattern.replace(/\\/g, '/').toLowerCase();
  if (normalizedPattern.length === 0) return false;
  if (!normalizedPattern.includes('*')) return normalizedFile.includes(normalizedPattern);
  const regexSource = normalizedPattern.split('*').map(escapeRegex).join('.*');
  const regex = new RegExp(`^${regexSource}$`);
  return regex.test(normalizedFile);
}

function scoreApplicability(
  normalized: ReturnType<typeof normalizeEntity>,
  context: TaskContext,
): {
  applicabilityScore: number;
  applicabilityReasons: string[];
  severity?: AppliesWhen['severity'];
} {
  const reasons: string[] = [];
  let score = normalized.scope === 'always' ? 0.25 : 0;
  if (normalized.scope === 'always') reasons.push('always-on guidance');

  const appliesWhen = normalized.appliesWhen;
  if (context.intent && appliesWhen.intents.includes(context.intent)) {
    score += 0.2;
    reasons.push(`intent:${context.intent}`);
  }

  const changeTypeHits = appliesWhen.changeTypes.filter((type) =>
    context.changeTypes.includes(type),
  );
  if (changeTypeHits.length > 0) {
    score += Math.min(0.35, 0.18 + changeTypeHits.length * 0.06);
    reasons.push(`changeType:${changeTypeHits.join(',')}`);
  }

  const technologyHits = appliesWhen.technologies.filter((technology) =>
    context.technologies.includes(technology),
  );
  if (technologyHits.length > 0) {
    score += Math.min(0.25, 0.14 + technologyHits.length * 0.04);
    reasons.push(`technology:${technologyHits.join(',')}`);
  }

  const filePatterns = [...normalized.files, ...appliesWhen.fileGlobs];
  const fileHits = context.files.filter((file) =>
    filePatterns.some((pattern) => matchesGlob(file, pattern)),
  );
  if (fileHits.length > 0) {
    score += Math.min(0.3, 0.18 + fileHits.length * 0.04);
    reasons.push(`file:${fileHits.slice(0, 3).join(',')}`);
  }

  const keywordHits = appliesWhen.keywords.filter((keyword) => context.taskText.includes(keyword));
  if (keywordHits.length > 0) {
    score += Math.min(0.2, 0.1 + keywordHits.length * 0.03);
    reasons.push(`keyword:${keywordHits.join(',')}`);
  }

  if (context.changeTypes.includes('mcp') && normalized.category === 'mcp') {
    score += 0.18;
    reasons.push('category:mcp');
  }
  if (context.changeTypes.includes('test') && normalized.category === 'testing') {
    score += 0.14;
    reasons.push('category:testing');
  }
  if (
    (context.changeTypes.includes('auth') || context.changeTypes.includes('db')) &&
    normalized.category === 'security'
  ) {
    score += 0.14;
    reasons.push('category:security');
  }
  if (context.changeTypes.includes('refactor') && normalized.category === 'architecture') {
    score += 0.1;
    reasons.push('category:architecture');
  }

  return {
    applicabilityScore: Math.min(1, score),
    applicabilityReasons: reasons,
    severity: appliesWhen.severity,
  };
}

function scoreEntity(
  normalized: ReturnType<typeof normalizeEntity>,
  queryTerms: string[],
  context: TaskContext,
  queryEmbedding: number[] | null,
) {
  const text = `${normalized.title} ${normalized.description} ${normalized.purpose}`.toLowerCase();
  const lexicalHits = queryTerms.filter((term) => text.includes(term));
  const lexicalScore = queryTerms.length === 0 ? 0 : lexicalHits.length / queryTerms.length;
  const entityEmbedding = toNumberVector(normalized.entity.embedding);
  const vectorSimilarity =
    queryEmbedding && entityEmbedding
      ? Math.max(0, cosineSimilarity(queryEmbedding, entityEmbedding))
      : 0;
  const vectorScore = vectorSimilarity > 0.35 ? vectorSimilarity : 0;
  const applicability = scoreApplicability(normalized, context);
  const confidenceScore = Math.max(0, Math.min(1, normalized.confidence));
  const recencyDate = normalized.entity.lastReferencedAt ?? normalized.entity.createdAt;
  const recencyScore = recencyDate
    ? Math.max(0, 1 - (Date.now() - recencyDate.getTime()) / (14 * 86_400_000))
    : 0;
  const score =
    applicability.applicabilityScore * 0.4 +
    lexicalScore * 0.25 +
    vectorScore * 0.15 +
    confidenceScore * 0.15 +
    recencyScore * 0.05 +
    (applicability.severity === 'blocking'
      ? 0.08
      : applicability.severity === 'required'
        ? 0.05
        : 0);
  const matchSources: Array<
    'vector' | 'lexical' | 'graph' | 'applicability' | 'recency' | 'confidence'
  > = [];
  if (lexicalHits.length > 0) matchSources.push('lexical');
  if (vectorScore > 0) matchSources.push('vector');
  if (applicability.applicabilityScore > 0) matchSources.push('applicability');
  if (recencyScore > 0) matchSources.push('recency');
  matchSources.push('confidence');
  if (matchSources.length === 0) matchSources.push('lexical');
  return {
    score,
    lexicalHits,
    matchSources,
    recencyDate,
    vectorScore,
    applicabilityScore: applicability.applicabilityScore,
    applicabilityReasons: applicability.applicabilityReasons,
    applicabilitySeverity: applicability.severity,
  };
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function extractJsonObject(value: string): unknown {
  const match = value.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in LLM output.');
  return JSON.parse(match[0].replace(/,\s*([\}\]])/g, '$1'));
}

function normalizeAgenticLlmDecisions(
  raw: unknown,
  candidates: AgenticSearchCandidate[],
): Map<string, AgenticLlmDecision> {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const value = asRecord(raw);
  const rawDecisions = Array.isArray(value.decisions) ? value.decisions : [];
  const decisions = new Map<string, AgenticLlmDecision>();

  for (const item of rawDecisions) {
    const row = asRecord(item);
    const id = typeof row.id === 'string' ? row.id : '';
    if (!candidateIds.has(id)) continue;
    const decision =
      row.decision === 'use' || row.decision === 'skip' || row.decision === 'maybe'
        ? row.decision
        : 'maybe';
    const confidenceRaw = typeof row.confidence === 'number' ? row.confidence : 0.5;
    decisions.set(id, {
      id,
      decision,
      confidence: Math.max(0, Math.min(1, confidenceRaw)),
      reason:
        typeof row.reason === 'string' && row.reason.trim().length > 0
          ? truncateText(row.reason, 240)
          : 'LLM relevance decision.',
      summary:
        typeof row.summary === 'string' && row.summary.trim().length > 0
          ? truncateText(row.summary, 400)
          : undefined,
    });
  }

  return decisions;
}

async function classifyAgenticCandidatesWithLocalLlm(
  taskSummary: string,
  candidates: AgenticSearchCandidate[],
  timeoutMs: number,
): Promise<Map<string, AgenticLlmDecision>> {
  const candidatePayload = candidates.map((candidate) => ({
    id: candidate.id,
    source: candidate.source,
    kind: candidate.kind,
    category: candidate.category,
    title: candidate.title,
    reason: candidate.reason,
    summary: truncateText(candidate.summary, 700),
  }));
  const prompt = `
You are filtering project memory for a coding agent.

Task:
${taskSummary}

Candidates:
${JSON.stringify(candidatePayload, null, 2)}

Return strict JSON only:
{
  "decisions": [
    {
      "id": "candidate id",
      "decision": "use|skip|maybe",
      "confidence": 0.0,
      "reason": "short reason",
      "summary": "only the task-relevant part, omit unrelated details"
    }
  ]
}

Rules:
- Mark "use" only when the candidate directly changes how the agent should plan, edit, test, or review this task.
- Mark "skip" for generic, stale, unrelated, or merely lexical matches.
- Use "maybe" when useful only as weak background context.
- Keep summaries short and specific.
`.trim();

  const routed = await runPromptWithMemoryLoopRouter({
    prompt,
    taskKind: 'classification',
    riskLevel: 'low',
    preferredLocalAlias: 'gemma4',
    fallbackLocalAlias: 'bonsai',
    allowCloudFallback: false,
    llmTimeoutMs: timeoutMs,
    maxTokens: 1200,
  });
  return normalizeAgenticLlmDecisions(extractJsonObject(routed.output), candidates);
}

export async function resolveStaleMetadataSignal(
  clientSnapshot?: ToolSnapshot[],
): Promise<StaleMetadataSignal> {
  if (!clientSnapshot || clientSnapshot.length === 0) {
    return {
      status: 'unknown',
      reasons: ['client_snapshot_unavailable'],
      evidence: [
        {
          tool: 'client_snapshot',
          detail: 'No client-side tool snapshot was provided for stale metadata inspection.',
        },
      ],
    };
  }

  const reasons = new Set<StaleMetadataSignal['reasons'][number]>();
  const evidence: StaleMetadataSignal['evidence'] = [];
  const serverSnapshot = ((globalThis as Record<string, unknown>).__GNOSIS_TOOL_SNAPSHOT ??
    []) as NormalizedToolSnapshot[];
  const observedNames = new Set(clientSnapshot.map((tool) => tool.name));
  const missingPrimary = REQUIRED_PRIMARY_TOOLS.filter((toolName) => !observedNames.has(toolName));
  for (const missing of missingPrimary) {
    reasons.add('missing_required_primary_tool');
    evidence.push({
      tool: missing,
      detail: 'Required primary tool is missing in client snapshot.',
    });
  }

  const serverByName = new Map(serverSnapshot.map((tool) => [tool.name, tool]));
  for (const tool of clientSnapshot) {
    const serverTool = serverByName.get(tool.name);
    if (serverTool) {
      if (tool.schemaHash && tool.schemaHash !== serverTool.schemaHash) {
        reasons.add('tool_schema_version_mismatch');
        evidence.push({
          tool: tool.name,
          expectedVersion: serverTool.schemaHash,
          observedVersion: tool.schemaHash,
          detail: 'Tool input schema hash mismatched with current server snapshot.',
        });
      }
      if (tool.descriptionHash && tool.descriptionHash !== serverTool.descriptionHash) {
        reasons.add('tool_description_version_mismatch');
        evidence.push({
          tool: tool.name,
          expectedVersion: serverTool.descriptionHash,
          observedVersion: tool.descriptionHash,
          detail: 'Tool description hash mismatched with current server snapshot.',
        });
      }
    }
    if (tool.schemaVersion && tool.schemaVersion !== '1') {
      reasons.add('tool_schema_version_mismatch');
      evidence.push({
        tool: tool.name,
        expectedVersion: '1',
        observedVersion: tool.schemaVersion,
        detail: 'Tool schema version is not the expected baseline value.',
      });
    }
    if (tool.descriptionVersion && tool.descriptionVersion !== '1') {
      reasons.add('tool_description_version_mismatch');
      evidence.push({
        tool: tool.name,
        expectedVersion: '1',
        observedVersion: tool.descriptionVersion,
        detail: 'Tool description version is not the expected baseline value.',
      });
    }
  }

  return {
    status: reasons.size > 0 ? 'suspected_stale' : 'ok',
    reasons: [...reasons],
    evidence,
  };
}

export async function buildDoctorRuntimeHealth(
  exposedToolNames: string[],
): Promise<DoctorRuntimeHealth> {
  const presentPrimaryTools = REQUIRED_PRIMARY_TOOLS.filter((name) =>
    exposedToolNames.includes(name),
  );
  const missingPrimaryTools = REQUIRED_PRIMARY_TOOLS.filter(
    (name) => !exposedToolNames.includes(name),
  );
  const toolVisibility: DoctorRuntimeHealth['toolVisibility'] = {
    status: missingPrimaryTools.length === 0 ? 'ok' : 'missing_required_primary_tool',
    exposedToolCount: exposedToolNames.length,
    requiredPrimaryTools: [...REQUIRED_PRIMARY_TOOLS],
    presentPrimaryTools,
    missingPrimaryTools,
  };

  let dbHealth: DoctorRuntimeHealth['db'] = { status: 'ok' };
  let knowledgeIndex: DoctorRuntimeHealth['knowledgeIndex'] = {
    status: 'unknown',
    staleAfterHours: 72,
  };
  try {
    const snapshot = await db
      .select({
        total: sql<number>`count(*)`,
        lastUpdatedAt: sql<string | null>`max(${entities.freshness})`,
      })
      .from(entities);
    const row = snapshot[0];
    const total = Number(row?.total ?? 0);
    const lastUpdatedAtRaw = row?.lastUpdatedAt;
    const lastUpdatedAt =
      typeof lastUpdatedAtRaw === 'string' && lastUpdatedAtRaw.length > 0
        ? lastUpdatedAtRaw
        : undefined;
    if (total === 0) {
      knowledgeIndex = {
        status: 'empty',
        totalEntities: 0,
        staleAfterHours: 72,
      };
    } else if (!lastUpdatedAt) {
      knowledgeIndex = {
        status: 'unknown',
        totalEntities: total,
        staleAfterHours: 72,
        detail: 'Could not determine last freshness timestamp.',
      };
    } else {
      const ageHours = Math.max(
        0,
        (Date.now() - new Date(lastUpdatedAt).getTime()) / (60 * 60 * 1000),
      );
      knowledgeIndex = {
        status: ageHours > 72 ? 'stale' : 'fresh',
        totalEntities: total,
        lastUpdatedAt: new Date(lastUpdatedAt).toISOString(),
        ageHours: Number(ageHours.toFixed(2)),
        staleAfterHours: 72,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dbHealth = { status: 'unavailable', detail: message };
    knowledgeIndex = {
      status: 'unknown',
      staleAfterHours: 72,
      detail: `Knowledge index freshness check failed: ${message}`,
    };
  }

  return {
    toolVisibility,
    db: dbHealth,
    knowledgeIndex,
  };
}

export async function buildActivateProjectResult(projectRoot: string, mode?: string) {
  const warnings: string[] = [];
  let dbStatus: 'ok' | 'degraded' | 'unavailable' = 'ok';
  let rows: EntityRow[] = [];
  try {
    await db.execute(sql`select 1`);
    rows = await db.select().from(entities).orderBy(desc(entities.referenceCount)).limit(300);
  } catch (error) {
    dbStatus = 'unavailable';
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Database unavailable: ${message}`);
  }

  const normalizedRows = rows
    .map(normalizeEntity)
    .filter(
      (item) =>
        item.status !== 'deprecated' &&
        item.status !== 'rejected' &&
        item.entity.type !== 'task_trace',
    );
  const contextualRows = normalizedRows.filter((item) => item.scope !== 'always');
  const byKind: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const item of normalizedRows) {
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
  }

  const kindsForOnboarding: KnowledgeKind[] = ['rule', 'procedure', 'decision', 'lesson', 'risk'];
  const categoriesForOnboarding: KnowledgeCategory[] = [
    'architecture',
    'workflow',
    'testing',
    'security',
  ];
  const missingKinds = kindsForOnboarding.filter((kind) => !byKind[kind]);
  const missingCategories = categoriesForOnboarding.filter((category) => !byCategory[category]);
  const onboardingStatus: 'complete' | 'missing' | 'partial' =
    normalizedRows.length === 0
      ? 'missing'
      : missingKinds.length === 0 && missingCategories.length === 0
        ? 'complete'
        : 'partial';

  const projectKeywords = contextualRows
    .slice(0, 12)
    .flatMap((item) => [item.title, ...item.tags])
    .map((value) => value.toLowerCase())
    .filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index)
    .slice(0, 8);

  const representativeEntities = contextualRows.slice(0, 5).map((item) => ({
    entityId: item.entity.id,
    title: item.title,
    kind: item.kind,
    category: item.category,
    reason: `Top entity by reference count (${item.entity.referenceCount}).`,
  }));

  const topItems = contextualRows.slice(0, 5).map((item) => ({
    entityId: item.entity.id,
    slug: item.slug,
    title: item.title,
    kind: item.kind,
    category: item.category,
    purpose: item.purpose,
    reason: `Frequently referenced ${item.kind} in ${item.category}.`,
    updatedAt: (item.entity.lastReferencedAt ?? item.entity.createdAt).toISOString(),
  }));

  const recommendedNextCalls = [];
  if (mode === 'review') {
    recommendedNextCalls.push(
      { tool: 'search_knowledge', reason: 'Collect architecture/risk knowledge before review.' },
      { tool: 'review_task', reason: 'Run knowledge-aware review with local or cloud provider.' },
    );
  } else {
    recommendedNextCalls.push(
      { tool: 'search_knowledge', reason: 'Retrieve relevant rules, lessons, and procedures.' },
      { tool: 'agentic_search', reason: 'Filter retrieved knowledge for the current task.' },
    );
  }
  if (onboardingStatus !== 'complete') {
    recommendedNextCalls.push({
      tool: 'record_task_note',
      reason: 'Capture missing onboarding knowledge categories incrementally.',
    });
  }

  return {
    project: {
      name: path.basename(projectRoot),
      root: projectRoot,
      languages: inferLanguage(projectRoot),
    },
    health: {
      db: dbStatus,
      toolVersion: process.env.GNOSIS_TOOL_VERSION ?? process.env.npm_package_version ?? '0.2.0',
      warnings,
      automation: envBoolean(
        process.env.GNOSIS_ENABLE_AUTOMATION,
        GNOSIS_CONSTANTS.AUTOMATION_ENABLED_DEFAULT,
      )
        ? ('enabled' as const)
        : ('disabled' as const),
    },
    onboarding: {
      status: onboardingStatus,
      missingKinds,
      missingCategories,
      guidance:
        onboardingStatus === 'complete'
          ? undefined
          : 'Use record_task_note to add rule/procedure/decision/lesson/risk notes as you work.',
    },
    knowledgeIndex: {
      totalActive: normalizedRows.length,
      byKind,
      byCategory,
      projectKeywords,
      projectCharacteristics: Object.entries(byCategory)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([label, count]) => ({
          label,
          reason: `Category has ${count} active entities.`,
          confidence: Math.min(1, 0.4 + count / Math.max(1, normalizedRows.length)),
        })),
      representativeEntities,
      topItems,
    },
    recommendedNextCalls,
    instructions:
      'Use agentic_search for task-aware knowledge retrieval. Use search_knowledge only for raw candidate inspection.',
  };
}

export async function searchKnowledgeV2(input: SearchKnowledgeV2Input) {
  const query = buildQueryByPreset(input);
  const taskContext = buildTaskContext(input, query);
  if (!hasConcreteTaskContext(input)) {
    return {
      groups: [],
      flatTopHits: [],
      taskContext: {
        intent: taskContext.intent,
        changeTypes: taskContext.changeTypes,
        technologies: taskContext.technologies,
        files: taskContext.files,
      },
      suggestedNextAction: 'refine_query' as const,
      degraded: {
        reason: 'insufficient_task_context' satisfies SearchKnowledgeRefineReason,
        detail:
          'Provide a concrete taskGoal or query plus at least one of files, changeTypes, or technologies before retrieving project knowledge.',
      },
    };
  }
  const queryTerms = splitTerms(query);
  let queryEmbedding: number[] | null = null;
  if (query.length > 0) {
    try {
      queryEmbedding = await generateEmbedding(query);
    } catch {
      queryEmbedding = null;
    }
  }
  let rows: EntityRow[] = [];
  try {
    rows = await db.select().from(entities).orderBy(desc(entities.referenceCount)).limit(400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      groups: [],
      flatTopHits: [],
      suggestedNextAction: 'refine_query' as const,
      degraded: {
        reason: 'db_unavailable' satisfies SearchKnowledgeRefineReason,
        detail: message,
      },
    };
  }
  const normalizedRows = rows
    .map(normalizeEntity)
    .filter(
      (item) =>
        item.status !== 'deprecated' &&
        item.status !== 'rejected' &&
        item.scope !== 'always' &&
        item.entity.type !== 'task_trace',
    );
  const topLevelMode = input.filterMode ?? 'or';
  const explicitKinds = input.kinds ?? [];
  const explicitCategories = input.categories ?? [];

  const scored = normalizedRows
    .map((item) => {
      const hardFilterChecks: boolean[] = [];
      if (explicitKinds.length > 0) hardFilterChecks.push(explicitKinds.includes(item.kind));
      if (explicitCategories.length > 0) {
        hardFilterChecks.push(explicitCategories.includes(item.category));
      }
      const passHardFilters = hardFilterChecks.every(Boolean);
      const filterChecks: boolean[] = [];
      if (input.filters?.kinds?.values?.length) {
        filterChecks.push(
          includesByMode(
            [item.kind],
            input.filters.kinds.values,
            input.filters.kinds.mode ?? topLevelMode,
          ),
        );
      }
      if (input.filters?.categories?.values?.length) {
        filterChecks.push(
          includesByMode(
            [item.category],
            input.filters.categories.values,
            input.filters.categories.mode ?? topLevelMode,
          ),
        );
      }
      if (input.filters?.tags?.values?.length) {
        filterChecks.push(
          includesByMode(
            item.tags,
            input.filters.tags.values,
            input.filters.tags.mode ?? topLevelMode,
          ),
        );
      }
      if (input.filters?.files?.values?.length) {
        filterChecks.push(
          includesByMode(
            item.files,
            input.filters.files.values,
            input.filters.files.mode ?? topLevelMode,
          ),
        );
      }
      const passFilters = matchWithMode(filterChecks, topLevelMode);
      const scoring = scoreEntity(item, queryTerms, taskContext, queryEmbedding);
      return { item, passFilters: passHardFilters && passFilters, ...scoring };
    })
    .filter((row) => row.passFilters)
    .filter((row) => (queryTerms.length === 0 && !queryEmbedding ? true : row.score > 0))
    .sort((a, b) => b.score - a.score);

  const limitPerCategory = Math.max(
    1,
    input.limitPerCategory ?? (input.preset === 'task_context' ? 2 : 3),
  );
  const maxCategories = Math.max(
    1,
    input.maxCategories ?? (input.preset === 'task_context' ? 3 : 5),
  );
  const grouped: Record<string, typeof scored> = {};
  for (const row of scored) {
    const key = row.item.category;
    grouped[key] ??= [];
    if (grouped[key].length < limitPerCategory) {
      grouped[key].push(row);
    }
  }

  const topGroups = Object.entries(grouped)
    .sort((a, b) => b[1][0].score - a[1][0].score)
    .slice(0, maxCategories);

  const topHitIds = new Set(topGroups.flatMap(([, hits]) => hits.map((hit) => hit.item.entity.id)));
  const relationRows = (await db.select().from(relations).limit(300)) as RelationRow[];
  const relationTypeFilter = input.traversal?.relationTypes;
  const allowGraph = input.traversal?.enabled ?? true;

  const groups = topGroups.map(([category, hits]) => ({
    category,
    categoryReason: `Top matches in ${category} for current query.`,
    suggestedUse: `Apply ${category} knowledge before implementation decisions.`,
    hits: hits.map((hit) => {
      const snippetSource = hit.item.description || hit.item.purpose;
      const snippet =
        input.includeContent === 'full'
          ? snippetSource
          : snippetSource.length > 300
            ? `${snippetSource.slice(0, 297)}...`
            : snippetSource;
      const graphContext =
        allowGraph && topHitIds.has(hit.item.entity.id)
          ? relationRows
              .filter(
                (rel) => rel.sourceId === hit.item.entity.id || rel.targetId === hit.item.entity.id,
              )
              .filter((rel) =>
                relationTypeFilter && relationTypeFilter.length > 0
                  ? relationTypeFilter.includes(rel.relationType)
                  : true,
              )
              .slice(0, 3)
              .map((rel) => {
                const neighborId =
                  rel.sourceId === hit.item.entity.id ? rel.targetId : rel.sourceId;
                const neighbor = normalizedRows.find((row) => row.entity.id === neighborId);
                return {
                  entityId: neighborId,
                  relationType: rel.relationType,
                  title: neighbor?.title ?? neighborId,
                  kind: neighbor?.kind ?? DEFAULT_KNOWLEDGE_KIND,
                };
              })
          : [];

      return {
        entityId: hit.item.entity.id,
        slug: hit.item.slug,
        title: hit.item.title.slice(0, 80),
        kind: hit.item.kind,
        category: hit.item.category,
        purpose: hit.item.purpose,
        score: Number(hit.score.toFixed(4)),
        confidence: hit.item.confidence,
        reason:
          hit.lexicalHits.length > 0
            ? `Matched terms: ${hit.lexicalHits.join(', ')}`
            : 'Ranked by confidence and recency.',
        snippet,
        applicabilityMatch:
          hit.applicabilityReasons.length > 0 ? hit.applicabilityReasons.join('; ') : undefined,
        applicabilityScore: Number(hit.applicabilityScore.toFixed(4)),
        applicabilitySeverity: hit.applicabilitySeverity,
        evidenceSummary:
          typeof hit.item.metadata.evidenceSummary === 'string'
            ? hit.item.metadata.evidenceSummary
            : undefined,
        matchSources: hit.matchSources,
        graphContext,
        updatedAt: (hit.recencyDate ?? hit.item.entity.createdAt).toISOString(),
      };
    }),
  }));

  return {
    groups: input.grouping === 'flat' ? [] : groups,
    flatTopHits: scored.slice(0, 8).map((row) => ({
      entityId: row.item.entity.id,
      title: row.item.title,
      kind: row.item.kind,
      category: row.item.category,
      score: Number(row.score.toFixed(4)),
      applicabilityScore: Number(row.applicabilityScore.toFixed(4)),
    })),
    taskContext: {
      intent: taskContext.intent,
      changeTypes: taskContext.changeTypes,
      technologies: taskContext.technologies,
      files: taskContext.files,
    },
    suggestedNextAction: scored.length === 0 ? 'refine_query' : 'read_hit',
  };
}

export async function agenticSearch(input: AgenticSearchInput) {
  const taskSummary = truncateText(input.userRequest, 800);
  const maxCandidates = Math.max(1, Math.min(30, input.maxCandidates ?? 16));
  const maxReturned = Math.max(1, Math.min(10, input.maxReturned ?? 6));
  const entitySearch = await searchKnowledgeV2({
    preset: 'task_context',
    taskGoal: input.userRequest,
    intent: input.intent,
    files: input.files,
    changeTypes: input.changeTypes,
    technologies: input.technologies,
    maxCategories: 6,
    limitPerCategory: Math.max(2, Math.ceil(maxCandidates / 4)),
    includeContent: 'snippet',
  });

  const entityCandidates: AgenticSearchCandidate[] = (entitySearch.groups ?? [])
    .flatMap((group) => group.hits)
    .slice(0, maxCandidates)
    .map((hit) => ({
      id: hit.entityId,
      source: 'entity' as const,
      kind: hit.kind,
      category: hit.category,
      title: hit.title,
      summary: hit.snippet,
      reason: hit.applicabilityMatch ? `${hit.reason}; ${hit.applicabilityMatch}` : hit.reason,
      score: hit.score,
    }));

  const shouldSearchRawMemory = input.includeRawMemory === true || entityCandidates.length === 0;
  const rawMemoryCandidates: AgenticSearchCandidate[] = [];
  const degradedReasons: string[] = [];
  if (shouldSearchRawMemory) {
    try {
      const rawMemories = await searchMemoriesByType(
        input.userRequest,
        'raw',
        Math.max(1, maxCandidates - entityCandidates.length),
      );
      rawMemoryCandidates.push(
        ...rawMemories.map((memory) => ({
          id: String(memory.id),
          source: 'vibe_memory' as const,
          kind:
            typeof asRecord(memory.metadata).kind === 'string'
              ? String(asRecord(memory.metadata).kind)
              : 'raw',
          category:
            typeof asRecord(memory.metadata).category === 'string'
              ? String(asRecord(memory.metadata).category)
              : 'memory',
          title:
            typeof asRecord(memory.metadata).title === 'string'
              ? String(asRecord(memory.metadata).title)
              : `Vibe memory ${String(memory.id).slice(0, 8)}`,
          summary: truncateText(memory.content, 700),
          reason: `Raw memory semantic match similarity=${Number(memory.similarity ?? 0).toFixed(
            4,
          )}`,
          score: Number(memory.similarity ?? 0),
        })),
      );
    } catch (error) {
      degradedReasons.push(
        `raw memory search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const candidates = [...entityCandidates, ...rawMemoryCandidates].slice(0, maxCandidates);
  const failureFirewall = await buildFailureFirewallHint(input);
  let localLlmUsed = false;
  let decisions = new Map<string, AgenticLlmDecision>();
  const localLlmEnabled = input.localLlm?.enabled ?? candidates.length > 0;
  if (localLlmEnabled && candidates.length > 0) {
    try {
      decisions = await classifyAgenticCandidatesWithLocalLlm(
        taskSummary,
        candidates,
        input.localLlm?.timeoutMs ?? 30_000,
      );
      localLlmUsed = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      degradedReasons.push(`local LLM filter failed: ${message}`);
      return {
        taskSummary,
        decision: 'degraded' as const,
        confidence: 0,
        usedKnowledge: [],
        ...(failureFirewall ? { failureFirewall } : {}),
        skippedCount: candidates.length,
        maybeCount: 0,
        gaps: ['Gemma4 relevance filtering failed; unfiltered candidates were not injected.'],
        diagnostics: {
          entityCandidates: entityCandidates.length,
          rawMemoryCandidates: rawMemoryCandidates.length,
          localLlmUsed,
          degradedReasons,
        },
        nextAction: 'retry_later' as const,
      };
    }
  }

  const scoredCandidates = candidates.map((candidate, index) => {
    const decision = decisions.get(candidate.id);
    const fallbackConfidence = Math.max(0.2, Math.min(0.85, Number(candidate.score ?? 0.5)));
    const fallbackDecision: AgenticLlmDecision = {
      id: candidate.id,
      decision: index < maxReturned ? 'use' : 'maybe',
      confidence: fallbackConfidence,
      reason: candidate.reason,
      summary: candidate.summary,
    };
    return {
      candidate,
      decision: decision ?? fallbackDecision,
    };
  });

  const used = scoredCandidates
    .filter(
      (row) =>
        row.decision.decision === 'use' ||
        (row.decision.decision === 'maybe' && row.decision.confidence >= 0.72),
    )
    .sort((a, b) => b.decision.confidence - a.decision.confidence)
    .slice(0, maxReturned);
  const skippedCount = scoredCandidates.filter((row) => row.decision.decision === 'skip').length;
  const maybeCount = scoredCandidates.filter((row) => row.decision.decision === 'maybe').length;

  const usedEntityIds = used
    .map((row) => row.candidate)
    .filter((candidate) => candidate.source === 'entity')
    .map((candidate) => candidate.id);
  if (usedEntityIds.length > 0) {
    await db
      .update(entities)
      .set({
        referenceCount: sql`${entities.referenceCount} + 1`,
        lastReferencedAt: new Date(),
      })
      .where(inArray(entities.id, usedEntityIds));
  }

  const decision =
    degradedReasons.length > 0 && candidates.length === 0
      ? ('degraded' as const)
      : used.length > 0
        ? ('use_knowledge' as const)
        : ('no_relevant_knowledge' as const);
  const confidence =
    used.length > 0
      ? Number(
          (
            used.reduce((sum, row) => sum + row.decision.confidence, 0) / Math.max(1, used.length)
          ).toFixed(3),
        )
      : 0;

  return {
    taskSummary,
    decision,
    confidence,
    usedKnowledge: used.map(({ candidate, decision: itemDecision }) => ({
      id: candidate.id,
      source: candidate.source,
      kind: candidate.kind,
      category: candidate.category,
      title: candidate.title,
      summary: itemDecision.summary ?? candidate.summary,
      reason: itemDecision.reason,
    })),
    ...(failureFirewall ? { failureFirewall } : {}),
    skippedCount,
    maybeCount,
    gaps: used.length === 0 ? ['No candidate was relevant enough for this task.'] : [],
    diagnostics: {
      entityCandidates: entityCandidates.length,
      rawMemoryCandidates: rawMemoryCandidates.length,
      localLlmUsed,
      degradedReasons,
    },
    nextAction:
      decision === 'use_knowledge'
        ? ('proceed_with_context' as const)
        : decision === 'no_relevant_knowledge'
          ? ('proceed_without_context' as const)
          : ('retry_later' as const),
  };
}

export type RecordTaskNoteInput = {
  taskId?: string;
  content: string;
  kind?: KnowledgeKind;
  category?: KnowledgeCategory;
  title?: string;
  purpose?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  evidence?: Array<{ type?: string; value?: string; uri?: string }>;
  files?: string[];
  confidence?: number;
  source?: 'manual' | 'task' | 'review' | 'onboarding' | 'import';
};

export async function startTaskTrace(input: {
  title: string;
  intent?: 'plan' | 'edit' | 'debug' | 'review' | 'finish';
  files?: string[];
  projectRoot?: string;
  taskId?: string;
}) {
  const taskId = input.taskId?.trim() || `task/${Date.now()}`;
  const now = new Date();
  const metadata = {
    kind: 'task_trace',
    intent: input.intent ?? 'edit',
    files: input.files ?? [],
    projectRoot: input.projectRoot ?? process.cwd(),
    status: 'active',
    startedAt: now.toISOString(),
  };
  await db
    .insert(entities)
    .values({
      id: taskId,
      type: 'task_trace',
      name: input.title.trim().length > 0 ? input.title.trim() : taskId,
      description: `Task started (${metadata.intent}).`,
      metadata,
      confidence: 0.8,
      provenance: 'task',
      scope: 'on_demand',
      freshness: now,
    })
    .onConflictDoUpdate({
      target: entities.id,
      set: {
        type: sql`excluded.type`,
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        metadata: sql`excluded.metadata`,
        confidence: sql`excluded.confidence`,
        provenance: sql`excluded.provenance`,
        freshness: sql`excluded.freshness`,
      },
    });

  return {
    taskId,
    status: 'started',
    activationWarning:
      'start_task is deprecated. Use agentic_search for task-aware knowledge retrieval.',
    recommendedNextCalls: [
      { tool: 'search_knowledge', reason: 'Collect rules/procedures before editing.' },
      { tool: 'record_task_note', reason: 'Capture reusable findings during work.' },
    ],
  };
}

export async function recordTaskNote(input: RecordTaskNoteInput) {
  const now = new Date();
  const kind = input.kind ?? DEFAULT_KNOWLEDGE_KIND;
  const category = input.category ?? fallbackCategoryByKind(kind);
  const tags = input.tags ?? [];
  const isFailureFirewallCandidate =
    tags.includes('failure-firewall') || tags.includes('golden-path');
  const title =
    input.title?.trim() && input.title.trim().length > 0
      ? input.title.trim()
      : input.content.trim().replace(/\s+/g, ' ').slice(0, 80) || `note-${now.getTime()}`;
  const entityId = generateEntityId(kind, `${title}-${now.getTime()}`);
  const extraMetadata = asRecord(input.metadata);
  const metadata = {
    ...extraMetadata,
    slug: toSlug(title),
    category,
    purpose: input.purpose ?? `Reusable ${kind} for ${category} work.`,
    tags,
    files: input.files ?? [],
    evidence: input.evidence ?? [],
    source: input.source ?? 'task',
    taskId: input.taskId,
    status: isFailureFirewallCandidate ? 'needs_review' : 'active',
    enrichmentState: 'pending',
    ...(isFailureFirewallCandidate
      ? {
          failureFirewallCandidate: {
            ...asRecord(extraMetadata.failureFirewallCandidate),
            status: 'needs_review',
            active: false,
          },
        }
      : {}),
    inferred: {
      title: !input.title,
      kind: !input.kind,
      category: !input.category,
      purpose: !input.purpose,
      tags: !input.tags || input.tags.length === 0,
    },
  };

  await db
    .insert(entities)
    .values({
      id: entityId,
      type: kind,
      name: title,
      description: input.content,
      metadata,
      confidence: input.confidence ?? 0.7,
      provenance: input.source ?? 'task',
      scope: 'on_demand',
      freshness: now,
    })
    .onConflictDoUpdate({
      target: entities.id,
      set: {
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        metadata: sql`excluded.metadata`,
        confidence: sql`excluded.confidence`,
        freshness: sql`excluded.freshness`,
      },
    });

  const relationLinked = await linkTaskTraceToKnowledge({
    taskId: input.taskId,
    entityId,
    kind,
  });

  return {
    saved: true,
    entityId,
    slug: metadata.slug,
    kind,
    category,
    enrichmentState: 'pending',
    ...(isFailureFirewallCandidate
      ? { failureFirewallCandidateState: 'needs_review' as const }
      : {}),
    relationLinked,
  };
}

export async function finishTaskTrace(input: {
  taskId: string;
  outcome: string;
  checks?: string[];
  followUps?: string[];
  learnedItems?: Array<Omit<RecordTaskNoteInput, 'taskId'>>;
}) {
  const [taskRow] = await db
    .select()
    .from(entities)
    .where(sql`${entities.id} = ${input.taskId}`)
    .limit(1);
  const taskMetadata = asRecord(taskRow?.metadata);
  const updatedMetadata = {
    ...taskMetadata,
    status: 'completed',
    outcome: input.outcome,
    checks: input.checks ?? [],
    followUps: input.followUps ?? [],
    finishedAt: new Date().toISOString(),
  };
  await db
    .insert(entities)
    .values({
      id: input.taskId,
      type: taskRow?.type ?? 'task_trace',
      name: taskRow?.name ?? input.taskId,
      description: input.outcome,
      metadata: updatedMetadata,
      confidence: taskRow?.confidence ?? 0.8,
      provenance: taskRow?.provenance ?? 'task',
      scope: taskRow?.scope ?? 'on_demand',
      freshness: new Date(),
    })
    .onConflictDoUpdate({
      target: entities.id,
      set: {
        description: sql`excluded.description`,
        metadata: sql`excluded.metadata`,
        freshness: sql`excluded.freshness`,
      },
    });

  const learnedEntities: Array<{ entityId: string; kind: string; category: string }> = [];
  for (const item of input.learnedItems ?? []) {
    const saved = await recordTaskNote({
      ...item,
      taskId: input.taskId,
      source: item.source ?? 'task',
    });
    learnedEntities.push({
      entityId: saved.entityId,
      kind: saved.kind,
      category: saved.category,
    });
  }

  const projectRoot =
    typeof taskMetadata.projectRoot === 'string' ? taskMetadata.projectRoot : process.cwd();
  const changedFiles = Array.isArray(taskMetadata.files)
    ? taskMetadata.files.filter((file): file is string => typeof file === 'string')
    : [];

  return {
    taskId: input.taskId,
    status: 'completed',
    learnedCount: learnedEntities.length,
    learnedEntities,
    suggestedNextAction:
      learnedEntities.length > 0
        ? 'search_knowledge to verify retrieval quality'
        : 'record_task_note',
  };
}
