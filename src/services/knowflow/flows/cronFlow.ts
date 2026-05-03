import { detectGaps } from '../gap/detector';
import type { Knowledge } from '../knowledge/types';
import { type MergeRepository, mergeVerifiedKnowledge } from '../merge';
import { buildVerificationSummary, verifyEvidence } from '../verifier';
import type { EvidenceSource } from '../verifier';
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
  evaluateRegistration?: (input: {
    topic: string;
    acceptedClaims: Array<{ text: string; confidence: number; sourceIds: string[] }>;
    sources: EvidenceSource[];
    verifierSummary: string;
  }) => Promise<{ allow: boolean; reason: string; confidence: number }>;
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

  const defaultDecision = {
    allow: verification.acceptedClaims.length > 0,
    reason:
      verification.acceptedClaims.length > 0
        ? 'accepted claims exist'
        : 'no accepted claims from verifier',
    confidence: verification.acceptedClaims.length > 0 ? 0.55 : 0.9,
  };
  const decision = input.evaluateRegistration
    ? await input.evaluateRegistration({
        topic: input.topic,
        acceptedClaims: verification.acceptedClaims.map((claim) => ({
          text: claim.text,
          confidence: claim.confidence,
          sourceIds: claim.sourceIds ?? [],
        })),
        sources: input.evidence.sources,
        verifierSummary: buildVerificationSummary(verification),
      })
    : defaultDecision;

  const mergeResult = decision.allow
    ? await mergeVerifiedKnowledge(input.repository, {
        topic: input.topic,
        acceptedClaims: verification.acceptedClaims,
        relations: input.evidence.relations ?? [],
        sources: input.evidence.normalizedSources ?? [],
      })
    : { changed: false };

  return {
    summary: `${buildVerificationSummary(verification)}; registration=${
      decision.allow ? 'allow' : 'skip'
    } (${decision.reason})`,
    changed: mergeResult.changed,
    usedBudget,
    runConsumedBudget: input.cronRunConsumed + usedBudget,
    acceptedClaims: verification.acceptedClaims.length,
    rejectedClaims: verification.rejectedClaims.length,
    conflicts: verification.conflicts.length,
    gaps: gaps.gaps,
    registrationDecision: decision,
  };
};
