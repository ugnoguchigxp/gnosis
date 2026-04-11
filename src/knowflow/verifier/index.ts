import { fingerprintText, jaccardSimilarity, normalizeClaimText } from '../knowledge/similarity';
import type { ClaimInput } from '../knowledge/types';

export type EvidenceSource = {
  id: string;
  url?: string;
  domain?: string;
  fetchedAt?: number;
  publishedAt?: number;
  qualityScore?: number;
};

export type EvidenceClaim = {
  id?: string;
  text: string;
  confidence?: number;
  sourceIds?: string[];
  embedding?: number[];
};

export type VerifyEvidenceInput = {
  topic: string;
  claims: EvidenceClaim[];
  sources: EvidenceSource[];
  now?: number;
  thresholds?: {
    minAcceptanceScore?: number;
    minDiversityDomains?: number;
    minRecencyScore?: number;
    minDomainQualityScore?: number;
    contradictionSimilarity?: number;
  };
};

export type RejectedClaim = {
  claim: EvidenceClaim;
  score: number;
  reasons: string[];
  blocking: boolean;
};

export type VerificationConflict = {
  leftClaim: string;
  rightClaim: string;
  reason: 'contradiction';
};

export type VerifyEvidenceResult = {
  acceptedClaims: ClaimInput[];
  rejectedClaims: RejectedClaim[];
  conflicts: VerificationConflict[];
  metrics: {
    totalClaims: number;
    acceptedCount: number;
    rejectedCount: number;
    conflictCount: number;
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));

const normalizeDomain = (source: EvidenceSource): string => {
  if (source.domain && source.domain.trim().length > 0) {
    return source.domain.trim().toLowerCase();
  }

  if (source.url) {
    try {
      return new URL(source.url).hostname.toLowerCase();
    } catch {
      return '';
    }
  }
  return '';
};

const estimateDomainQuality = (domain: string): number => {
  if (!domain) {
    return 0.4;
  }
  if (
    domain.endsWith('.gov') ||
    domain.endsWith('.edu') ||
    domain.includes('docs.') ||
    domain === 'developer.mozilla.org'
  ) {
    return 0.9;
  }
  if (domain.includes('github.com') || domain.includes('wikipedia.org')) {
    return 0.8;
  }
  if (domain.includes('blog')) {
    return 0.55;
  }
  return 0.65;
};

const getSourceTime = (source: EvidenceSource): number | undefined => {
  const candidates = [source.publishedAt, source.fetchedAt].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  if (candidates.length === 0) {
    return undefined;
  }
  return Math.max(...candidates);
};

const hasNegation = (text: string): boolean =>
  /\b(no|not|never|without|cannot|can't|isn't|aren't|doesn't|don't|won't)\b/i.test(text);

const toSupportingSources = (
  sourceIds: string[] | undefined,
  sourceMap: Map<string, EvidenceSource>,
): EvidenceSource[] =>
  (sourceIds ?? [])
    .map((id) => sourceMap.get(id))
    .filter((source): source is EvidenceSource => Boolean(source));

export const verifyEvidence = (input: VerifyEvidenceInput): VerifyEvidenceResult => {
  const now = input.now ?? Date.now();
  const minAcceptanceScore = input.thresholds?.minAcceptanceScore ?? 0.58;
  const minDiversityDomains = input.thresholds?.minDiversityDomains ?? 1;
  const minRecencyScore = input.thresholds?.minRecencyScore ?? 0.4;
  const minDomainQualityScore = input.thresholds?.minDomainQualityScore ?? 0.45;
  const contradictionSimilarity = input.thresholds?.contradictionSimilarity ?? 0.45;

  const sourceMap = new Map<string, EvidenceSource>();
  for (const source of input.sources) {
    sourceMap.set(source.id, source);
  }

  const conflicts: VerificationConflict[] = [];
  const conflictIndexMap = new Map<number, number[]>();
  const normalizedClaims = input.claims.map((claim) => normalizeClaimText(claim.text));

  for (let i = 0; i < input.claims.length; i += 1) {
    const left = input.claims[i];
    if (!left) continue;
    for (let j = i + 1; j < input.claims.length; j += 1) {
      const right = input.claims[j];
      if (!right) continue;
      const similarity = jaccardSimilarity(left.text, right.text);
      if (similarity < contradictionSimilarity) {
        continue;
      }

      const leftNeg = hasNegation(left.text);
      const rightNeg = hasNegation(right.text);
      if (leftNeg === rightNeg) {
        continue;
      }

      const leftNorm = normalizedClaims[i];
      const rightNorm = normalizedClaims[j];
      if (!leftNorm || !rightNorm) {
        continue;
      }

      conflicts.push({
        leftClaim: left.text,
        rightClaim: right.text,
        reason: 'contradiction',
      });
      conflictIndexMap.set(i, [...(conflictIndexMap.get(i) ?? []), j]);
      conflictIndexMap.set(j, [...(conflictIndexMap.get(j) ?? []), i]);
    }
  }

  const evaluations = input.claims.map((claim) => {
    const normalizedSourceIds = [...new Set((claim.sourceIds ?? []).filter(Boolean))];
    const supportingSources = toSupportingSources(normalizedSourceIds, sourceMap);

    const domainSet = new Set(
      supportingSources.map((source) => normalizeDomain(source)).filter(Boolean),
    );
    const diversityScore = clamp(domainSet.size / 3);
    const supportScore = clamp(normalizedSourceIds.length / 3);

    const recencyBasis = supportingSources
      .map(getSourceTime)
      .filter((value): value is number => typeof value === 'number');
    const latestAt = recencyBasis.length > 0 ? Math.max(...recencyBasis) : undefined;
    const ageDays = latestAt ? Math.max(0, (now - latestAt) / DAY_MS) : Number.POSITIVE_INFINITY;
    const recencyScore =
      ageDays <= 30
        ? 1
        : ageDays <= 180
          ? 0.8
          : ageDays <= 365
            ? 0.55
            : ageDays < Number.POSITIVE_INFINITY
              ? 0.3
              : 0.5;

    const domainQualityValues = supportingSources.map((source) =>
      clamp(
        typeof source.qualityScore === 'number'
          ? source.qualityScore
          : estimateDomainQuality(normalizeDomain(source)),
      ),
    );
    const domainQualityScore =
      domainQualityValues.length > 0
        ? domainQualityValues.reduce((sum, value) => sum + value, 0) / domainQualityValues.length
        : 0.4;

    const baseConfidence = clamp(claim.confidence ?? 0.5);
    const score =
      baseConfidence * 0.2 +
      supportScore * 0.2 +
      diversityScore * 0.2 +
      recencyScore * 0.2 +
      domainQualityScore * 0.2;

    return {
      claim,
      normalizedSourceIds,
      domainSetSize: domainSet.size,
      recencyScore,
      domainQualityScore,
      baseConfidence,
      score,
      fingerprint: fingerprintText(claim.text),
    };
  });

  const acceptedClaims: ClaimInput[] = [];
  const rejectedClaims: RejectedClaim[] = [];
  const selectedByFingerprint = new Map<string, { score: number; index: number }>();

  for (let index = 0; index < evaluations.length; index += 1) {
    const evaluated = evaluations[index];
    if (!evaluated) continue;
    const { claim, normalizedSourceIds, baseConfidence, score } = evaluated;
    const reasons: string[] = [];
    const claimFingerprint = evaluated.fingerprint;

    const currentBest = selectedByFingerprint.get(claimFingerprint);
    if (currentBest && currentBest.score >= score) {
      reasons.push('duplication');
    }

    if (evaluated.domainSetSize < minDiversityDomains) {
      reasons.push('low-source-diversity');
    }
    if (evaluated.recencyScore < minRecencyScore) {
      reasons.push('outdated');
    }
    if (evaluated.domainQualityScore < minDomainQualityScore) {
      reasons.push('low-domain-quality');
    }
    const conflictingIndices = conflictIndexMap.get(index) ?? [];
    const hasBetterConflict = conflictingIndices.some((otherIndex) => {
      const other = evaluations[otherIndex];
      if (!other) return false;
      if (other.score > score) return true;
      return Math.abs(other.score - score) < 1e-9 && otherIndex < index;
    });
    if (hasBetterConflict) {
      reasons.push('contradiction-detected');
    }
    if (score < minAcceptanceScore) {
      reasons.push('low-overall-score');
    }

    if (reasons.length > 0) {
      rejectedClaims.push({
        claim: {
          ...claim,
          sourceIds: normalizedSourceIds,
        },
        score,
        reasons,
        blocking: reasons.includes('contradiction-detected'),
      });
      continue;
    }

    selectedByFingerprint.set(claimFingerprint, { score, index });
    acceptedClaims.push({
      id: claim.id,
      text: claim.text,
      confidence: clamp(Math.max(baseConfidence, score)),
      sourceIds: normalizedSourceIds,
      embedding: claim.embedding,
    });
  }

  return {
    acceptedClaims,
    rejectedClaims,
    conflicts,
    metrics: {
      totalClaims: input.claims.length,
      acceptedCount: acceptedClaims.length,
      rejectedCount: rejectedClaims.length,
      conflictCount: conflicts.length,
    },
  };
};

export const buildVerificationSummary = (result: VerifyEvidenceResult): string => {
  const blockingRejected = result.rejectedClaims.filter((item) => item.blocking).length;
  return [
    `accepted=${result.acceptedClaims.length}`,
    `rejected=${result.rejectedClaims.length}`,
    `conflicts=${result.conflicts.length}`,
    `blocking=${blockingRejected}`,
  ].join(', ');
};
