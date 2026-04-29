import type { FailureFirewallMatch, FailureFirewallOutput } from './types.js';

function renderMatch(match: FailureFirewallMatch): string[] {
  const lines: string[] = [];
  lines.push(`### [${match.severity}] ${match.title}`);
  lines.push('');
  lines.push(match.rationale);
  lines.push('');
  lines.push(`- File: ${match.filePath}:${match.lineNew}`);
  lines.push(`- Decision: ${match.decision}`);
  lines.push(`- Confidence: ${match.confidence}`);
  lines.push(`- Deviation: ${match.deviationScore.toFixed(2)}`);
  lines.push(`- Recurrence: ${match.recurrenceScore.toFixed(2)}`);
  if (match.goldenPath) lines.push(`- Golden Path: ${match.goldenPath.title}`);
  if (match.failurePattern) lines.push(`- Failure Pattern: ${match.failurePattern.title}`);
  if (match.missingRequiredSteps.length > 0) {
    lines.push(`- Missing steps: ${match.missingRequiredSteps.join('; ')}`);
  }
  if (match.evidence.length > 0) {
    lines.push(`- Evidence: ${match.evidence.join('; ')}`);
  }
  if (match.suggestedAction) lines.push(`- Suggested action: ${match.suggestedAction}`);
  lines.push('');
  return lines;
}

export function renderFailureFirewallMarkdown(output: FailureFirewallOutput): string {
  const lines: string[] = [];
  lines.push('# Failure Firewall');
  lines.push('');
  lines.push('## Status');
  lines.push('');
  lines.push(output.status);
  lines.push('');

  if (output.degradedReasons.length > 0) {
    lines.push('## Degraded Mode');
    lines.push('');
    for (const reason of output.degradedReasons) lines.push(`- ${reason}`);
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  if (output.matches.length === 0) {
    lines.push('Golden Path 逸脱または再発リスクは検出されませんでした。');
  } else {
    lines.push(`${output.matches.length} 件の Golden Path 逸脱または再発候補を検出しました。`);
  }
  lines.push('');

  lines.push('## Metadata');
  lines.push('');
  lines.push(`- Mode: ${output.mode}`);
  lines.push(`- Reviewed files: ${output.metadata.reviewedFiles}`);
  lines.push(`- Risk signals: ${output.metadata.riskSignals.join(', ') || '(none)'}`);
  lines.push(`- Local LLM used: ${output.metadata.localLlmUsed ? 'yes' : 'no'}`);
  lines.push(`- Duration: ${output.metadata.durationMs}ms`);
  lines.push('');

  if (output.matches.length > 0) {
    lines.push('## Matches');
    lines.push('');
    for (const match of output.matches) lines.push(...renderMatch(match));
  }

  return lines.join('\n').trimEnd();
}
