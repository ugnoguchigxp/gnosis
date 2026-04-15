import { createHash } from 'node:crypto';
import type { Finding, NormalizedDiff, StaticAnalysisFinding } from '../types.js';

function normalizeFindingKey(
  finding: Pick<Finding, 'file_path' | 'line_new' | 'title' | 'category'>,
): string {
  return [
    finding.file_path,
    finding.line_new,
    finding.title.trim().toLowerCase(),
    finding.category,
  ].join('::');
}

export function validateFindingsFull(findings: Finding[], diffs: NormalizedDiff[]): Finding[] {
  const valid: Finding[] = [];

  for (const finding of findings) {
    const diff = diffs.find(
      (item) => item.filePath === finding.file_path || item.filePath.endsWith(finding.file_path),
    );
    if (!diff) continue;

    const lineOk = diff.hunks.some(
      (hunk) =>
        finding.line_new >= hunk.newStart && finding.line_new < hunk.newStart + hunk.newLines,
    );
    if (!lineOk) continue;

    if (finding.source === 'static_analysis') {
      valid.push(finding);
      continue;
    }

    const evidenceLooksRelated =
      !finding.evidence ||
      diff.hunks.some((hunk) =>
        hunk.lines.some(
          (line) =>
            line.content.trim() && finding.evidence.includes(line.content.trim().slice(0, 20)),
        ),
      );

    valid.push(
      evidenceLooksRelated
        ? finding
        : {
            ...finding,
            confidence: 'low',
            needsHumanConfirmation: true,
          },
    );
  }

  return valid;
}

export function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const deduped: Finding[] = [];

  for (const finding of findings) {
    const key = normalizeFindingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }

  return deduped;
}

function convertStaticFinding(finding: StaticAnalysisFinding): Finding {
  const fingerprint = createHash('sha256')
    .update(`${finding.file_path}:${finding.line ?? 0}:${finding.rule_id ?? finding.message}`)
    .digest('hex')
    .slice(0, 16);

  return {
    id: finding.id,
    title: finding.rule_id ? `${finding.rule_id}: ${finding.message}` : finding.message,
    severity: finding.severity,
    confidence: finding.source === 'tsc' ? 'high' : 'medium',
    file_path: finding.file_path,
    line_new: finding.line ?? 1,
    category: finding.rule_id?.toLowerCase().includes('test') ? 'test' : 'validation',
    rationale: finding.message,
    suggested_fix: undefined,
    evidence: finding.message,
    knowledge_refs: undefined,
    fingerprint,
    needsHumanConfirmation: false,
    source: 'static_analysis',
  };
}

export function mergeFindings(
  staticFindings: StaticAnalysisFinding[],
  llmFindings: Finding[],
): Finding[] {
  const merged: Finding[] = [];
  const consumed = new Set<string>();

  for (const staticFinding of staticFindings) {
    const staticKey = [
      staticFinding.file_path,
      staticFinding.line ?? 0,
      staticFinding.message.trim().toLowerCase(),
    ].join('::');
    if (consumed.has(staticKey)) continue;
    consumed.add(staticKey);
    merged.push({
      ...convertStaticFinding(staticFinding),
    });
  }

  for (const finding of llmFindings) {
    const conflict = staticFindings.find((staticFinding) => {
      if (staticFinding.file_path !== finding.file_path) return false;
      const line = staticFinding.line ?? 0;
      return Math.abs(line - finding.line_new) <= 2;
    });

    if (conflict) continue;

    const key = normalizeFindingKey(finding);
    if (consumed.has(key)) continue;
    consumed.add(key);
    merged.push(finding);
  }

  return merged;
}

export function staticFindingToFinding(finding: StaticAnalysisFinding): Finding {
  return convertStaticFinding(finding);
}
