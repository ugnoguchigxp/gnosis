import { z } from 'zod';

export const LlmTaskNameSchema = z.enum(['phrase_scout', 'research_note']);
export type LlmTaskName = z.infer<typeof LlmTaskNameSchema>;
