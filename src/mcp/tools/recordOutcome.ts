import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { config } from '../../config.js';
import { recordOutcome } from '../../services/procedure.js';
import type { ToolEntry } from '../registry.js';

const taskResultSchema = z.object({
  taskId: z.string().describe('task の entity ID'),
  followed: z.boolean().describe('この task に従ったか'),
  succeeded: z.boolean().describe('結果は成功か'),
  note: z.string().optional().describe('何が起きたか（自由記述）'),
});

const improvementSchema = z.object({
  type: z.enum(['modify_task', 'add_task', 'add_precondition', 'add_constraint']),
  targetTaskId: z.string().optional().describe('modify_task / add_precondition の対象 task ID'),
  suggestion: z.string().describe('改善内容'),
});

const recordOutcomeSchema = z.object({
  goalId: z.string().describe('実行した goal の entity ID'),
  sessionId: z.string().optional().default(config.guidance.sessionId).describe('セッション ID'),
  taskResults: z.array(taskResultSchema).describe('各タスクの実行結果'),
  improvements: z.array(improvementSchema).optional().describe('改善提案（任意）'),
});

export const recordOutcomeTools: ToolEntry[] = [
  {
    name: 'record_outcome',
    description: `タスク実行結果を記録し、Graph の confidence を更新します。
① confidence 更新: followed × succeeded の組み合わせで各タスクを評価
② エピソード記録: 実行サマリを vibe_memories (episode) + entities プロキシとして保存
③ learned_from 関係を各タスクへ追加
④ 改善提案の適用: modify_task / add_task / add_precondition / add_constraint`,
    inputSchema: zodToJsonSchema(recordOutcomeSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = recordOutcomeSchema.parse(args);
      const result = await recordOutcome({
        goalId: input.goalId,
        sessionId: input.sessionId,
        taskResults: input.taskResults,
        improvements: input.improvements,
      });
      return {
        content: [
          {
            type: 'text',
            text: `Outcome recorded: ${result.updated} tasks updated, episodeId=${
              result.episodeId ?? 'none'
            }`,
          },
        ],
      };
    },
  },
];
