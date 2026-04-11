import { detectGaps } from '../gap/detector';
import type { Knowledge } from '../knowledge/types';
import { type MergeRepository, mergeVerifiedKnowledge } from '../merge';
import { type ExplorationReport, buildExplorationReport } from '../report/explorationReport';
import { buildVerificationSummary, verifyEvidence } from '../verifier';
import type { FlowEvidence } from './types';

export type UserFlowRepository = MergeRepository & {
  getByTopic: (topic: string) => Promise<Knowledge | null>;
};

export type RunUserFlowInput = {
  topic: string;
  evidence: FlowEvidence;
  repository: UserFlowRepository;
  userBudget: number;
  now?: number;
};

export type RunUserFlowResult = {
  report: ExplorationReport;
  summary: string;
  changed: boolean;
  acceptedClaims: number;
  rejectedClaims: number;
  conflicts: number;
  gaps: number;
};

export const runUserFlow = async (input: RunUserFlowInput): Promise<RunUserFlowResult> => {
  const now = input.now ?? Date.now();
  const usedBudget = Math.max(0, Math.trunc(input.evidence.queryCountUsed ?? 0));
  if (usedBudget > input.userBudget) {
    throw new Error(`USER_BUDGET exceeded: used=${usedBudget}, limit=${input.userBudget}`);
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

  const report = buildExplorationReport({
    topic: input.topic,
    verification,
    gaps: gaps.gaps,
    budgetUsed: usedBudget,
    budgetLimit: input.userBudget,
    now,
  });

  return {
    report,
    summary: buildVerificationSummary(verification),
    changed: mergeResult.changed,
    acceptedClaims: verification.acceptedClaims.length,
    rejectedClaims: verification.rejectedClaims.length,
    conflicts: verification.conflicts.length,
    gaps: gaps.gaps.length,
  };
};
