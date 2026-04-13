import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { recallExperienceLessons, saveExperience } from '../../services/experience.js';
import type { ToolEntry } from '../registry.js';

const recordExperienceSchema = z.object({
  sessionId: z.string().describe('セッションID'),
  scenarioId: z.string().describe('シナリオID (e.g., smoke-001)'),
  attempt: z.number().int().positive().describe('試行回数'),
  type: z.enum(['failure', 'success']).describe('イベントのタイプ (failure or success)'),
  content: z.string().describe('イベントの内容 (失敗メッセージや成功パッチの説明)'),
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
      const experience = await saveExperience(input);
      return {
        content: [
          {
            type: 'text',
            text: `Experience recorded successfully with ID: ${experience.id}`,
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
