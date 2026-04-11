import type { Knowledge } from '../knowledge/types';
import type { GapDetectionOutput } from '../schemas/llm';
import type { VerifyEvidenceResult } from '../verifier';

export type GapType =
  | 'missing_definition'
  | 'missing_comparison'
  | 'missing_example'
  | 'missing_constraints'
  | 'weak_evidence'
  | 'outdated'
  | 'uncertain';

export type DetectedGap = {
  type: GapType;
  description: string;
  priority: number;
  origin: 'rule' | 'llm' | 'merged';
};

export type GapDetectionInput = {
  topic: string;
  knowledge?: Knowledge | null;
  verifierResult?: VerifyEvidenceResult;
  llmGaps?: GapDetectionOutput['gaps'];
  now?: number;
  outdatedAfterDays?: number;
};

export type GapDetectionResult = {
  gaps: DetectedGap[];
  stats: {
    claimCount: number;
    relationCount: number;
    sourceCount: number;
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

const clampPriority = (value: number): number => Math.max(0, Math.min(1, value));

const includesAny = (text: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(text));

const normalizeText = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

export const detectGaps = (input: GapDetectionInput): GapDetectionResult => {
  const now = input.now ?? Date.now();
  const outdatedAfterDays = input.outdatedAfterDays ?? 180;

  const knowledgeClaims = input.knowledge?.claims ?? [];
  const acceptedClaims = input.verifierResult?.acceptedClaims ?? [];
  const rejectedClaims = input.verifierResult?.rejectedClaims ?? [];
  const claims = acceptedClaims.length > 0 ? acceptedClaims : knowledgeClaims;
  const claimTexts = claims.map((claim) => normalizeText(claim.text));

  const relations = input.knowledge?.relations ?? [];
  const sources = input.knowledge?.sources ?? [];

  const gaps = new Map<GapType, DetectedGap>();
  const addRuleGap = (type: GapType, description: string, priority: number) => {
    const existing = gaps.get(type);
    const next: DetectedGap = {
      type,
      description,
      priority: clampPriority(priority),
      origin: existing && existing.origin === 'llm' ? 'merged' : 'rule',
    };
    if (!existing || next.priority >= existing.priority) {
      gaps.set(type, next);
    }
  };

  const definitionPatterns = [/\bis\b/, /\bmeans\b/, /\bdefined as\b/, /\brefers to\b/];
  if (!claimTexts.some((text) => includesAny(text, definitionPatterns))) {
    addRuleGap('missing_definition', 'Topic definition is missing or too implicit.', 0.7);
  }

  const hasComparisonRelation = relations.some((relation) => relation.type === 'compares_with');
  const comparisonPatterns = [/\bcompare\b/, /\bversus\b/, /\bvs\b/, /\bthan\b/];
  if (!hasComparisonRelation && !claimTexts.some((text) => includesAny(text, comparisonPatterns))) {
    addRuleGap('missing_comparison', 'No explicit comparison with alternatives was found.', 0.62);
  }

  const examplePatterns = [/\bexample\b/, /\be\.g\.\b/, /\bfor instance\b/];
  if (!claimTexts.some((text) => includesAny(text, examplePatterns))) {
    addRuleGap('missing_example', 'No concrete examples were captured.', 0.6);
  }

  const constraintPatterns = [
    /\bconstraint\b/,
    /\blimitation\b/,
    /\btrade[\s-]?off\b/,
    /\bcannot\b/,
    /\bmust\b/,
    /\bonly if\b/,
  ];
  if (!claimTexts.some((text) => includesAny(text, constraintPatterns))) {
    addRuleGap(
      'missing_constraints',
      'Constraints and caveats are not sufficiently documented.',
      0.66,
    );
  }

  const uniqueEvidenceSourceIds = new Set(
    claims.flatMap((claim) => claim.sourceIds ?? []).filter(Boolean),
  );
  const averageSourcesPerClaim =
    claims.length > 0
      ? claims.reduce((sum, claim) => sum + (claim.sourceIds?.length ?? 0), 0) / claims.length
      : 0;
  if (claims.length < 2 || uniqueEvidenceSourceIds.size < 2 || averageSourcesPerClaim < 1.5) {
    addRuleGap(
      'weak_evidence',
      'Evidence diversity is weak (few claims or too few independent sources).',
      0.75,
    );
  }

  const latestSourceAt = sources.reduce<number | undefined>((latest, source) => {
    const ts = source.fetchedAt;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) {
      return latest;
    }
    if (latest === undefined || ts > latest) {
      return ts;
    }
    return latest;
  }, undefined);

  if (latestSourceAt !== undefined) {
    const ageDays = (now - latestSourceAt) / DAY_MS;
    if (ageDays > outdatedAfterDays) {
      addRuleGap(
        'outdated',
        `Latest supporting source is older than ${outdatedAfterDays} days.`,
        0.68,
      );
    }
  }

  const conflictCount = input.verifierResult?.conflicts.length ?? 0;
  const acceptedCount = input.verifierResult?.acceptedClaims.length ?? 0;
  const rejectedCount = rejectedClaims.length;
  const uncertainRatio =
    acceptedCount + rejectedCount > 0 ? rejectedCount / (acceptedCount + rejectedCount) : 0;
  if (conflictCount > 0 || uncertainRatio >= 0.4) {
    addRuleGap(
      'uncertain',
      'Claim consistency is uncertain due to conflicts or high rejection ratio.',
      0.8,
    );
  }

  for (const llmGap of input.llmGaps ?? []) {
    const type = llmGap.type as GapType;
    const existing = gaps.get(type);
    if (!existing) {
      gaps.set(type, {
        type,
        description: llmGap.description,
        priority: clampPriority(llmGap.priority),
        origin: 'llm',
      });
      continue;
    }

    const merged: DetectedGap = {
      type,
      description:
        existing.description === llmGap.description
          ? existing.description
          : `${existing.description} | LLM: ${llmGap.description}`,
      priority: Math.max(existing.priority, clampPriority(llmGap.priority)),
      origin: 'merged',
    };
    gaps.set(type, merged);
  }

  return {
    gaps: [...gaps.values()].sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.type.localeCompare(b.type);
    }),
    stats: {
      claimCount: claims.length,
      relationCount: relations.length,
      sourceCount: sources.length,
    },
  };
};
