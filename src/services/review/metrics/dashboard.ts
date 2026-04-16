import { config } from '../../../config.js';
import { listMemoriesByMetadata } from '../../memory.js';
import { extractPatternCandidates } from '../knowledge/evolution.js';
import type { ReviewKPIs } from '../types.js';
import { calculateMetrics } from './calculator.js';

export interface ReviewDashboard {
  weeklyKPIs: ReviewKPIs;
  guidanceSummary: {
    activePrinciples: number;
    activeHeuristics: number;
    activePatterns: number;
    candidateCount: number;
    degradedCount: number;
  };
  targets: {
    precisionRate: { current: number; target: number; achieved: boolean };
    zeroFpDays: { current: number; target: number; achieved: boolean };
    knowledgeContribution: { current: number; target: number; achieved: boolean };
  };
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function metadataTags(metadata: Record<string, unknown>): string[] {
  return Array.isArray(metadata.tags)
    ? metadata.tags.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      )
    : [];
}

export async function getDashboard(): Promise<ReviewDashboard> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const kpis = await calculateMetrics({ start: weekAgo, end: now });
  const guidanceRows = await listMemoriesByMetadata(
    config.guidance.sessionId,
    { kind: 'guidance' },
    100,
  );
  const candidates = await extractPatternCandidates();

  const guidanceSummary = guidanceRows.reduce(
    (acc, row) => {
      const metadata = metadataRecord(row.metadata);
      const tags = metadataTags(metadata);
      acc.activePrinciples += tags.includes('principle') ? 1 : 0;
      acc.activeHeuristics += tags.includes('heuristic') ? 1 : 0;
      acc.activePatterns += tags.includes('pattern') ? 1 : 0;
      acc.degradedCount +=
        (typeof metadata.priority === 'number' ? metadata.priority : 50) < 30 ? 1 : 0;
      return acc;
    },
    {
      activePrinciples: 0,
      activeHeuristics: 0,
      activePatterns: 0,
      candidateCount: candidates.length,
      degradedCount: 0,
    },
  );

  return {
    weeklyKPIs: kpis,
    guidanceSummary,
    targets: {
      precisionRate: {
        current: kpis.precisionRate,
        target: 0.6,
        achieved: kpis.precisionRate >= 0.6,
      },
      zeroFpDays: {
        current: kpis.zeroFpDays,
        target: 7,
        achieved: kpis.zeroFpDays >= 7,
      },
      knowledgeContribution: {
        current: kpis.knowledgeContributionRate,
        target: 0.4,
        achieved: kpis.knowledgeContributionRate >= 0.4,
      },
    },
  };
}
