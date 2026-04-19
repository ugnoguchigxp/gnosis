import { detectGaps } from '../gap/detector';
import type { Knowledge } from '../knowledge/types';
import { type MergeRepository, mergeVerifiedKnowledge } from '../merge';
import { buildVerificationSummary, verifyEvidence } from '../verifier';
import type { FlowEvidence } from './types';

import type { FlowResult } from './result';

export type CronFlowRepository = MergeRepository & {
  getByTopic: (topic: string) => Promise<Knowledge | null>;
};

export type RunCronFlowInput = {
  topic: string;
  evidence: FlowEvidence;
  repository: CronFlowRepository;
  cronBudget: number;
  cronRunBudget: number;
  cronRunConsumed: number;
  now?: number;
};

export type RunCronFlowResult = FlowResult;

export const runCronFlow = async (input: RunCronFlowInput): Promise<RunCronFlowResult> => {
  const now = input.now ?? Date.now();
  const usedBudget = Math.max(0, Math.trunc(input.evidence.queryCountUsed ?? 0));

  if (usedBudget > input.cronBudget) {
    throw new Error(`CRON_BUDGET exceeded: used=${usedBudget}, limit=${input.cronBudget}`);
  }

  if (input.cronRunConsumed + usedBudget > input.cronRunBudget) {
    throw new Error(
      `CRON_RUN_BUDGET exceeded: used=${input.cronRunConsumed + usedBudget}, limit=${
        input.cronRunBudget
      }`,
    );
  }

  const existing = await input.repository.getByTopic(input.topic);
  const verification = verifyEvidence({
    topic: input.topic,
    claims: input.evidence.claims,
    sources: input.evidence.sources,
    now,
  });

  const gaps = detectGaps({
    topic: input.topic,
    knowledge: existing,
    verifierResult: verification,
    now,
  });

  const mergeResult = await mergeVerifiedKnowledge(input.repository, {
    topic: input.topic,
    acceptedClaims: verification.acceptedClaims,
    relations: input.evidence.relations ?? [],
    sources: input.evidence.normalizedSources ?? [],
  });

  return {
    summary: buildVerificationSummary(verification),
    changed: mergeResult.changed,
    usedBudget,
    runConsumedBudget: input.cronRunConsumed + usedBudget,
    acceptedClaims: verification.acceptedClaims.length,
    rejectedClaims: verification.rejectedClaims.length,
    conflicts: verification.conflicts.length,
    gaps: gaps.gaps,
  };
};
