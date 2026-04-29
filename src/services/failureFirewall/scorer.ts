import type { FailureCandidate, FailureDiffFeatures, FailurePattern, GoldenPath } from './types.js';

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function overlapScore(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right.map((item) => item.toLowerCase()));
  const matches = left.filter((item) => rightSet.has(item.toLowerCase())).length;
  return matches / Math.max(left.length, 1);
}

function languageMatches(patternLanguages: string[], features: FailureDiffFeatures): boolean {
  if (patternLanguages.length === 0) return true;
  const languages = features.languages.map((language) => language.toLowerCase());
  return patternLanguages.some((language) => languages.includes(language.toLowerCase()));
}

function frameworkMatches(patternFrameworks: string[], features: FailureDiffFeatures): boolean {
  if (patternFrameworks.length === 0) return true;
  if (features.frameworks.length === 0) return true;
  return patternFrameworks.some((framework) => features.frameworks.includes(framework));
}

function joinedAdded(features: FailureDiffFeatures): string {
  return features.files.flatMap((file) => file.addedLines).join('\n');
}

function joinedPatch(features: FailureDiffFeatures): string {
  return features.files.flatMap((file) => [...file.addedLines, ...file.removedLines]).join('\n');
}

function firstChangedLine(features: FailureDiffFeatures, filePath?: string): number {
  const diff =
    features.normalizedDiffs.find((item) => item.filePath === filePath) ??
    features.normalizedDiffs[0];
  const added = diff?.hunks
    .flatMap((hunk) => hunk.lines)
    .find((line) => line.type === 'added' && line.newLineNo !== undefined);
  return added?.newLineNo ?? 1;
}

function firstChangedFile(features: FailureDiffFeatures, preferredSignal?: string): string {
  if (!preferredSignal) return features.changedFiles[0] ?? 'unknown';
  const signalPattern = new RegExp(preferredSignal.replace(/[_-]/g, '.{0,20}'), 'i');
  const file = features.files.find((item) =>
    signalPattern.test([...item.addedLines, ...item.removedLines, item.filePath].join('\n')),
  );
  return file?.filePath ?? features.changedFiles[0] ?? 'unknown';
}

function containsAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function goldenPathApplies(path: GoldenPath, features: FailureDiffFeatures): boolean {
  const patch = joinedPatch(features);
  if (path.pathType === 'mutation_cache_update') {
    return containsAny(patch, [/\buseMutation\b/i, /\bmutationFn\b/i, /\bmutateAsync\b/i]);
  }
  if (path.pathType === 'auth_permission_guard_preserved') {
    return features.riskSignals.includes('auth') || features.riskSignals.includes('permission');
  }
  if (path.pathType === 'destructive_db_operation_scoped') {
    return containsAny(patch, [/\b(delete|truncate|drop)\b/i]);
  }
  if (path.pathType === 'schema_validation_kept_in_sync') {
    return containsAny(patch, [/\b(req\.body|request\.json|params|searchParams)\b/i]);
  }
  return true;
}

function missingStepsForGoldenPath(path: GoldenPath, features: FailureDiffFeatures): string[] {
  const added = joinedAdded(features);
  const patch = joinedPatch(features);
  const missing: string[] = [];

  for (const step of path.requiredSteps) {
    const normalized = step.toLowerCase();
    if (
      normalized.includes('query key') &&
      !containsAny(added, [/invalidateQueries/i, /setQueryData/i, /queryClient/i])
    ) {
      missing.push(step);
      continue;
    }
    if (
      normalized.includes('auth') ||
      normalized.includes('authorization') ||
      normalized.includes('guard')
    ) {
      if (!containsAny(patch, [/auth/i, /permission/i, /guard/i, /middleware/i]))
        missing.push(step);
      continue;
    }
    if (
      normalized.includes('scope destructive') &&
      containsAny(patch, [/\b(delete|truncate|drop)\b/i]) &&
      !containsAny(added, [/\bwhere\b/i, /tenant/i, /userId/i, /projectId/i, /id\s*[:=]/i])
    ) {
      missing.push(step);
      continue;
    }
    if (
      normalized.includes('validation schema') &&
      !containsAny(added, [/\bz\./i, /schema/i, /validate/i, /safeParse/i, /parse\(/i])
    ) {
      missing.push(step);
      continue;
    }
    if (
      normalized.includes('transaction boundary') &&
      !containsAny(added, [/transaction/i, /\bBEGIN\b/i, /\bCOMMIT\b/i, /rollback/i])
    ) {
      missing.push(step);
    }
  }

  return missing;
}

function matchedAlternatives(path: GoldenPath, features: FailureDiffFeatures): string[] {
  const added = joinedAdded(features);
  return path.allowedAlternatives.filter((alternative) => {
    const normalized = alternative.toLowerCase();
    if (normalized.includes('setquerydata')) return /setQueryData/i.test(added);
    if (normalized.includes('refresh')) return /refresh|invalidateAll|revalidate/i.test(added);
    if (normalized.includes('upstream guard')) return /middleware|guard/i.test(added);
    if (normalized.includes('dry-run')) return /dryRun|dry-run/i.test(added);
    return false;
  });
}

function evidenceForPattern(pattern: FailurePattern, features: FailureDiffFeatures): string[] {
  const added = joinedAdded(features);
  const patch = joinedPatch(features);
  const evidence: string[] = [];

  if (
    pattern.patternType === 'missing_cache_invalidation' &&
    containsAny(patch, [/\buseMutation\b/i, /\bmutationFn\b/i, /\bmutateAsync\b/i])
  ) {
    evidence.push('mutation-like code changed');
    if (!containsAny(added, [/invalidateQueries/i, /setQueryData/i])) {
      evidence.push('cache update call is absent in added lines');
    }
  }
  if (pattern.patternType === 'auth_guard_weakened' && features.riskSignals.includes('auth')) {
    evidence.push('auth or permission code changed');
  }
  if (
    pattern.patternType === 'destructive_db_without_scope' &&
    containsAny(patch, [/\b(delete|truncate|drop)\b/i])
  ) {
    evidence.push('destructive database operation changed');
    if (!containsAny(added, [/\bwhere\b/i, /tenant/i, /userId/i, /projectId/i])) {
      evidence.push('scope condition is not visible in added lines');
    }
  }
  if (
    pattern.patternType === 'schema_validation_gap' &&
    containsAny(patch, [/\b(req\.body|request\.json|params|searchParams)\b/i])
  ) {
    evidence.push('input handling changed');
    if (!containsAny(added, [/\bz\./i, /schema/i, /validate/i, /safeParse/i, /parse\(/i])) {
      evidence.push('validation update is not visible in added lines');
    }
  }

  return evidence;
}

function resolveSeverity(
  path: GoldenPath | undefined,
  pattern: FailurePattern | undefined,
  deviationScore: number,
  recurrenceScore: number,
): FailureCandidate['severity'] {
  if (pattern && recurrenceScore >= 0.7) return pattern.severity;
  if (path && deviationScore >= 0.8) return path.severityWhenMissing;
  if (deviationScore >= 0.45 || recurrenceScore >= 0.45) return 'warning';
  return 'info';
}

function resolveConfidence(score: number): FailureCandidate['confidence'] {
  if (score >= 0.8) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

function isAutoBlockingCandidate(
  severity: FailureCandidate['severity'],
  decision: FailureCandidate['decision'],
): boolean {
  return severity === 'error' && decision === 'deviation_with_recurrence';
}

export function scoreFailureCandidates(
  features: FailureDiffFeatures,
  goldenPaths: GoldenPath[],
  failurePatterns: FailurePattern[],
): FailureCandidate[] {
  if (features.docsOnly) return [];
  if (features.changedFiles.length === 0 || features.riskSignals.length === 0) return [];

  const activePaths = goldenPaths.filter((path) => path.status === 'active');
  const activePatterns = failurePatterns.filter((pattern) => pattern.status === 'active');
  const candidates: FailureCandidate[] = [];

  for (const path of activePaths) {
    if (
      !languageMatches(path.languages, features) ||
      !frameworkMatches(path.frameworks, features)
    ) {
      continue;
    }
    if (!goldenPathApplies(path, features)) continue;

    const signalOverlap = overlapScore(path.riskSignals, features.riskSignals);
    if (signalOverlap === 0 && path.riskSignals.length > 0) continue;

    const missingRequiredSteps = missingStepsForGoldenPath(path, features);
    const allowedAlternativeMatched = matchedAlternatives(path, features);
    const missingScore =
      path.requiredSteps.length > 0 ? missingRequiredSteps.length / path.requiredSteps.length : 0;
    const alternativeCredit = allowedAlternativeMatched.length > 0 ? 0.35 : 0;
    const deviationScore = clamp(0.35 * signalOverlap + 0.45 * missingScore - alternativeCredit);
    if (deviationScore < 0.3) continue;

    const pattern = activePatterns.find((item) => item.goldenPathId === path.id);
    const patternEvidence = pattern ? evidenceForPattern(pattern, features) : [];
    const hasRequiredPatternEvidence =
      patternEvidence.length >= Math.max(pattern?.requiredEvidence.length ?? 0, 1);
    const recurrenceScore = pattern
      ? clamp(
          0.45 * overlapScore(pattern.riskSignals, features.riskSignals) +
            0.4 *
              (hasRequiredPatternEvidence
                ? Math.min(1, patternEvidence.length / Math.max(pattern.requiredEvidence.length, 1))
                : 0) -
            pattern.falsePositiveCount * 0.2,
        )
      : 0;
    const score = clamp(Math.max(deviationScore, recurrenceScore));
    if (missingRequiredSteps.length === 0 && recurrenceScore < 0.65) continue;
    const filePath = firstChangedFile(features, path.riskSignals[0]);
    const severity = resolveSeverity(path, pattern, deviationScore, recurrenceScore);
    const decision =
      allowedAlternativeMatched.length > 0
        ? 'allowed_alternative'
        : recurrenceScore >= 0.65
          ? 'deviation_with_recurrence'
          : 'deviation';

    candidates.push({
      goldenPath: path,
      failurePattern: pattern,
      deviationScore,
      recurrenceScore,
      score,
      missingRequiredSteps,
      allowedAlternativeMatched,
      evidence: [...patternEvidence, ...missingRequiredSteps.map((step) => `missing: ${step}`)],
      filePath,
      lineNew: firstChangedLine(features, filePath),
      decision,
      severity,
      confidence: resolveConfidence(score),
      needsHumanConfirmation: !isAutoBlockingCandidate(severity, decision),
    });
  }

  for (const pattern of activePatterns) {
    if (candidates.some((candidate) => candidate.failurePattern?.id === pattern.id)) continue;
    if (
      !languageMatches(pattern.languages, features) ||
      !frameworkMatches(pattern.frameworks, features)
    ) {
      continue;
    }
    const evidence = evidenceForPattern(pattern, features);
    if (evidence.length < Math.max(pattern.requiredEvidence.length, 1)) continue;
    const signalOverlap = overlapScore(pattern.riskSignals, features.riskSignals);
    const recurrenceScore = clamp(
      0.55 * signalOverlap +
        0.35 * Math.min(1, evidence.length / Math.max(pattern.requiredEvidence.length, 1)) -
        pattern.falsePositiveCount * 0.2,
    );
    if (recurrenceScore < 0.45) continue;

    const filePath = firstChangedFile(features, pattern.riskSignals[0]);
    candidates.push({
      failurePattern: pattern,
      deviationScore: 0,
      recurrenceScore,
      score: recurrenceScore,
      missingRequiredSteps: [],
      allowedAlternativeMatched: [],
      evidence,
      filePath,
      lineNew: firstChangedLine(features, filePath),
      decision: 'needs_confirmation',
      severity: pattern.severity === 'error' ? 'warning' : pattern.severity,
      confidence: resolveConfidence(recurrenceScore),
      needsHumanConfirmation: true,
    });
  }

  return candidates
    .filter((candidate) => candidate.decision !== 'allowed_alternative')
    .sort((left, right) => right.score - left.score)
    .slice(0, 10);
}
