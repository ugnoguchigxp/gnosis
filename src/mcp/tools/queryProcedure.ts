import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { queryProcedure } from '../../services/procedure.js';
import type { ToolEntry } from '../registry.js';

const queryProcedureSchema = z.object({
  goal: z.string().describe('達成したい目標（テキスト）'),
  context: z.string().optional().describe('現在の状況・条件（テキスト、任意）'),
});

export const queryProcedureTools: ToolEntry[] = [
  {
    name: 'query_procedure',
    description: `達成したい目標に対して、Graph から関連タスク・制約・エピソードを取得します。
- goal テキストから類似する goal エンティティを検索
- has_step 関係でタスクを収集（最大3ホップ）
- precondition / follows でトポロジカルソート
- learned_from で関連エピソードを取得
- prohibits で制約を収集
- context が指定されれば、when 関係で適切なタスクのみに絞り込み`,
    inputSchema: zodToJsonSchema(queryProcedureSchema) as Record<string, unknown>,
    handler: async (args) => {
      const { goal, context } = queryProcedureSchema.parse(args);
      const result = await queryProcedure(goal, context);
      if (!result) {
        return {
          content: [{ type: 'text', text: `No procedure found for goal: "${goal}"` }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  },
];
