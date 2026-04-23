import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { config } from '../../config.js';
import { saveGuidance } from '../../services/guidance/index.js';
import type { ToolEntry } from '../registry.js';

const registerGuidanceSchema = z.object({
  title: z.string().describe('ガイダンスのタイトル'),
  content: z.string().describe('内容（マークダウン形式推奨）'),
  guidanceType: z
    .enum(['rule', 'skill', 'goal'])
    .describe('種別 (rule: 規約・禁止事項, skill: 手順・ノウハウ, goal: 達成目標)'),
  scope: z
    .enum(['always', 'on_demand'])
    .describe('適用範囲 (always: 常に参照, on_demand: 必要時のみ検索)'),
  priority: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .default(config.guidance.priorityLow)
    .describe('優先度 (0-100)'),
  tags: z.array(z.string()).optional().describe('関連タグ'),
  applicability: z
    .object({
      signals: z.array(z.string()).optional(),
      fileTypes: z.array(z.string()).optional(),
      languages: z.array(z.string()).optional(),
      frameworks: z.array(z.string()).optional(),
      excludedFrameworks: z.array(z.string()).optional(),
      projects: z.array(z.string()).optional(),
      domains: z.array(z.string()).optional(),
      environments: z.array(z.string()).optional(),
      repos: z.array(z.string()).optional(),
      excludes: z
        .object({
          signals: z.array(z.string()).optional(),
          fileTypes: z.array(z.string()).optional(),
          languages: z.array(z.string()).optional(),
          frameworks: z.array(z.string()).optional(),
          projects: z.array(z.string()).optional(),
          domains: z.array(z.string()).optional(),
          environments: z.array(z.string()).optional(),
          repos: z.array(z.string()).optional(),
          paths: z.array(z.string()).optional(),
        })
        .optional()
        .describe('除外条件'),
    })
    .optional()
    .describe('構造化された適用条件'),
  validationCriteria: z.array(z.string()).optional().describe('検証基準（チェックリスト）'),
  dependsOn: z.array(z.string()).optional().describe('依存する他のガイダンスのタイトルまたはID'),
  archiveKey: z.string().optional().describe('管理用キー (省略時はタイトルから自動生成)'),
  sessionId: z.string().optional().describe('セッションID (デフォルト: config.guidance.sessionId)'),
});

export const guidanceTools: ToolEntry[] = [
  {
    name: 'register_guidance',
    description:
      '新しいルールやスキルを Gnosis Guidance Registry に登録します。登録された内容は AI アシスタントへの指示（プロンプト）に自動挿入されるようになります。',
    inputSchema: zodToJsonSchema(registerGuidanceSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = registerGuidanceSchema.parse(args);
      saveGuidance(input).catch((err) => {
        console.error('Background register_guidance failed:', err);
      });
      return {
        content: [
          {
            type: 'text',
            text: `Guidance registration request accepted for: ${input.title}. It will be processed in the background.`,
          },
        ],
      };
    },
  },
];
