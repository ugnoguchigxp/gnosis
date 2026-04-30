import { randomUUID } from 'node:crypto';
import { buildFailureDiffFeatures } from './diffFeatures.js';
import type {
  FailureFirewallLearningCandidate,
  FailureFirewallLearningCandidatesOutput,
  SuggestFailureFirewallLearningCandidatesInput,
} from './types.js';

function titleFromSignals(prefix: string, riskSignals: string[]): string {
  const label = riskSignals.slice(0, 3).join(', ') || 'code change';
  return `${prefix}: ${label}`;
}

function acceptedFindings(input: SuggestFailureFirewallLearningCandidatesInput) {
  return (input.reviewFindings ?? []).filter(
    (finding) =>
      finding.accepted === true &&
      (finding.severity === 'error' ||
        finding.severity === 'warning' ||
        finding.severity === 'critical' ||
        finding.severity === 'major'),
  );
}

export function suggestFailureFirewallLearningCandidates(
  input: SuggestFailureFirewallLearningCandidatesInput,
): FailureFirewallLearningCandidatesOutput {
  if (!input.verifyPassed) {
    return { candidates: [], skippedReason: 'verify_not_passed' };
  }
  if (!input.commitApprovedByUser) {
    return { candidates: [], skippedReason: 'commit_not_approved' };
  }
  if (!input.rawDiff.trim()) {
    return { candidates: [], skippedReason: 'empty_diff' };
  }

  const features = buildFailureDiffFeatures(input.rawDiff);
  if (features.docsOnly || features.riskSignals.length === 0) {
    return { candidates: [], skippedReason: 'no_failure_firewall_risk_signal' };
  }

  const successCandidateId = `ff-candidate-${randomUUID()}`;
  const candidates: FailureFirewallLearningCandidate[] = [
    {
      candidateId: successCandidateId,
      status: 'needs_review',
      sourceEvent: 'verified_commit_approval',
      verifyCommand: input.verifyCommand,
      commitApprovedByUser: true,
      successPattern: {
        kind: 'procedure',
        title: titleFromSignals('Verified Golden Path candidate', features.riskSignals),
        content: [
          'A verified implementation completed with the relevant gate passing.',
          `Verify command: ${input.verifyCommand}`,
          `Changed files: ${features.changedFiles.slice(0, 10).join(', ')}`,
          `Risk signals: ${features.riskSignals.join(', ')}`,
        ].join('\n'),
        goldenPath: {
          pathType: features.riskSignals[0] ?? 'verified_change',
          appliesWhen: features.riskSignals.map((signal) => `diff has ${signal}`),
          requiredSteps: [`Run and pass ${input.verifyCommand} before committing.`],
          allowedAlternatives: [],
          blockWhenMissing: [`Missing verified gate: ${input.verifyCommand}`],
          riskSignals: features.riskSignals,
        },
      },
    },
  ];

  for (const finding of acceptedFindings(input).slice(0, 2)) {
    candidates.push({
      candidateId: `ff-candidate-${randomUUID()}`,
      status: 'needs_review',
      sourceEvent: 'verified_commit_approval',
      verifyCommand: input.verifyCommand,
      commitApprovedByUser: true,
      failurePattern: {
        kind: 'lesson',
        title: titleFromSignals(`Accepted review finding: ${finding.title}`, features.riskSignals),
        content: [
          finding.title,
          finding.evidence,
          finding.filePath ? `File: ${finding.filePath}` : undefined,
          `Verify command after fix: ${input.verifyCommand}`,
        ]
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .join('\n'),
        failureFirewall: {
          patternType: features.riskSignals[0] ?? 'accepted_review_finding',
          severity:
            finding.severity === 'error' || finding.severity === 'critical' ? 'error' : 'warning',
          riskSignals: features.riskSignals,
          matchHints: [finding.title, finding.filePath].filter(
            (item): item is string => typeof item === 'string' && item.trim().length > 0,
          ),
          requiredEvidence: [finding.title],
          goldenPathCandidateId: successCandidateId,
        },
      },
    });
  }

  return { candidates: candidates.slice(0, 3) };
}
