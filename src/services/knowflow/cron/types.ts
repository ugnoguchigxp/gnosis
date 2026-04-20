import { z } from 'zod';
import { KeywordEvalAliasSchema } from '../../../config.js';

export const KeywordSourceTypeSchema = z.enum(['episode', 'experience']);
export type KeywordSourceType = z.infer<typeof KeywordSourceTypeSchema>;

export const KeywordEvaluationItemSchema = z
  .object({
    topic: z.string().min(1),
    category: z.string().min(1),
    why_research: z.string().min(1),
    search_score: z.number().min(0).max(10),
    term_difficulty_score: z.number().min(0).max(10),
    uncertainty_score: z.number().min(0).max(10),
  })
  .strict();

export type KeywordEvaluationItem = z.infer<typeof KeywordEvaluationItemSchema>;

/** Alias for KeywordEvaluationItem to match implementation plan naming */
export type KeywordEvaluation = KeywordEvaluationItem;

/** Alias for KeywordSource to match implementation plan naming */
export type KeywordCandidate = KeywordSource;

export const KeywordEvaluationResponseSchema = z
  .object({
    items: z.array(KeywordEvaluationItemSchema).default([]),
  })
  .strict();

export type KeywordEvaluationResponse = z.infer<typeof KeywordEvaluationResponseSchema>;

export const KeywordEvaluationDecisionSchema = z.enum(['enqueued', 'skipped']);
export type KeywordEvaluationDecision = z.infer<typeof KeywordEvaluationDecisionSchema>;

export const KeywordSourceSchema = z
  .object({
    sourceType: KeywordSourceTypeSchema,
    sourceId: z.string().min(1),
    content: z.string().min(1),
    createdAt: z.date(),
  })
  .strict();

export type KeywordSource = z.infer<typeof KeywordSourceSchema>;

export const KeywordEvaluationRowSchema = z
  .object({
    runId: z.string().uuid(),
    sourceType: KeywordSourceTypeSchema,
    sourceId: z.string().min(1),
    topic: z.string().min(1),
    category: z.string().min(1),
    whyResearch: z.string().min(1),
    searchScore: z.number().min(0).max(10),
    termDifficultyScore: z.number().min(0).max(10),
    uncertaintyScore: z.number().min(0).max(10),
    threshold: z.number().min(0).max(10),
    decision: KeywordEvaluationDecisionSchema,
    enqueuedTaskId: z.string().uuid().optional(),
    modelAlias: KeywordEvalAliasSchema,
    createdAt: z.date().optional(),
  })
  .strict();

export type KeywordEvaluationRow = z.infer<typeof KeywordEvaluationRowSchema>;

export const KeywordSeederRunResultSchema = z
  .object({
    runId: z.string().uuid(),
    aliasUsed: KeywordEvalAliasSchema,
    fallbackAliasUsed: KeywordEvalAliasSchema.optional(),
    threshold: z.number().min(0).max(10),
    sources: z.number().int().nonnegative(),
    evaluated: z.number().int().nonnegative(),
    enqueued: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    deduped: z.number().int().nonnegative(),
    sourceFailures: z.number().int().nonnegative(),
  })
  .strict();

export type KeywordSeederRunResult = z.infer<typeof KeywordSeederRunResultSchema>;

export const normalizeTopic = (topic: string): string =>
  topic
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\u3000\t\r\n]+/g, ' ');

export const truncate = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars))}\n...[truncated]`;
};
