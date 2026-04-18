import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const TaskModeSchema = z.enum(['directed', 'expand', 'explore']);
export const TaskSourceSchema = z.enum(['user', 'cron']);
export const TaskStatusSchema = z.enum(['pending', 'running', 'done', 'failed', 'deferred']);

export type TaskMode = z.infer<typeof TaskModeSchema>;
export type TaskSource = z.infer<typeof TaskSourceSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TopicTaskSchema = z
  .object({
    id: z.string().min(1),
    topic: z.string().min(1),
    mode: TaskModeSchema,
    source: TaskSourceSchema,

    priority: z.number().min(1),
    status: TaskStatusSchema,

    dedupeKey: z.string().min(1),
    requestedBy: z.string().min(1).optional(),

    attempts: z.number().int().nonnegative(),
    errorReason: z.string().min(1).optional(),

    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    lockedAt: z.number().int().nonnegative().optional(),
    lockOwner: z.string().min(1).optional(),
    nextRunAt: z.number().int().nonnegative().optional(),

    resultSummary: z.string().min(1).optional(),
    evaluation: z
      .object({
        category: z.string().min(1),
        whyResearch: z.string().min(1),
        searchScore: z.number().min(0).max(10),
        termDifficultyScore: z.number().min(0).max(10),
        uncertaintyScore: z.number().min(0).max(10),
        scoreEvaluatedAt: z.string().min(1),
      })
      .optional(),
  })
  .strict();

export type TopicTask = z.infer<typeof TopicTaskSchema>;

export const CreateTaskInputSchema = z
  .object({
    topic: z.string().min(1),
    mode: TaskModeSchema.default('directed'),
    source: TaskSourceSchema.default('user'),
    priority: z.number().min(1).optional(),
    requestedBy: z.string().min(1).optional(),
    sourceGroup: z.string().min(1).optional(),
    evaluation: z
      .object({
        category: z.string().min(1),
        whyResearch: z.string().min(1),
        searchScore: z.number().min(0).max(10),
        termDifficultyScore: z.number().min(0).max(10),
        uncertaintyScore: z.number().min(0).max(10),
        scoreEvaluatedAt: z.string().min(1),
      })
      .optional(),
  })
  .strict();

export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const normalizeTopic = (topic: string): string =>
  topic.trim().toLowerCase().replace(/\s+/g, ' ');

export const createDedupeKey = (
  topic: string,
  mode: TaskMode,
  source: TaskSource,
  sourceGroup?: string,
): string => {
  const group = sourceGroup?.trim().toLowerCase() || source;
  return `${normalizeTopic(topic)}:${mode}:${group}`;
};

export const defaultPriorityForSource = (source: TaskSource): number =>
  source === 'user' ? 100 : 10;

export const createTask = (input: CreateTaskInput, now = Date.now()): TopicTask => {
  const parsed = CreateTaskInputSchema.parse(input);
  const dedupeKey = createDedupeKey(parsed.topic, parsed.mode, parsed.source, parsed.sourceGroup);

  return TopicTaskSchema.parse({
    id: randomUUID(),
    topic: parsed.topic.trim(),
    mode: parsed.mode,
    source: parsed.source,
    priority: parsed.priority ?? defaultPriorityForSource(parsed.source),
    status: 'pending',
    dedupeKey,
    requestedBy: parsed.requestedBy,
    evaluation: parsed.evaluation,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });
};
