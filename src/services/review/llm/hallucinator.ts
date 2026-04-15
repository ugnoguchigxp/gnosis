import { createHash } from 'node:crypto';
import type { Finding } from '../types.js';

const ALLOWED_SEVERITIES = new Set<Finding['severity']>(['error', 'warning', 'info']);

export function extractFilePathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  const matches = diff.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm);

  for (const match of matches) {
    const path = match[2];
    if (path) {
      paths.add(path);
    }
  }

  return [...paths];
}

export function validateFindingsBasic(findings: Finding[], rawDiff: string): Finding[] {
  const diffFiles = new Set(extractFilePathsFromDiff(rawDiff));

  return findings.filter((finding) => {
    if (!finding.file_path || !diffFiles.has(finding.file_path)) {
      return false;
    }

    if (!ALLOWED_SEVERITIES.has(finding.severity)) {
      return false;
    }

    if (!finding.rationale?.trim()) {
      return false;
    }

    if (!Number.isFinite(finding.line_new) || finding.line_new <= 0) {
      return false;
    }

    if (!finding.title?.trim()) {
      return false;
    }

    return true;
  });
}

export function generateFingerprint(finding: Omit<Finding, 'fingerprint'>): string {
  const key = `${finding.file_path}:${finding.category}:${finding.evidence.slice(0, 100)}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}
