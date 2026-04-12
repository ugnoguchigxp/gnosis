import { z } from 'zod';

export const LlmTaskNameSchema = z.enum([
  'hypothesis',
  'query_generation',
  'gap_detection',
  'gap_planner',
  'summarize',
  'extract_evidence',
]);

export type LlmTaskName = z.infer<typeof LlmTaskNameSchema>;

export const HypothesisItemSchema = z
  .object({
    id: z.string().min(1),
    hypothesis: z.string().min(1),
    rationale: z.string().min(1).optional(),
    priority: z.number().min(0).max(1).optional(),
  })
  .passthrough();

export const HypothesisOutputSchema = z
  .object({
    hypotheses: z.array(HypothesisItemSchema).default([]),
  })
  .passthrough();

export const QueryGenerationOutputSchema = z
  .object({
    queries: z.array(z.string().min(1)).default([]),
  })
  .passthrough();

export const GapTypeSchema = z.enum([
  'missing_definition',
  'missing_comparison',
  'missing_example',
  'missing_constraints',
  'weak_evidence',
  'outdated',
  'uncertain',
]);

export const GapSchema = z
  .object({
    type: GapTypeSchema,
    description: z.string().min(1),
    priority: z.number().min(0).max(1),
  })
  .passthrough();

export const GapDetectionOutputSchema = z
  .object({
    gaps: z.array(GapSchema).default([]),
  })
  .passthrough();

export const GapPlannerStepSchema = z
  .object({
    title: z.string().min(1),
    reason: z.string().min(1).optional(),
    queries: z.array(z.string().min(1)).default([]),
  })
  .passthrough();

export const GapPlannerOutputSchema = z
  .object({
    steps: z.array(GapPlannerStepSchema).default([]),
  })
  .passthrough();

export const SummarizeOutputSchema = z
  .object({
    summary: z.string(),
    findings: z.array(z.string()).default([]),
  })
  .passthrough();

export const ExtractEvidenceOutputSchema = z
  .object({
    claims: z
      .array(
        z.object({
          text: z.string().min(1),
          confidence: z.number().min(0).max(1),
        }),
      )
      .default([]),
    relations: z
      .array(
        z.object({
          type: z.enum(['related_to', 'compares_with', 'depends_on', 'used_for']),
          targetTopic: z.string().min(1),
          confidence: z.number().min(0).max(1),
        }),
      )
      .default([]),
  })
  .passthrough();

export type HypothesisOutput = z.infer<typeof HypothesisOutputSchema>;
export type QueryGenerationOutput = z.infer<typeof QueryGenerationOutputSchema>;
export type GapDetectionOutput = z.infer<typeof GapDetectionOutputSchema>;
export type GapPlannerOutput = z.infer<typeof GapPlannerOutputSchema>;
export type SummarizeOutput = z.infer<typeof SummarizeOutputSchema>;

export type LlmTaskOutputMap = {
  hypothesis: HypothesisOutput;
  query_generation: QueryGenerationOutput;
  gap_detection: GapDetectionOutput;
  gap_planner: GapPlannerOutput;
  summarize: SummarizeOutput;
  extract_evidence: z.infer<typeof ExtractEvidenceOutputSchema>;
};

const schemaMap: Record<LlmTaskName, z.ZodTypeAny> = {
  hypothesis: HypothesisOutputSchema,
  query_generation: QueryGenerationOutputSchema,
  gap_detection: GapDetectionOutputSchema,
  gap_planner: GapPlannerOutputSchema,
  summarize: SummarizeOutputSchema,
  extract_evidence: ExtractEvidenceOutputSchema,
};

export const parseLlmTaskOutput = <T extends LlmTaskName>(
  task: T,
  payload: unknown,
): LlmTaskOutputMap[T] => {
  return schemaMap[task].parse(payload) as LlmTaskOutputMap[T];
};

export const getTaskOutputHint = (task: LlmTaskName): string => {
  switch (task) {
    case 'hypothesis':
      return '{"hypotheses":[{"id":"h1","hypothesis":"...","rationale":"...","priority":0.7}]}';
    case 'query_generation':
      return '{"queries":["query 1","query 2"]}';
    case 'gap_detection':
      return '{"gaps":[{"type":"missing_example","description":"...","priority":0.7}]}';
    case 'gap_planner':
      return '{"steps":[{"title":"...","reason":"...","queries":["..."]}]}';
    case 'summarize':
      return '{"summary":"...","findings":["..."]}';
    case 'extract_evidence':
      return '{"claims":[{"text":"...","confidence":0.8}],"relations":[{"type":"related_to","targetTopic":"...","confidence":0.7}]}';
    default:
      return '{}';
  }
};
