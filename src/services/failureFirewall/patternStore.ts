import { inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  entities,
  experienceLogs,
  failureFirewallGoldenPaths,
  failureFirewallPatterns,
  reviewOutcomes,
} from '../../db/schema.js';
import { seedKnowledge } from './seedPatterns.js';
import type {
  FailureFirewallLessonCandidate,
  FailureKnowledgeSource,
  FailureKnowledgeSourceMode,
  FailurePattern,
  GoldenPath,
} from './types.js';

type Metadata = Record<string, unknown>;

export interface FailurePatternStoreDeps {
  database?: typeof db;
  knowledgeSource?: FailureKnowledgeSourceMode;
}

function asRecord(value: unknown): Metadata | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Metadata)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function asStatus(value: unknown): 'active' | 'needs_review' | 'deprecated' {
  return value === 'needs_review' || value === 'deprecated' ? value : 'active';
}

function asSeverity(value: unknown): 'error' | 'warning' | 'info' {
  return value === 'error' || value === 'info' ? value : 'warning';
}

function asSourceMode(value: string | undefined): FailureKnowledgeSourceMode {
  if (value === 'dedicated' || value === 'hybrid') return value;
  return 'entities';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function metadataObject(metadata: Metadata, key: string): Metadata | undefined {
  return asRecord(metadata[key]) ?? asRecord(metadata[`metadata.${key}`]);
}

function asEvidenceStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string' && item.trim().length > 0) return [item];
    const record = asRecord(item);
    if (!record) return [];
    const parts = [record.type, record.value, record.uri].filter(
      (part): part is string => typeof part === 'string' && part.trim().length > 0,
    );
    return parts.length > 0 ? [parts.join(': ')] : [];
  });
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map(normalizeToken).filter(Boolean))];
}

function overlapScore(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right.map(normalizeToken));
  const matches = left.map(normalizeToken).filter((item) => rightSet.has(item)).length;
  return matches / Math.max(left.length, 1);
}

function weakTextOverlapScore(leftText: string, rightTerms: string[]): number {
  const terms = uniqueStrings(
    rightTerms
      .flatMap((item) => item.split(/[^a-z0-9_\-/\u3040-\u30ff\u3400-\u9fff]+/iu))
      .filter((item) => item.length >= 2),
  );
  if (terms.length === 0) return 0;
  const text = leftText.toLowerCase();
  const matches = terms.filter((term) => text.includes(term)).length;
  return Math.min(1, matches / Math.min(terms.length, 5));
}

function entityKind(rowType: string, metadata: Metadata): string {
  return typeof metadata.kind === 'string' && metadata.kind.trim().length > 0
    ? metadata.kind
    : rowType;
}

function entityCategory(metadata: Metadata): string | undefined {
  return typeof metadata.category === 'string' && metadata.category.trim().length > 0
    ? metadata.category
    : undefined;
}

function lessonKindWeight(kind: string): number {
  if (kind === 'procedure' || kind === 'rule' || kind === 'skill') return 1;
  if (kind === 'lesson' || kind === 'risk') return 0.85;
  if (kind === 'decision' || kind === 'command_recipe') return 0.4;
  return 0;
}

const LESSON_ENTITY_TYPE_VALUES = [
  'lesson',
  'rule',
  'procedure',
  'risk',
  'skill',
  'command_recipe',
  'decision',
] as const;

const LESSON_ENTITY_TYPES = new Set<string>(LESSON_ENTITY_TYPE_VALUES);

function toLessonCandidate(
  row: {
    id: string;
    name: string;
    description: string | null;
    type: string;
    metadata: unknown;
    confidence?: number | null;
  },
  input: {
    riskSignals: string[];
    changedFiles: string[];
    languages: string[];
    technologies: string[];
    taskGoal?: string;
  },
): FailureFirewallLessonCandidate | undefined {
  const metadata = asRecord(row.metadata) ?? {};
  const firewallMetadata = metadataObject(metadata, 'failureFirewall');
  if (firewallMetadata?.status === 'deprecated') return undefined;

  const kind = entityKind(row.type, metadata);
  if (!LESSON_ENTITY_TYPES.has(row.type) && !LESSON_ENTITY_TYPES.has(kind)) return undefined;

  const title =
    typeof metadata.title === 'string' && metadata.title.trim().length > 0
      ? metadata.title
      : row.name;
  const category = entityCategory(metadata);
  const content =
    typeof metadata.content === 'string' && metadata.content.trim().length > 0
      ? metadata.content
      : row.description ?? '';
  const tags = uniqueStrings(asStringArray(metadata.tags));
  const files = asStringArray(metadata.files);
  const evidence = asEvidenceStrings(metadata.evidence);
  const riskSignals = uniqueStrings([
    ...asStringArray(metadata.riskSignals),
    ...asStringArray(firewallMetadata?.riskSignals),
    ...tags.filter((tag) => input.riskSignals.map(normalizeToken).includes(tag)),
  ]);

  const riskOverlap = overlapScore(input.riskSignals, [...riskSignals, ...tags]);
  const fileOverlap = overlapScore(
    input.changedFiles.flatMap((file) => [file, ...file.split('/')]),
    files.flatMap((file) => [file, ...file.split('/')]),
  );
  const kindScore = lessonKindWeight(kind);
  const firewallBonus = firewallMetadata ? 1 : 0;
  const textScore = weakTextOverlapScore([title, content, tags.join(' ')].join('\n'), [
    ...input.riskSignals,
    ...input.changedFiles,
    ...input.languages,
    ...input.technologies,
    input.taskGoal ?? '',
  ]);
  const confidence = asNumber(row.confidence) ?? 0.5;
  const score =
    0.45 * riskOverlap +
    0.25 * fileOverlap +
    0.15 * kindScore +
    0.1 * firewallBonus +
    0.05 * textScore +
    0.05 * Math.min(1, Math.max(0, confidence));

  if (score < 0.25) return undefined;

  const reasons = [
    riskOverlap > 0 ? `risk_signal_overlap=${riskOverlap.toFixed(2)}` : undefined,
    fileOverlap > 0 ? `file_overlap=${fileOverlap.toFixed(2)}` : undefined,
    kindScore > 0 ? `kind=${kind}` : undefined,
    firewallMetadata ? 'failureFirewall_metadata' : undefined,
    textScore > 0 ? `text_overlap=${textScore.toFixed(2)}` : undefined,
  ].filter((reason): reason is string => Boolean(reason));

  return {
    id: row.id,
    title,
    kind,
    ...(category ? { category } : {}),
    content: content.slice(0, 1200),
    tags,
    files,
    evidence,
    riskSignals,
    score: Number(Math.min(1, score).toFixed(3)),
    reason: reasons.join(', ') || 'entity lesson candidate',
    source: 'entity',
    blocking: false,
  };
}

function toGoldenPath(row: {
  id: string;
  name: string;
  description: string | null;
  type: string;
  metadata: unknown;
}): GoldenPath | undefined {
  const metadata = asRecord(row.metadata) ?? {};
  const source = metadataObject(metadata, 'goldenPath') ?? metadataObject(metadata, 'golden_path');
  if (!source && !asStringArray(metadata.tags).includes('golden-path')) return undefined;

  const merged = source ?? metadata;
  return {
    id: typeof merged.pathId === 'string' ? merged.pathId : row.id,
    title:
      typeof metadata.title === 'string'
        ? metadata.title
        : typeof merged.title === 'string'
          ? merged.title
          : row.name,
    pathType: typeof merged.pathType === 'string' ? merged.pathType : row.type,
    appliesWhen: asStringArray(merged.appliesWhen),
    requiredSteps: asStringArray(merged.requiredSteps),
    allowedAlternatives: asStringArray(merged.allowedAlternatives),
    blockWhenMissing: asStringArray(merged.blockWhenMissing),
    severityWhenMissing: asSeverity(merged.severityWhenMissing),
    riskSignals: asStringArray(merged.riskSignals),
    languages: asStringArray(merged.languages).map((item) => item.toLowerCase()),
    frameworks: asStringArray(merged.frameworks),
    tags: asStringArray(metadata.tags),
    status: asStatus(merged.status),
    source: 'entity',
  };
}

function toFailurePattern(row: {
  id: string;
  name: string;
  description: string | null;
  type: string;
  metadata: unknown;
}): FailurePattern | undefined {
  const metadata = asRecord(row.metadata) ?? {};
  const source =
    metadataObject(metadata, 'failureFirewall') ?? metadataObject(metadata, 'failure_firewall');
  if (!source && !asStringArray(metadata.tags).includes('failure-firewall')) return undefined;

  const merged = source ?? metadata;
  return {
    id: typeof merged.patternId === 'string' ? merged.patternId : row.id,
    title:
      typeof metadata.title === 'string'
        ? metadata.title
        : typeof merged.title === 'string'
          ? merged.title
          : row.name,
    patternType: typeof merged.patternType === 'string' ? merged.patternType : row.type,
    severity: asSeverity(merged.severity),
    riskSignals: asStringArray(merged.riskSignals),
    languages: asStringArray(merged.languages).map((item) => item.toLowerCase()),
    frameworks: asStringArray(merged.frameworks),
    matchHints: asStringArray(merged.matchHints),
    requiredEvidence: asStringArray(merged.requiredEvidence),
    goldenPathId: typeof merged.goldenPathId === 'string' ? merged.goldenPathId : undefined,
    status: asStatus(merged.status),
    falsePositiveCount:
      typeof merged.falsePositiveCount === 'number' ? merged.falsePositiveCount : 0,
    source: 'entity',
  };
}

function toDedicatedGoldenPath(row: {
  id: string;
  title: string;
  pathType: string;
  appliesWhen: unknown;
  requiredSteps: unknown;
  allowedAlternatives: unknown;
  blockWhenMissing: unknown;
  severityWhenMissing: string;
  riskSignals: unknown;
  languages: unknown;
  frameworks: unknown;
  tags: unknown;
  status: string;
}): GoldenPath {
  return {
    id: row.id,
    title: row.title,
    pathType: row.pathType,
    appliesWhen: asStringArray(row.appliesWhen),
    requiredSteps: asStringArray(row.requiredSteps),
    allowedAlternatives: asStringArray(row.allowedAlternatives),
    blockWhenMissing: asStringArray(row.blockWhenMissing),
    severityWhenMissing: asSeverity(row.severityWhenMissing),
    riskSignals: asStringArray(row.riskSignals),
    languages: asStringArray(row.languages).map((item) => item.toLowerCase()),
    frameworks: asStringArray(row.frameworks),
    tags: asStringArray(row.tags),
    status: asStatus(row.status),
    source: 'dedicated',
  };
}

function toDedicatedFailurePattern(row: {
  id: string;
  title: string;
  patternType: string;
  severity: string;
  riskSignals: unknown;
  languages: unknown;
  frameworks: unknown;
  matchHints: unknown;
  requiredEvidence: unknown;
  goldenPathId: string | null;
  status: string;
  falsePositiveCount: number;
}): FailurePattern {
  return {
    id: row.id,
    title: row.title,
    patternType: row.patternType,
    severity: asSeverity(row.severity),
    riskSignals: asStringArray(row.riskSignals),
    languages: asStringArray(row.languages).map((item) => item.toLowerCase()),
    frameworks: asStringArray(row.frameworks),
    matchHints: asStringArray(row.matchHints),
    requiredEvidence: asStringArray(row.requiredEvidence),
    goldenPathId: row.goldenPathId ?? undefined,
    status: asStatus(row.status),
    falsePositiveCount: row.falsePositiveCount,
    source: 'dedicated',
  };
}

async function getFalsePositiveCounts(
  database: typeof db,
  ids: string[],
): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const rows = await database
    .select({ guidanceIds: reviewOutcomes.guidanceIds })
    .from(reviewOutcomes)
    .where(inArray(reviewOutcomes.outcomeType, ['dismissed', 'ignored']));

  const counts: Record<string, number> = {};
  for (const row of rows) {
    const guidanceIds = new Set(asStringArray(row.guidanceIds));
    for (const id of guidanceIds) {
      if (ids.includes(id)) counts[id] = (counts[id] ?? 0) + 1;
    }
  }
  return counts;
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    if (!map.has(item.id)) map.set(item.id, item);
  }
  return [...map.values()];
}

async function loadEntityExperienceKnowledge(database: typeof db): Promise<FailureKnowledgeSource> {
  const entityRows = await database
    .select({
      id: entities.id,
      name: entities.name,
      description: entities.description,
      type: entities.type,
      metadata: entities.metadata,
    })
    .from(entities);

  return {
    goldenPaths: entityRows
      .flatMap((row) => {
        const path = toGoldenPath(row);
        return path ? [path] : [];
      })
      .filter((path) => path.status !== 'deprecated'),
    failurePatterns: entityRows
      .flatMap((row) => {
        const pattern = toFailurePattern(row);
        return pattern ? [pattern] : [];
      })
      .filter((pattern) => pattern.status !== 'deprecated'),
  };
}

async function loadDedicatedKnowledge(database: typeof db): Promise<FailureKnowledgeSource> {
  const [goldenPathRows, patternRows] = await Promise.all([
    database
      .select({
        id: failureFirewallGoldenPaths.id,
        title: failureFirewallGoldenPaths.title,
        pathType: failureFirewallGoldenPaths.pathType,
        appliesWhen: failureFirewallGoldenPaths.appliesWhen,
        requiredSteps: failureFirewallGoldenPaths.requiredSteps,
        allowedAlternatives: failureFirewallGoldenPaths.allowedAlternatives,
        blockWhenMissing: failureFirewallGoldenPaths.blockWhenMissing,
        severityWhenMissing: failureFirewallGoldenPaths.severityWhenMissing,
        riskSignals: failureFirewallGoldenPaths.riskSignals,
        languages: failureFirewallGoldenPaths.languages,
        frameworks: failureFirewallGoldenPaths.frameworks,
        tags: failureFirewallGoldenPaths.tags,
        status: failureFirewallGoldenPaths.status,
      })
      .from(failureFirewallGoldenPaths),
    database
      .select({
        id: failureFirewallPatterns.id,
        title: failureFirewallPatterns.title,
        patternType: failureFirewallPatterns.patternType,
        severity: failureFirewallPatterns.severity,
        riskSignals: failureFirewallPatterns.riskSignals,
        languages: failureFirewallPatterns.languages,
        frameworks: failureFirewallPatterns.frameworks,
        matchHints: failureFirewallPatterns.matchHints,
        requiredEvidence: failureFirewallPatterns.requiredEvidence,
        goldenPathId: failureFirewallPatterns.goldenPathId,
        status: failureFirewallPatterns.status,
        falsePositiveCount: failureFirewallPatterns.falsePositiveCount,
      })
      .from(failureFirewallPatterns),
  ]);

  return {
    goldenPaths: goldenPathRows
      .map(toDedicatedGoldenPath)
      .filter((path) => path.status !== 'deprecated'),
    failurePatterns: patternRows
      .map(toDedicatedFailurePattern)
      .filter((pattern) => pattern.status !== 'deprecated'),
  };
}

export async function loadFailureLessonEvidence(
  deps: FailurePatternStoreDeps & {
    riskSignals: string[];
    changedFiles: string[];
    languages: string[];
    technologies?: string[];
    taskGoal?: string;
    limit?: number;
  },
): Promise<FailureFirewallLessonCandidate[]> {
  const database = deps.database ?? db;
  const rows = await database
    .select({
      id: entities.id,
      name: entities.name,
      description: entities.description,
      type: entities.type,
      metadata: entities.metadata,
      confidence: entities.confidence,
    })
    .from(entities)
    .where(inArray(entities.type, LESSON_ENTITY_TYPE_VALUES));

  const limit = Math.max(0, Math.min(10, deps.limit ?? 5));
  return rows
    .flatMap((row) => {
      const candidate = toLessonCandidate(row, {
        riskSignals: deps.riskSignals,
        changedFiles: deps.changedFiles,
        languages: deps.languages,
        technologies: deps.technologies ?? [],
        taskGoal: deps.taskGoal,
      });
      return candidate ? [candidate] : [];
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export async function loadFailureKnowledge(
  deps: FailurePatternStoreDeps = {},
): Promise<FailureKnowledgeSource> {
  const database = deps.database ?? db;
  const sourceMode =
    deps.knowledgeSource ??
    asSourceMode(process.env.GNOSIS_FAILURE_FIREWALL_KNOWLEDGE_SOURCE?.trim().toLowerCase());
  const goldenPaths: GoldenPath[] = [];
  const failurePatterns: FailurePattern[] = [];

  if (sourceMode === 'dedicated' || sourceMode === 'hybrid') {
    try {
      const dedicated = await loadDedicatedKnowledge(database);
      goldenPaths.push(...dedicated.goldenPaths);
      failurePatterns.push(...dedicated.failurePatterns);
    } catch {
      if (sourceMode === 'dedicated') {
        return seedKnowledge;
      }
    }
  }

  if (sourceMode !== 'dedicated') {
    goldenPaths.push(...seedKnowledge.goldenPaths);
    failurePatterns.push(...seedKnowledge.failurePatterns);
  }

  if (sourceMode === 'entities' || sourceMode === 'hybrid') {
    try {
      const entityExperience = await loadEntityExperienceKnowledge(database);
      goldenPaths.push(...entityExperience.goldenPaths);
      failurePatterns.push(...entityExperience.failurePatterns);
    } catch {
      if (sourceMode === 'entities') {
        return seedKnowledge;
      }
    }
  }

  let falsePositiveCounts: Record<string, number> = {};
  try {
    falsePositiveCounts = await getFalsePositiveCounts(
      database,
      failurePatterns.map((pattern) => pattern.id),
    );
  } catch {
    falsePositiveCounts = {};
  }

  return {
    goldenPaths: dedupeById(goldenPaths),
    failurePatterns: dedupeById(
      failurePatterns.map((pattern) => ({
        ...pattern,
        falsePositiveCount:
          pattern.source === 'dedicated'
            ? pattern.falsePositiveCount
            : pattern.falsePositiveCount + (falsePositiveCounts[pattern.id] ?? 0),
      })),
    ),
  };
}
