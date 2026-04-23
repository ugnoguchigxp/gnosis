import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  bufferFileChangedEvents,
  dispatchHookEvent,
  getLoadedHookRuleCount,
} from '../../hooks/service.js';
import type { ToolEntry } from '../registry.js';

const taskCheckpointSchema = z.object({
  event: z
    .enum(['segment', 'completed', 'failed'])
    .optional()
    .default('segment')
    .describe('hook event 種別。segment/completed/failed を指定'),
  traceId: z.string().optional().describe('同一タスク連鎖を識別する trace ID'),
  taskId: z.string().optional().describe('関連タスク ID'),
  runId: z.string().optional().describe('run log 相関キー'),
  taskMode: z.string().optional().describe('implementation/refactor などのモード'),
  changedFiles: z
    .array(z.string())
    .optional()
    .describe('変更ファイル一覧（指定時は自動検出を上書き）'),
  changedLines: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('変更行数（指定時は自動検出を上書き）'),
  reviewRequested: z.boolean().optional().describe('review要求の有無'),
  summary: z.string().optional().describe('完了・失敗時の要約'),
  failureReason: z.string().optional().describe('失敗時の理由'),
});

export const hookTools: ToolEntry[] = [
  {
    name: 'task_checkpoint',
    description:
      '実装区切り・完了・失敗を明示し、hook ルール（lint/typecheck/test/episode 化など）を発火します。',
    inputSchema: zodToJsonSchema(taskCheckpointSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = taskCheckpointSchema.parse(args);
      const hookEvent =
        input.event === 'completed'
          ? 'task.completed'
          : input.event === 'failed'
            ? 'task.failed'
            : 'task.segment.completed';
      if (input.changedFiles && input.changedFiles.length > 0) {
        await bufferFileChangedEvents({
          traceId: input.traceId,
          runId: input.runId,
          taskId: input.taskId,
          changedFiles: input.changedFiles,
          changedLines: input.changedLines,
          context: {
            taskMode: input.taskMode,
            reviewRequested: input.reviewRequested,
          },
          payload: {
            reason: 'task_checkpoint',
          },
        });
      }

      const result = await dispatchHookEvent({
        event: hookEvent,
        traceId: input.traceId,
        taskId: input.taskId,
        runId: input.runId,
        context: {
          taskMode: input.taskMode,
          changedFiles: input.changedFiles,
          changedLines: input.changedLines,
          reviewRequested: input.reviewRequested,
        },
        payload: {
          summary: input.summary,
          failureReason: input.failureReason,
        },
      });

      const summary = {
        traceId: result.traceId,
        eventId: result.eventId,
        blocked: result.blocked,
        warnings: result.warnings,
        guidance: result.guidance,
        riskTags: result.riskTags,
        candidateIds: result.candidateIds,
        executedRules: result.ruleResults.map((rule) => ({
          ruleId: rule.ruleId,
          status: rule.status,
          matched: rule.matched,
          reason: rule.reason,
        })),
        loadedRuleCount: getLoadedHookRuleCount(),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
        isError: result.blocked,
      };
    },
  },
];
