import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { config } from '../../config.js';
import { saveGuidance } from '../../services/guidance/index.js';
import { getGuidanceMetrics, runAutoPromotion } from '../../services/review/knowledge/evolution.js';
import type { ToolEntry } from '../registry.js';

const guidanceCandidateSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  guidanceType: z.enum(['rule', 'skill']),
  scope: z.enum(['always', 'on_demand']),
  tags: z.array(z.string()).optional(),
  validationCriteria: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
});

const applyGuidanceCandidatesSchema = z.object({
  candidates: z.array(guidanceCandidateSchema).min(1).describe('review_document で得た候補一覧'),
  sessionId: z.string().optional().describe('保存先の guidance セッションID'),
  priority: z.number().int().min(0).max(100).optional().describe('優先度（候補共通）'),
});

const guidanceMetricsSchema = z.object({
  guidanceId: z.string().min(1).describe('評価対象 guidance の archiveKey'),
});

export const reviewGuidanceTools: ToolEntry[] = [
  {
    name: 'apply_guidance_candidates',
    description:
      'review_document の guidanceCandidates を人手承認後に Guidance Registry へ反映します。',
    inputSchema: zodToJsonSchema(applyGuidanceCandidatesSchema) as Record<string, unknown>,
    handler: async (args) => {
      const parsed = applyGuidanceCandidatesSchema.parse(args);
      const priority = parsed.priority ?? config.guidance?.priorityLow ?? 50;
      const sessionId = parsed.sessionId ?? config.guidance.sessionId;

      const applied: Array<{ title: string; id: string; archiveKey: string }> = [];
      for (const candidate of parsed.candidates) {
        const saved = await saveGuidance({
          title: candidate.title,
          content: candidate.content,
          guidanceType: candidate.guidanceType,
          scope: candidate.scope,
          priority,
          tags: candidate.tags,
          validationCriteria: candidate.validationCriteria,
          dependsOn: candidate.dependsOn,
          sessionId,
        });
        applied.push({ title: candidate.title, id: saved.id, archiveKey: saved.archiveKey });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                appliedCount: applied.length,
                sessionId,
                items: applied,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  },
  {
    name: 'get_guidance_effectiveness',
    description:
      'guidance の採用率/false positive率を返します。再発指摘や品質劣化の監視に使います。',
    inputSchema: zodToJsonSchema(guidanceMetricsSchema) as Record<string, unknown>,
    handler: async (args) => {
      const parsed = guidanceMetricsSchema.parse(args);
      const metrics = await getGuidanceMetrics(parsed.guidanceId);
      return {
        content: [{ type: 'text', text: JSON.stringify(metrics, null, 2) }],
      };
    },
  },
  {
    name: 'run_guidance_autopromotion',
    description:
      'review_outcomes の履歴から guidance 候補を昇格/降格します（自動学習ループの定期運用向け）。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const result = await runAutoPromotion();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  },
];
