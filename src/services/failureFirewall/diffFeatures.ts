import { countAddedLines, countRemovedLines, normalizeDiff } from '../review/diff/normalizer.js';
import { extractRiskSignals } from '../review/static/signals.js';
import type { NormalizedDiff } from '../review/types.js';
import type { FailureDiffFeatures, FailureDiffFileFeature } from './types.js';

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function getLines(diff: NormalizedDiff, type: 'added' | 'removed'): string[] {
  return diff.hunks
    .flatMap((hunk) => hunk.lines)
    .filter((line) => line.type === type)
    .map((line) => line.content);
}

function isDocsFile(filePath: string): boolean {
  return /\.(?:md|mdx|txt|rst)$/i.test(filePath);
}

function enrichFailureRiskSignals(baseSignals: string[], diffs: NormalizedDiff[]): string[] {
  const fullPatch = diffs
    .flatMap((diff) => diff.hunks.flatMap((hunk) => hunk.lines.map((line) => line.content)))
    .join('\n');
  const signals = new Set(
    baseSignals.filter(
      (signal) =>
        signal !== 'input_validation' ||
        /\b(req\.body|request\.json|params|searchParams|safeParse|z\.)\b/i.test(fullPatch),
    ),
  );

  for (const diff of diffs) {
    const added = getLines(diff, 'added').join('\n');
    const all = diff.hunks.flatMap((hunk) => hunk.lines.map((line) => line.content)).join('\n');

    if (/\buseMutation\b|\bmutationFn\b|\bmutateAsync\b|\bmutate\(/i.test(all)) {
      signals.add('cache_invalidation');
    }
    if (/\b(delete|truncate|drop)\b/i.test(all)) {
      signals.add('destructive_db_change');
      signals.add('deletion');
    }
    if (/\b(req\.body|request\.json|params|searchParams)\b/i.test(all)) {
      signals.add('input_validation');
    }
    if (/\b(auth|guard|permission|token|jwt|middleware)\b/i.test(`${diff.filePath}\n${all}`)) {
      signals.add('auth');
    }
    if (/\b(fetch|axios|http\.(?:get|post|put|patch|delete))\b/i.test(added)) {
      signals.add('external_api_error');
    }
  }

  return [...signals];
}

function buildPatchSummary(diffs: NormalizedDiff[], riskSignals: string[]): string {
  const files = diffs.map((diff) => diff.filePath).slice(0, 20);
  const languages = unique(diffs.map((diff) => diff.language)).filter(Boolean);
  return [
    `files=${files.join(',')}`,
    `languages=${languages.join(',')}`,
    `riskSignals=${riskSignals.join(',')}`,
    `added=${countAddedLines(diffs)}`,
    `removed=${countRemovedLines(diffs)}`,
  ].join('\n');
}

export function buildFailureDiffFeatures(rawDiff: string): FailureDiffFeatures {
  const normalizedDiffs = normalizeDiff(rawDiff);
  const riskSignals = enrichFailureRiskSignals(
    extractRiskSignals(normalizedDiffs),
    normalizedDiffs,
  );
  const files: FailureDiffFileFeature[] = normalizedDiffs.map((diff) => ({
    filePath: diff.filePath,
    language: diff.language,
    framework: diff.classification.framework,
    changeType: diff.changeType,
    addedLines: getLines(diff, 'added'),
    removedLines: getLines(diff, 'removed'),
    isDocsOnly: isDocsFile(diff.filePath),
    isTest: diff.classification.isTest,
    isConfig: diff.classification.isConfig,
    isMigration: diff.classification.isMigration,
  }));

  const docsOnly = files.length > 0 && files.every((file) => file.isDocsOnly);
  if (docsOnly) riskSignals.push('docs_only');

  return {
    rawDiff,
    files,
    normalizedDiffs,
    riskSignals: unique(riskSignals),
    languages: unique(files.map((file) => file.language)).filter(Boolean),
    frameworks: unique(
      files.map((file) => file.framework).filter((item): item is string => !!item),
    ),
    changedFiles: files.map((file) => file.filePath),
    addedLineCount: countAddedLines(normalizedDiffs),
    removedLineCount: countRemovedLines(normalizedDiffs),
    docsOnly,
    patchSummary: buildPatchSummary(normalizedDiffs, riskSignals),
  };
}
