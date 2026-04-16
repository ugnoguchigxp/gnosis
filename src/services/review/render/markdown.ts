import type { Finding, ReviewOutput } from '../types.js';

function groupBy<T, K extends string>(items: T[], selector: (item: T) => K): Record<K, T[]> {
  return items.reduce(
    (acc, item) => {
      const key = selector(item);
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(item);
      return acc;
    },
    {} as Record<K, T[]>,
  );
}
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderFixSuggestions(lines: string[], result: ReviewOutput): void {
  if (!result.fix_suggestions?.length) return;

  lines.push('## 🔧 Fix Suggestions');
  lines.push('');
  for (const fix of result.fix_suggestions) {
    lines.push(`#### ${fix.findingId} (confidence: ${fix.confidence})`);
    lines.push('```diff');
    lines.push(fix.diff);
    lines.push('```');
    lines.push('');
  }
}

function renderFindings(lines: string[], result: ReviewOutput): void {
  const order: Array<Finding['severity']> = ['error', 'warning', 'info'];
  const icons: Record<Finding['severity'], string> = {
    error: '🔴',
    warning: '🟡',
    info: 'ℹ️',
  };

  const groupedBySeverity = groupBy(result.findings, (finding) => finding.severity);

  for (const severity of order) {
    const severityFindings = groupedBySeverity[severity] ?? [];
    if (severityFindings.length === 0) continue;

    lines.push(`## ${icons[severity]} ${titleCase(severity)} (${severityFindings.length})`);
    lines.push('');

    const groupedByFile = groupBy(severityFindings, (finding) => finding.file_path);
    for (const [file, fileFindings] of Object.entries(groupedByFile)) {
      lines.push(`### ${file}`);
      lines.push('');

      for (const finding of fileFindings) {
        lines.push(`#### Line ${finding.line_new}: ${finding.title}`);
        lines.push(
          `**Category**: ${finding.category} | **Confidence**: ${finding.confidence}${
            finding.needsHumanConfirmation ? ' | ⚠️ 要確認' : ''
          }`,
        );
        lines.push(`**Source**: ${finding.source}`);
        lines.push('');
        lines.push(finding.rationale);
        lines.push('');

        if (finding.evidence) {
          lines.push('**Evidence**:');
          lines.push('```');
          lines.push(finding.evidence);
          lines.push('```');
          lines.push('');
        }

        if (finding.suggested_fix) {
          lines.push('**Suggested Fix**:');
          lines.push('```');
          lines.push(finding.suggested_fix);
          lines.push('```');
          lines.push('');
        }
      }
    }
  }
}

function renderKpis(lines: string[], result: ReviewOutput): void {
  if (!result.review_kpis) return;

  lines.push('## KPI Snapshot');
  lines.push('');
  lines.push(`- Reviews: ${result.review_kpis.totalReviews}`);
  lines.push(`- Findings: ${result.review_kpis.totalFindings}`);
  lines.push(`- Precision: ${(result.review_kpis.precisionRate * 100).toFixed(1)}%`);
  lines.push(`- False positives: ${(result.review_kpis.falsePositiveRate * 100).toFixed(1)}%`);
  lines.push(
    `- Knowledge contribution: ${(result.review_kpis.knowledgeContributionRate * 100).toFixed(1)}%`,
  );
  lines.push(`- Zero FP days: ${result.review_kpis.zeroFpDays}`);
  lines.push('');
}

export function renderReviewMarkdown(result: ReviewOutput): string {
  const lines: string[] = [];

  lines.push('# Code Review Results');
  lines.push('');

  if (result.metadata.degraded_mode) {
    lines.push('> ⚠️ **Degraded Mode**: 一部機能が利用不可のためレビュー範囲が制限されています');
    for (const reason of result.metadata.degraded_reasons) {
      lines.push(`> - ${reason}`);
    }
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push(result.summary || 'No summary provided.');
  lines.push('');

  lines.push('## Metadata');
  lines.push('');
  lines.push(`- Reviewed files: ${result.metadata.reviewed_files}`);
  lines.push(`- Risk level: **${result.metadata.risk_level}**`);
  lines.push(`- Static analysis: ${result.metadata.static_analysis_used ? '✅' : '❌ (not run)'}`);
  const llmLabel = result.metadata.local_llm_used
    ? 'local'
    : result.metadata.heavy_llm_used
      ? 'cloud'
      : 'unknown';
  lines.push(
    `- LLM: ${llmLabel}${
      result.metadata.heavy_llm_used && result.metadata.local_llm_used ? ' (cloud path used)' : ''
    }`,
  );
  if (result.metadata.knowledge_applied.length > 0) {
    lines.push(`- Knowledge applied: ${result.metadata.knowledge_applied.join(', ')}`);
  }
  lines.push('');

  renderFixSuggestions(lines, result);

  if (result.findings.length === 0) {
    lines.push('## No Major Issues Found');
    lines.push('');
    lines.push('重大な問題は検出されませんでした。ただし、このレビューは LLM 補助によるものです。');
  } else {
    renderFindings(lines, result);
  }

  renderKpis(lines, result);

  if (result.next_actions.length > 0) {
    lines.push('## Next Actions');
    lines.push('');
    for (const action of result.next_actions) {
      lines.push(`- ${action}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
