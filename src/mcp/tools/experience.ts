import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { recallExperienceLessons, saveExperience } from '../../services/experience.js';
import type { ToolEntry } from '../registry.js';

const recordExperienceSchema = z.object({
  sessionId: z
    .string()
    .describe(
      'セッションID。プロジェクト名や作業コンテキスト（例: "auth-refactoring"）を指定して教訓をグループ化します。',
    ),
  scenarioId: z
    .string()
    .optional()
    .default('manual-record')
    .describe('シナリオID。特定のテストケースや自動実行以外では省略可能です。'),
  attempt: z
    .number()
    .int()
    .positive()
    .optional()
    .default(1)
    .describe('試行回数。手動記録の場合は省略可能です。'),
  type: z
    .enum(['failure', 'success'])
    .describe(
      'イベントのタイプ。想定外の挙動やエラーは "failure"、解決策や成功した手順は "success" を指定します。',
    ),
  content: z
    .string()
    .describe(
      'イベントの内容。失敗メッセージ、エラーログ、または解決策の詳細を具体的に記述します。',
    ),
  failureType: z.string().optional().describe('失敗のタイプ (e.g., RISK_BLOCKING)'),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe('追加のメタデータ (riskFindings, applyRejects, patchDigest など)'),
});

const recallLessonsSchema = z.object({
  sessionId: z.string().describe('検索対象のセッションID'),
  query: z.string().describe('現在の失敗状況やエラーメッセージ'),
  limit: z.number().int().positive().optional().default(5).describe('取得件数'),
});

export const experienceTools: ToolEntry[] = [
  {
    name: 'record_experience',
    description:
      'llmharness のシナリオ実行で生じた失敗・成功イベントを、構造化された教訓として記録します。',
    inputSchema: zodToJsonSchema(recordExperienceSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = recordExperienceSchema.parse(args);
      saveExperience(input).catch((err) => {
        console.error('Background record_experience failed:', err);
      });
      return {
        content: [
          {
            type: 'text',
            text: `Experience record request accepted for session: ${input.sessionId}. It will be processed in the background.`,
          },
        ],
      };
    },
  },
  {
    name: 'recall_lessons',
    description:
      'llmharness のパイプライン実行中に失敗した際、過去の類似失敗から解決策・教訓を検索します。',
    inputSchema: zodToJsonSchema(recallLessonsSchema) as Record<string, unknown>,
    handler: async (args) => {
      const { sessionId, query, limit } = recallLessonsSchema.parse(args);
      const results = await recallExperienceLessons(sessionId, query, limit);
      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      };
    },
  },
];
