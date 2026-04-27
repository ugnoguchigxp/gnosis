import { z } from 'zod';

export const HookFailureStrategySchema = z.enum([
  'ignore',
  'soft_warn',
  'block_with_guidance',
  'block_progress',
]);
export type HookFailureStrategy = z.infer<typeof HookFailureStrategySchema>;

export const HookRuleConditionsSchema = z
  .object({
    project_type: z.string().min(1).optional(),
    changed_files_min: z.number().int().nonnegative().optional(),
    changed_lines_min: z.number().int().nonnegative().optional(),
    path_matches: z.array(z.string().min(1)).optional(),
    risk_tags_contains: z.array(z.string().min(1)).optional(),
    branch_pattern: z.string().min(1).optional(),
    task_mode: z.array(z.string().min(1)).optional(),
    review_requested: z.boolean().optional(),
    last_hook_result: z.string().min(1).optional(),
  })
  .strict();
export type HookRuleConditions = z.infer<typeof HookRuleConditionsSchema>;

export const RunCommandActionSchema = z
  .object({
    type: z.literal('run_command'),
    command: z.string().min(1),
    timeout_sec: z.number().int().positive().optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict();

export const EmitMonitorEventActionSchema = z
  .object({
    type: z.literal('emit_monitor_event'),
    event_name: z.string().min(1).optional(),
    include_output: z.boolean().optional(),
    include_duration: z.boolean().optional(),
    include_reason: z.boolean().optional(),
    include_summary: z.boolean().optional(),
    include_payload_summary: z.boolean().optional(),
  })
  .strict();

export const AddGuidanceActionSchema = z
  .object({
    type: z.literal('add_guidance'),
    guidance: z.string().min(1),
  })
  .strict();

export const TagRiskActionSchema = z
  .object({
    type: z.literal('tag_risk'),
    risk_tag: z.string().min(1),
  })
  .strict();

export const EnqueueReviewActionSchema = z
  .object({
    type: z.literal('enqueue_review'),
    review_profile: z.string().min(1).optional(),
    include: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const CreateLessonCandidateActionSchema = z
  .object({
    type: z.literal('create_lesson_candidate'),
    source: z.string().min(1).optional(),
    min_severity: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();

export const BlockProgressActionSchema = z
  .object({
    type: z.literal('block_progress'),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const SoftWarnActionSchema = z
  .object({
    type: z.literal('soft_warn'),
    message: z.string().min(1).optional(),
  })
  .strict();

export const HookActionSchema = z.discriminatedUnion('type', [
  RunCommandActionSchema,
  EmitMonitorEventActionSchema,
  AddGuidanceActionSchema,
  TagRiskActionSchema,
  EnqueueReviewActionSchema,
  CreateLessonCandidateActionSchema,
  BlockProgressActionSchema,
  SoftWarnActionSchema,
]);
export type HookAction = z.infer<typeof HookActionSchema>;

export const HookFailureHandlerSchema = z
  .object({
    strategy: HookFailureStrategySchema,
    guidance: z.string().min(1).optional(),
  })
  .strict();
export type HookFailureHandler = z.infer<typeof HookFailureHandlerSchema>;

export const HookRuleSchema = z
  .object({
    id: z.string().min(1),
    event: z.string().min(1),
    enabled: z.boolean().default(true),
    priority: z.number().int().default(100),
    conditions: HookRuleConditionsSchema.optional().default({}),
    actions: z.array(HookActionSchema).min(1),
    on_failure: HookFailureHandlerSchema.optional(),
  })
  .strict();
export type HookRule = z.infer<typeof HookRuleSchema>;

export type HookEventEnvelope = {
  eventId: string;
  event: string;
  traceId: string;
  runId?: string;
  taskId?: string;
  ts: string;
  payload?: Record<string, unknown>;
};

export type HookEventContext = {
  projectType?: string;
  changedFiles?: string[];
  changedLines?: number;
  riskTags?: string[];
  branchName?: string;
  taskMode?: string;
  reviewRequested?: boolean;
  lastHookResult?: string;
  cwd?: string;
};

export type HookRuleExecutionStatus = 'succeeded' | 'failed' | 'blocked' | 'skipped' | 'ignored';

export type HookActionExecution = {
  actionType: HookAction['type'];
  ok: boolean;
  durationMs: number;
  message?: string;
  output?: string;
  error?: string;
};

export type HookRuleExecutionResult = {
  ruleId: string;
  status: HookRuleExecutionStatus;
  matched: boolean;
  reason?: string;
  actions: HookActionExecution[];
  guidance: string[];
  warnings: string[];
  riskTagsAdded: string[];
  candidateIds: string[];
};

export type HookDispatchResult = {
  eventId: string;
  traceId: string;
  blocked: boolean;
  guidance: string[];
  warnings: string[];
  riskTags: string[];
  candidateIds: string[];
  ruleResults: HookRuleExecutionResult[];
};

export type HookExecutionStartResult = {
  started: boolean;
};

export interface HookExecutionRepository {
  tryStartExecution(input: {
    eventId: string;
    ruleId: string;
    traceId: string;
  }): Promise<HookExecutionStartResult>;
  completeExecution(input: {
    eventId: string;
    ruleId: string;
    status: 'succeeded' | 'failed' | 'blocked' | 'skipped';
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export const HookRulesDocumentSchema = z
  .object({
    hooks: z.array(HookRuleSchema).min(1),
  })
  .strict();
