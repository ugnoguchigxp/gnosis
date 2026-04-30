import { buildFailureDiffFeatures } from './diffFeatures.js';
import { loadFailureKnowledge } from './patternStore.js';
import type {
  FailureDiffFeatures,
  FailureFirewallContext,
  FailurePattern,
  GoldenPath,
  LookupFailureFirewallContextInput,
} from './types.js';

const RISK_KEYWORDS: Array<{ signal: string; patterns: RegExp[] }> = [
  { signal: 'cache_invalidation', patterns: [/cache/i, /mutation/i, /query/i] },
  { signal: 'auth', patterns: [/auth/i, /permission/i, /token/i, /guard/i] },
  { signal: 'destructive_db_change', patterns: [/delete/i, /truncate/i, /drop/i, /migration/i] },
  { signal: 'input_validation', patterns: [/validation/i, /schema/i, /params/i, /request/i] },
  { signal: 'external_api_error', patterns: [/fetch/i, /api/i, /http/i, /axios/i] },
  { signal: 'docs_only', patterns: [/docs?/i, /\.md\b/i] },
];

function unique(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
}

function overlapScore(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right.map((item) => item.toLowerCase()));
  const matches = left.filter((item) => rightSet.has(item.toLowerCase())).length;
  return matches / Math.max(left.length, 1);
}

function inferSignals(input: LookupFailureFirewallContextInput): string[] {
  const text = [
    input.taskGoal,
    ...(input.files ?? []),
    ...(input.changeTypes ?? []),
    ...(input.technologies ?? []),
  ]
    .filter((item): item is string => typeof item === 'string')
    .join('\n');
  const signals: string[] = [];
  for (const entry of RISK_KEYWORDS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) signals.push(entry.signal);
  }
  if ((input.changeTypes ?? []).every((type) => type === 'docs')) signals.push('docs_only');
  return unique(signals);
}

function buildSyntheticFeatures(input: LookupFailureFirewallContextInput): FailureDiffFeatures {
  const riskSignals = inferSignals(input);
  const changedFiles = input.files ?? [];
  const languages = unique(
    changedFiles.map((file) => {
      if (/\.(?:ts|tsx|mts|cts)$/i.test(file)) return 'typescript';
      if (/\.(?:js|jsx|mjs|cjs)$/i.test(file)) return 'javascript';
      if (/\.py$/i.test(file)) return 'python';
      if (/\.rs$/i.test(file)) return 'rust';
      if (/\.go$/i.test(file)) return 'go';
      return '';
    }),
  );
  const docsOnly =
    changedFiles.length > 0 && changedFiles.every((file) => /\.(?:md|mdx|txt|rst)$/i.test(file));
  return {
    rawDiff: '',
    files: [],
    normalizedDiffs: [],
    riskSignals: docsOnly ? unique([...riskSignals, 'docs_only']) : riskSignals,
    languages,
    frameworks: input.technologies ?? [],
    changedFiles,
    addedLineCount: 0,
    removedLineCount: 0,
    docsOnly,
    patchSummary: [
      `files=${changedFiles.join(',')}`,
      `languages=${languages.join(',')}`,
      `riskSignals=${riskSignals.join(',')}`,
    ].join('\n'),
  };
}

function languageScore(languages: string[], features: FailureDiffFeatures): number {
  if (languages.length === 0) return 0.1;
  if (features.languages.length === 0) return 0;
  return overlapScore(
    languages.map((item) => item.toLowerCase()),
    features.languages.map((item) => item.toLowerCase()),
  );
}

function frameworkScore(frameworks: string[], features: FailureDiffFeatures): number {
  if (frameworks.length === 0) return 0.05;
  if (features.frameworks.length === 0) return 0;
  return overlapScore(frameworks, features.frameworks);
}

function scoreGoldenPath(path: GoldenPath, features: FailureDiffFeatures): number {
  if (path.status !== 'active') return 0;
  return Math.min(
    1,
    overlapScore(path.riskSignals, features.riskSignals) * 0.65 +
      languageScore(path.languages, features) * 0.2 +
      frameworkScore(path.frameworks, features) * 0.15,
  );
}

function scoreFailurePattern(pattern: FailurePattern, features: FailureDiffFeatures): number {
  if (pattern.status !== 'active') return 0;
  const falsePositivePenalty = Math.min(0.35, pattern.falsePositiveCount * 0.1);
  return Math.max(
    0,
    Math.min(
      1,
      overlapScore(pattern.riskSignals, features.riskSignals) * 0.7 +
        languageScore(pattern.languages, features) * 0.2 +
        frameworkScore(pattern.frameworks, features) * 0.1 -
        falsePositivePenalty,
    ),
  );
}

function suggestedUse(
  features: FailureDiffFeatures,
  goldenPathCount: number,
  failurePatternCount: number,
): FailureFirewallContext['suggestedUse'] {
  if (features.docsOnly || features.riskSignals.length === 0) return 'skip';
  if (failurePatternCount > 0) return 'run_fast_gate';
  if (goldenPathCount > 0) return 'review_reference';
  return 'skip';
}

export async function lookupFailureFirewallContext(
  input: LookupFailureFirewallContextInput,
): Promise<FailureFirewallContext> {
  const degradedReasons: string[] = [];
  const features = input.rawDiff?.trim()
    ? buildFailureDiffFeatures(input.rawDiff)
    : buildSyntheticFeatures(input);

  let knowledge: Awaited<ReturnType<typeof loadFailureKnowledge>>;
  try {
    knowledge = await loadFailureKnowledge({ knowledgeSource: input.knowledgeSource });
  } catch (error) {
    degradedReasons.push(
      `knowledge_load_failed:${error instanceof Error ? error.message : String(error)}`,
    );
    knowledge = { goldenPaths: [], failurePatterns: [] };
  }

  const maxGoldenPaths = Math.max(0, Math.min(10, input.maxGoldenPaths ?? 5));
  const maxFailurePatterns = Math.max(0, Math.min(10, input.maxFailurePatterns ?? 3));
  const goldenPathCandidates = knowledge.goldenPaths
    .map((path) => ({ path, score: scoreGoldenPath(path, features) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxGoldenPaths)
    .map(({ path, score }) => ({
      id: path.id,
      title: path.title,
      source: path.source,
      pathType: path.pathType,
      appliesWhen: path.appliesWhen,
      requiredSteps: path.requiredSteps,
      allowedAlternatives: path.allowedAlternatives,
      score: Number(score.toFixed(3)),
    }));

  const failurePatternCandidates = knowledge.failurePatterns
    .map((pattern) => ({ pattern, score: scoreFailurePattern(pattern, features) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxFailurePatterns)
    .map(({ pattern, score }) => ({
      id: pattern.id,
      title: pattern.title,
      source: pattern.source,
      patternType: pattern.patternType,
      severity: pattern.severity,
      requiredEvidence: pattern.requiredEvidence,
      score: Number(score.toFixed(3)),
    }));

  const use = suggestedUse(features, goldenPathCandidates.length, failurePatternCandidates.length);
  const shouldUse = use !== 'skip';

  return {
    shouldUse,
    reason: shouldUse
      ? `Matched Failure Firewall context for risk signals: ${features.riskSignals.join(', ')}`
      : features.docsOnly
        ? 'Docs-only change; code Golden Path context is not needed.'
        : 'No relevant Failure Firewall risk signals or candidates were found.',
    riskSignals: features.riskSignals,
    changedFiles: features.changedFiles,
    goldenPathCandidates,
    failurePatternCandidates,
    suggestedUse: use,
    degradedReasons,
  };
}
