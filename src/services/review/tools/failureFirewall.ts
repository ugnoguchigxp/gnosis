import { lookupFailureFirewallContext } from '../../failureFirewall/context.js';
import type { ReviewerToolEntry } from './types.js';

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

export const lookupFailureFirewallContextToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'lookup_failure_firewall_context',
    description:
      '必要な場合だけ Golden Path / Failure Firewall context を取得します。汎用レビューではなく、再発リスクや Golden Path 逸脱の確認に限定して使います。',
    inputSchema: {
      type: 'object',
      properties: {
        taskGoal: { type: 'string' },
        diff: { type: 'string' },
        filePaths: { type: 'array', items: { type: 'string' } },
        maxCandidates: { type: 'integer', default: 5 },
      },
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    const maxCandidates = Number(args.maxCandidates ?? 5);
    const context = await lookupFailureFirewallContext({
      repoPath: ctx.repoPath,
      taskGoal: typeof args.taskGoal === 'string' ? args.taskGoal : undefined,
      rawDiff: typeof args.diff === 'string' ? args.diff : undefined,
      files: asStringArray(args.filePaths),
      maxGoldenPaths: maxCandidates,
      maxFailurePatterns: Math.min(maxCandidates, 3),
    });

    return JSON.stringify(
      {
        shouldUse: context.shouldUse,
        reason: context.reason,
        suggestedUse: context.suggestedUse,
        riskSignals: context.riskSignals,
        changedFiles: context.changedFiles,
        lessonCandidates: context.lessonCandidates.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          kind: candidate.kind,
          reason: candidate.reason,
          score: candidate.score,
          blocking: candidate.blocking,
        })),
        goldenPathCandidates: context.goldenPathCandidates.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          pathType: candidate.pathType,
          requiredSteps: candidate.requiredSteps,
          score: candidate.score,
        })),
        failurePatternCandidates: context.failurePatternCandidates.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          severity: candidate.severity,
          requiredEvidence: candidate.requiredEvidence,
          score: candidate.score,
        })),
        degradedReasons: context.degradedReasons,
      },
      null,
      2,
    );
  },
};
