import { z } from 'zod';

export const KeywordSourceTypeSchema = z.enum(['experience']);
export type KeywordSourceType = z.infer<typeof KeywordSourceTypeSchema>;

/** Alias for KeywordSource to match implementation plan naming */
export type KeywordCandidate = KeywordSource;

export const KeywordSourceSchema = z
  .object({
    sourceType: KeywordSourceTypeSchema,
    sourceId: z.string().min(1),
    content: z.string().min(1),
    createdAt: z.date(),
  })
  .strict();

export type KeywordSource = z.infer<typeof KeywordSourceSchema>;

export const KeywordSeederRunResultSchema = z
  .object({
    runId: z.string().uuid(),
    sources: z.number().int().nonnegative(),
    phrases: z.number().int().nonnegative(),
    enqueued: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    deduped: z.number().int().nonnegative(),
  })
  .strict();

export type KeywordSeederRunResult = z.infer<typeof KeywordSeederRunResultSchema>;

export const truncate = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars))}\n...[truncated]`;
};
