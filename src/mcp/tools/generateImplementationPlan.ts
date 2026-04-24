import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { generateImplementationPlan } from '../../services/specAgent/implementationPlanner.js';
import type { ToolEntry } from '../registry.js';

const generateImplementationPlanSchema = z.object({
  goal: z.string().min(1).describe('達成したい目標（実装計画の入力）'),
  context: z.string().optional().describe('現在の状況・制約（任意）'),
  project: z.string().optional().describe('対象プロジェクト名（任意）'),
  domains: z.array(z.string()).optional().describe('対象ドメイン（任意）'),
  languages: z.array(z.string()).optional().describe('対象言語（任意）'),
  frameworks: z.array(z.string()).optional().describe('対象フレームワーク（任意）'),
  environment: z.string().optional().describe('実行環境（任意）'),
  repo: z.string().optional().describe('対象リポジトリ（任意）'),
  sessionId: z.string().optional().describe('lessons 検索用セッションID（任意）'),
  lessonQuery: z.string().optional().describe('lessons 検索クエリ（任意）'),
  includeLessons: z.boolean().optional().default(true).describe('経験教訓を計画へ含めるか'),
});

export const generateImplementationPlanTools: ToolEntry[] = [
  {
    name: 'generate_implementation_plan',
    description:
      'query_procedure と recall_lessons を束ねて、実行前レビュー向けの implementation plan を生成します。',
    inputSchema: zodToJsonSchema(generateImplementationPlanSchema) as Record<string, unknown>,
    handler: async (args) => {
      const parsed = generateImplementationPlanSchema.parse(args);
      const plan = await generateImplementationPlan(parsed);

      if (!plan) {
        return {
          content: [{ type: 'text', text: `No procedure found for goal: "${parsed.goal}"` }],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                goal: plan.goal,
                tasks: plan.tasks,
                constraints: plan.constraints,
                lessons: plan.lessons,
                reviewChecklist: plan.reviewChecklist,
                markdown: plan.markdown,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  },
];
