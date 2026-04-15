import { REVIEW_LIMITS, ReviewError } from '../errors.js';

function countChangedFiles(rawDiff: string): number {
  return (rawDiff.match(/^diff --git /gm) || []).length;
}

function countChangedLinesForFile(fileDiff: string): number {
  return fileDiff.split(/\r?\n/).filter((line) => {
    if (!line) return false;
    if (line.startsWith('+++') || line.startsWith('---')) return false;
    if (line.startsWith('@@') || line.startsWith('diff --git')) return false;
    return line.startsWith('+') || line.startsWith('-');
  }).length;
}

function splitFileDiffs(rawDiff: string): string[] {
  const sections = rawDiff.split(/^diff --git /gm);
  return sections
    .map((section) => section.trim())
    .filter(Boolean)
    .map((section) => `diff --git ${section}`);
}

export function enforceHardLimit(rawDiff: string): void {
  const lines = rawDiff.split(/\r?\n/);

  if (lines.length > REVIEW_LIMITS.MAX_DIFF_LINES) {
    throw new ReviewError(
      'E003',
      `Diff too large: ${lines.length} lines (limit: ${REVIEW_LIMITS.MAX_DIFF_LINES})`,
    );
  }

  const changedFiles = countChangedFiles(rawDiff);
  if (changedFiles > REVIEW_LIMITS.MAX_FILES) {
    throw new ReviewError(
      'E003',
      `Too many files: ${changedFiles} (limit: ${REVIEW_LIMITS.MAX_FILES})`,
    );
  }

  for (const fileDiff of splitFileDiffs(rawDiff)) {
    const changedLines = countChangedLinesForFile(fileDiff);
    if (changedLines > REVIEW_LIMITS.MAX_LINES_PER_FILE) {
      throw new ReviewError(
        'E003',
        `Too many changed lines in a file: ${changedLines} (limit: ${REVIEW_LIMITS.MAX_LINES_PER_FILE})`,
      );
    }
  }
}
