import { z } from 'zod';
import type { DetectedGap } from '../gap/detector';
import type { VerifyEvidenceResult } from '../verifier';

export const ExplorationReportSchema = z
  .object({
    topic: z.string().min(1),
    generatedAt: z.number().int().nonnegative(),
    summary: z.string().min(1),
    acceptedClaims: z.array(z.string().min(1)).default([]),
    rejectedClaims: z.array(z.string().min(1)).default([]),
    conflicts: z.array(z.string().min(1)).default([]),
    gaps: z.array(
      z
        .object({
          type: z.string().min(1),
          priority: z.number().min(0).max(1),
          description: z.string().min(1),
        })
        .strict(),
    ),
    budget: z
      .object({
        used: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
        remaining: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type ExplorationReport = z.infer<typeof ExplorationReportSchema>;

export type BuildExplorationReportInput = {
  topic: string;
  verification: VerifyEvidenceResult;
  gaps: DetectedGap[];
  budgetUsed: number;
  budgetLimit: number;
  now?: number;
};

export const buildExplorationReport = (input: BuildExplorationReportInput): ExplorationReport => {
  const now = input.now ?? Date.now();
  const remaining = Math.max(0, input.budgetLimit - input.budgetUsed);

  const summary = [
    `Accepted ${input.verification.acceptedClaims.length} claims`,
    `rejected ${input.verification.rejectedClaims.length}`,
    `conflicts ${input.verification.conflicts.length}`,
    `gaps ${input.gaps.length}`,
  ].join(', ');

  return ExplorationReportSchema.parse({
    topic: input.topic,
    generatedAt: now,
    summary,
    acceptedClaims: input.verification.acceptedClaims.map((claim) => claim.text),
    rejectedClaims: input.verification.rejectedClaims.map((item) => item.claim.text),
    conflicts: input.verification.conflicts.map(
      (conflict) => `${conflict.leftClaim} <> ${conflict.rightClaim}`,
    ),
    gaps: input.gaps.map((gap) => ({
      type: gap.type,
      priority: gap.priority,
      description: gap.description,
    })),
    budget: {
      used: input.budgetUsed,
      limit: input.budgetLimit,
      remaining,
    },
  });
};
