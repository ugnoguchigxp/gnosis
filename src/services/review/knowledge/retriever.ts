import { eq } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { reviewOutcomes } from '../../../db/schema.js';
import { getOnDemandGuidance } from '../../guidance/search.js';
import type { getAlwaysOnGuidance } from '../../guidance/search.js';
import { searchMemory } from '../../memory.js';
import type { GuidanceItem } from '../types.js';

export type GuidanceRow = {
  content: string;
  metadata: Record<string, unknown>;
  similarity?: number;
};

export interface GuidanceRetrievalDependencies {
  getAlwaysOnGuidance?: typeof getAlwaysOnGuidance;
  getOnDemandGuidance?: typeof getOnDemandGuidance;
  searchMemory?: typeof searchMemory;
  database?: typeof db;
}

export interface GuidanceRetrievalResult {
  principles: GuidanceItem[];
  heuristics: GuidanceItem[];
  patterns: GuidanceItem[];
  skills: GuidanceItem[];
  benchmarks: string[];
}

interface RetrievalScore {
  semanticSimilarity: number;
  signalMatch: number;
  tagMatch: number;
  falsePositivePenalty: number;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function getMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getMetadataNumber(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toGuidanceItem(row: GuidanceRow): GuidanceItem {
  const metadata = row.metadata ?? {};
  const tags = normalizeStringArray(metadata.tags);
  const guidanceType = getMetadataString(metadata, 'guidanceType');
  const scope = getMetadataString(metadata, 'scope') === 'always' ? 'always' : 'on_demand';
  const title =
    getMetadataString(metadata, 'title') ?? row.content.split('\n', 1)[0]?.trim() ?? 'Guidance';
  const priority = getMetadataNumber(metadata, 'priority') ?? 0;
  const applicability = metadata.applicability;

  return {
    id: getMetadataString(metadata, 'archiveKey') ?? title,
    title,
    content: row.content,
    guidanceType: guidanceType === 'skill' ? 'skill' : 'rule',
    scope,
    priority,
    tags,
    applicability:
      applicability && typeof applicability === 'object' && !Array.isArray(applicability)
        ? (applicability as GuidanceItem['applicability'])
        : undefined,
  };
}

function classifyGuidance(
  item: GuidanceItem,
): 'principle' | 'heuristic' | 'pattern' | 'skill' | null {
  if (item.tags.includes('principle')) return 'principle';
  if (item.tags.includes('heuristic')) return 'heuristic';
  if (item.tags.includes('pattern')) return 'pattern';
  if (item.guidanceType === 'skill' || item.tags.includes('skill')) return 'skill';
  return null;
}

function calculateScore(score: RetrievalScore): number {
  const weighted =
    score.semanticSimilarity * 0.5 +
    score.signalMatch * 0.3 +
    score.tagMatch * 0.2 +
    score.falsePositivePenalty;
  return Math.max(0, Math.min(1, weighted));
}

async function getFalsePositiveCounts(
  database: typeof db,
  guidanceIds: string[],
): Promise<Record<string, number>> {
  if (guidanceIds.length === 0) return {};

  const rows = await database
    .select({ guidanceIds: reviewOutcomes.guidanceIds })
    .from(reviewOutcomes)
    .where(eq(reviewOutcomes.falsePositive, true));

  const counts: Record<string, number> = {};
  for (const row of rows) {
    const ids = normalizeStringArray(row.guidanceIds);
    for (const guidanceId of ids) {
      if (!guidanceIds.includes(guidanceId)) continue;
      counts[guidanceId] = (counts[guidanceId] ?? 0) + 1;
    }
  }

  return counts;
}

function filterInapplicableGuidance(
  guidanceList: GuidanceItem[],
  context: { language: string; framework?: string; riskSignals: string[] },
): GuidanceItem[] {
  return guidanceList.filter((item) => {
    const applicability = item.applicability;
    if (!applicability) return true;

    if (applicability.excludedFrameworks?.includes(context.framework ?? '')) {
      return false;
    }

    if (applicability.languages?.length && !applicability.languages.includes(context.language)) {
      return false;
    }

    if (applicability.frameworks?.length) {
      const framework = context.framework ?? '';
      if (!applicability.frameworks.includes(framework)) return false;
    }

    if (applicability.signals?.length) {
      const matchedSignals = applicability.signals.some((signal) =>
        context.riskSignals.includes(signal),
      );
      if (!matchedSignals) return false;
    }

    return true;
  });
}

function classifyRows(rows: GuidanceRow[]): GuidanceItem[] {
  const seen = new Set<string>();

  return rows
    .map(toGuidanceItem)
    .filter((item) => item.priority >= 0)
    .filter((item) => classifyGuidance(item) !== null)
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}

function formatSimilarFinding(content: string, metadata: Record<string, unknown>): string {
  const category = typeof metadata.category === 'string' ? metadata.category : 'unknown';
  const filePath = typeof metadata.filePath === 'string' ? metadata.filePath : undefined;
  const title = typeof metadata.title === 'string' ? metadata.title : undefined;
  const prefix = filePath ? `${filePath}: ` : '';
  const heading = title ? `${title} — ` : '';
  return `過去の類似指摘 (${category}) ${prefix}${heading}${content.slice(0, 200)}`;
}

function formatSuccessBenchmark(content: string, metadata: Record<string, unknown>): string {
  const title = typeof metadata.title === 'string' ? metadata.title : 'Success Path';
  const filePath = typeof metadata.filePath === 'string' ? metadata.filePath : undefined;
  const prefix = filePath ? `[${filePath}] ` : '';
  return `過去の成功実装 (Golden Path) ${prefix}${title}: ${content.slice(0, 300)}`;
}

export async function retrieveSuccessBenchmarks(
  projectKey: string,
  riskSignals: string[],
  language: string,
  deps: { searchMemory?: typeof searchMemory } = {},
): Promise<string[]> {
  const searchMem = deps.searchMemory ?? searchMemory;

  // 成功したエピソードのみを検索
  const results = await searchMem(
    `code-review-${projectKey}`,
    `${riskSignals.join(' ')} ${language} success implementation`.trim(),
    3,
    { succeeded: true },
  ).catch(() => []);

  return results.map((memory) =>
    formatSuccessBenchmark(memory.content, (memory.metadata as Record<string, unknown>) ?? {}),
  );
}

export async function retrieveGuidance(
  projectKey: string,
  riskSignals: string[],
  language: string,
  framework?: string,
  deps: GuidanceRetrievalDependencies = {},
): Promise<GuidanceRetrievalResult> {
  const getDemand = deps.getOnDemandGuidance ?? getOnDemandGuidance;
  const database = deps.database ?? db;

  const signalQuery = [riskSignals.join(' '), language, framework ?? '', projectKey]
    .join(' ')
    .trim();

  const [onDemand, benchmarks] = await Promise.all([
    getDemand(signalQuery).catch(() => []),
    retrieveSuccessBenchmarks(projectKey, riskSignals, language, deps),
  ]);

  const allRows = onDemand as GuidanceRow[];
  const candidates = classifyRows(allRows);
  const archiveKeys = candidates
    .map((item) => item.id)
    .filter((id) => typeof id === 'string' && id.length > 0);
  const falsePositiveCounts = await getFalsePositiveCounts(database, archiveKeys);
  const rowById = new Map<string, GuidanceRow>();
  for (const row of allRows) {
    rowById.set(toGuidanceItem(row).id, row);
  }

  const scored = candidates
    .map((item) => {
      const sourceRow = rowById.get(item.id);
      const semanticSimilarity =
        typeof sourceRow?.similarity === 'number' ? sourceRow.similarity : 0.5;
      const applicabilitySignals = item.applicability?.signals ?? [];
      const signalMatch =
        applicabilitySignals.length > 0
          ? applicabilitySignals.filter((signal) => riskSignals.includes(signal)).length /
            Math.max(riskSignals.length, 1)
          : 0;
      const tagMatch = [language, framework].filter(Boolean).reduce((score, token) => {
        return score + (item.tags.includes(token as string) ? 0.5 : 0);
      }, 0);
      const falsePositivePenalty = -(falsePositiveCounts[item.id] ?? 0) * 0.2;

      return {
        item,
        score: calculateScore({ semanticSimilarity, signalMatch, tagMatch, falsePositivePenalty }),
      };
    })
    .sort((a, b) => b.score - a.score)
    .filter((entry) => entry.score > 0.3)
    .map((entry) => entry.item);

  const filterAndSlice = (type: 'principle' | 'heuristic' | 'pattern' | 'skill', limit: number) =>
    filterInapplicableGuidance(
      scored.filter((item) => classifyGuidance(item) === type),
      {
        language,
        framework,
        riskSignals,
      },
    ).slice(0, limit);

  return {
    principles: filterAndSlice('principle', 5),
    heuristics: filterAndSlice('heuristic', 5),
    patterns: filterAndSlice('pattern', 5),
    skills: filterAndSlice('skill', 3),
    benchmarks,
  };
}

export async function searchSimilarFindings(
  projectKey: string,
  riskSignals: string[],
  language: string,
  deps: { searchMemory?: typeof searchMemory } = {},
): Promise<string[]> {
  const searchMem = deps.searchMemory ?? searchMemory;
  const results = await searchMem(
    `code-review-${projectKey}`,
    `${riskSignals.join(' ')} ${language}`.trim(),
    5,
  ).catch(() => []);

  return results.map((memory) =>
    formatSimilarFinding(memory.content, (memory.metadata as Record<string, unknown>) ?? {}),
  );
}

export { filterInapplicableGuidance, calculateScore, toGuidanceItem };
