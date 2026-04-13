import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { config } from '../../config.js';
import { saveGuidance } from '../../services/guidance/index.js';
import type { ToolEntry } from '../registry.js';

const registerGuidanceSchema = z.object({
  title: z.string().describe('ガイダンスのタイトル'),
  content: z.string().describe('内容（マークダウン形式推奨）'),
  guidanceType: z
    .enum(['rule', 'skill'])
    .describe('種別 (rule: 規約・禁止事項, skill: 手順・ノウハウ)'),
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
      const result = await saveGuidance(input);
      return {
        content: [
          {
            type: 'text',
            text: `Guidance registered successfully: ${input.title} (archiveKey: ${result.archiveKey})`,
          },
        ],
      };
    },
  },
];
