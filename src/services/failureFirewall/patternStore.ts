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

function metadataObject(metadata: Metadata, key: string): Metadata | undefined {
  return asRecord(metadata[key]) ?? asRecord(metadata[`metadata.${key}`]);
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

function toExperienceGoldenPath(row: {
  scenarioId: string;
  content: string;
  type: string;
  metadata: unknown;
}): GoldenPath | undefined {
  if (row.type !== 'success') return undefined;
  const metadata = asRecord(row.metadata) ?? {};
  const pathId = typeof metadata.pathId === 'string' ? metadata.pathId : row.scenarioId;
  const riskSignals = asStringArray(metadata.riskSignals);
  if (!pathId && riskSignals.length === 0) return undefined;

  return {
    id: pathId,
    title: typeof metadata.title === 'string' ? metadata.title : `Success path ${pathId}`,
    pathType: typeof metadata.pathType === 'string' ? metadata.pathType : 'experience_success',
    appliesWhen: asStringArray(metadata.appliesWhen),
    requiredSteps: asStringArray(metadata.reusableSteps),
    allowedAlternatives: asStringArray(metadata.allowedAlternatives),
    blockWhenMissing: asStringArray(metadata.blockWhenMissing),
    severityWhenMissing: 'warning',
    riskSignals,
    languages: asStringArray(metadata.languages).map((item) => item.toLowerCase()),
    frameworks: asStringArray(metadata.frameworks),
    tags: ['failure-firewall', 'golden-path', ...riskSignals],
    status: 'needs_review',
    source: 'experience',
  };
}

function toExperienceFailurePattern(row: {
  scenarioId: string;
  content: string;
  type: string;
  failureType: string | null;
  metadata: unknown;
}): FailurePattern | undefined {
  if (row.type !== 'failure') return undefined;
  const metadata = asRecord(row.metadata) ?? {};
  const riskSignals = asStringArray(metadata.riskSignals);
  return {
    id: typeof metadata.patternId === 'string' ? metadata.patternId : row.scenarioId,
    title: typeof metadata.title === 'string' ? metadata.title : row.content.slice(0, 80),
    patternType: row.failureType ?? 'experience_failure',
    severity: asSeverity(metadata.severity),
    riskSignals,
    languages: asStringArray(metadata.languages).map((item) => item.toLowerCase()),
    frameworks: asStringArray(metadata.frameworks),
    matchHints: asStringArray(metadata.matchHints),
    requiredEvidence: asStringArray(metadata.requiredEvidence),
    goldenPathId: typeof metadata.goldenPathId === 'string' ? metadata.goldenPathId : undefined,
    status: 'needs_review',
    falsePositiveCount: 0,
    source: 'experience',
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
  const [entityRows, experienceRows] = await Promise.all([
    database
      .select({
        id: entities.id,
        name: entities.name,
        description: entities.description,
        type: entities.type,
        metadata: entities.metadata,
      })
      .from(entities),
    database
      .select({
        scenarioId: experienceLogs.scenarioId,
        type: experienceLogs.type,
        failureType: experienceLogs.failureType,
        content: experienceLogs.content,
        metadata: experienceLogs.metadata,
      })
      .from(experienceLogs),
  ]);

  return {
    goldenPaths: [
      ...entityRows.flatMap((row) => {
        const path = toGoldenPath(row);
        return path ? [path] : [];
      }),
      ...experienceRows.flatMap((row) => {
        const path = toExperienceGoldenPath(row);
        return path ? [path] : [];
      }),
    ].filter((path) => path.status !== 'deprecated'),
    failurePatterns: [
      ...entityRows.flatMap((row) => {
        const pattern = toFailurePattern(row);
        return pattern ? [pattern] : [];
      }),
      ...experienceRows.flatMap((row) => {
        const pattern = toExperienceFailurePattern(row);
        return pattern ? [pattern] : [];
      }),
    ].filter((pattern) => pattern.status !== 'deprecated'),
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
