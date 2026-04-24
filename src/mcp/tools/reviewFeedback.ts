import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { recordFeedback } from '../../services/review/knowledge/persister.js';
import type { ToolEntry } from '../registry.js';

const reviewFeedbackSchema = z.object({
  reviewCaseId: z.string().min(1).describe('レビューケースID（review_id）'),
  findingId: z.string().min(1).describe('finding の ID'),
  outcomeType: z
    .enum(['adopted', 'ignored', 'dismissed', 'resolved', 'pending'])
    .describe('フィードバック結果'),
  falsePositive: z
    .boolean()
    .optional()
    .default(false)
    .describe('false positive として判定されたか'),
  notes: z.string().optional().describe('補足ノート'),
  guidanceIds: z.array(z.string()).optional().describe('判断に関与した guidance archiveKey の一覧'),
});

export const reviewFeedbackTools: ToolEntry[] = [
  {
    name: 'record_review_feedback',
    description:
      'レビュー finding への採用/却下/誤検知フィードバックを記録します。精度改善と false positive 学習に利用されます。',
    inputSchema: zodToJsonSchema(reviewFeedbackSchema) as Record<string, unknown>,
    handler: async (args) => {
      const parsed = reviewFeedbackSchema.parse(args);
      await recordFeedback(parsed.reviewCaseId, parsed.findingId, parsed.outcomeType, {
        falsePositive: parsed.falsePositive,
        notes: parsed.notes,
        guidanceIds: parsed.guidanceIds,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Review feedback recorded: case=${parsed.reviewCaseId}, finding=${parsed.findingId}, outcome=${parsed.outcomeType}, falsePositive=${parsed.falsePositive}`,
          },
        ],
      };
    },
  },
];
