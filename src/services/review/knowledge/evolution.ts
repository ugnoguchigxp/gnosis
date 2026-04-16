import { sql } from 'drizzle-orm';
import { config } from '../../../config.js';
import { db } from '../../../db/index.js';
import { reviewOutcomes, vibeMemories } from '../../../db/schema.js';
import { saveGuidance } from '../../guidance/register.js';

export interface GuidanceCandidate {
  type: 'pattern' | 'heuristic';
  title: string;
  content: string;
  tags: string[];
  evidenceReviewIds: string[];
  supportCount: number;
  adoptionRate: number;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function extractPatternCandidates(): Promise<GuidanceCandidate[]> {
  const result = (await db.execute(sql`
    SELECT
      vm.metadata->>'category' AS category,
      vm.metadata->>'filePath' AS file_path,
      COUNT(*) AS total_count,
      SUM(CASE WHEN ro.outcome_type = 'adopted' THEN 1 ELSE 0 END) AS adopted_count,
      ARRAY_AGG(DISTINCT ro.review_case_id) AS review_ids,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT guidance_id), NULL) AS guidance_ids
    FROM review_outcomes ro
    JOIN vibe_memories vm
      ON vm.metadata->>'reviewCaseId' = ro.review_case_id
    LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(vm.metadata->'guidanceRefs', '[]'::jsonb)) AS guidance_id ON true
    WHERE ro.outcome_type IN ('adopted', 'ignored', 'dismissed')
    GROUP BY vm.metadata->>'category', vm.metadata->>'filePath'
    HAVING COUNT(*) >= 3
      AND SUM(CASE WHEN ro.outcome_type = 'adopted' THEN 1 ELSE 0 END)::float / COUNT(*) >= 0.6
    ORDER BY adopted_count DESC
    LIMIT 20
  `)) as { rows: Array<Record<string, unknown>> };

  return result.rows.map((row) => {
    const totalCount = toNumber(row.total_count);
    const adoptedCount = toNumber(row.adopted_count);
    const category = String(row.category ?? 'maintainability');
    const filePath = String(row.file_path ?? '任意ファイル');
    const guidanceIds = toStringArray(row.guidance_ids);

    const type =
      category === 'maintainability' || category === 'test' || category === 'validation'
        ? 'heuristic'
        : 'pattern';

    return {
      type,
      title: `[候補] 繰り返し採用: ${category} (${filePath})`,
      content: `採用率: ${((adoptedCount / Math.max(totalCount, 1)) * 100).toFixed(
        0,
      )}% (${adoptedCount}/${totalCount}件)\n関連Guidance: ${
        guidanceIds.length > 0 ? guidanceIds.join(', ') : 'なし'
      }`,
      tags: [category, filePath],
      evidenceReviewIds: toStringArray(row.review_ids),
      supportCount: totalCount,
      adoptionRate: adoptedCount / Math.max(totalCount, 1),
    } satisfies GuidanceCandidate;
  });
}

export interface GuidanceMetrics {
  guidanceId: string;
  supportCount: number;
  adoptedCount: number;
  falsePositiveCount: number;
  adoptionRate: number;
  falsePositiveRate: number;
  lastAppliedAt: Date | null;
}

export async function getGuidanceMetrics(guidanceId: string): Promise<GuidanceMetrics> {
  const result = (await db.execute(sql`
    SELECT
      COUNT(*) AS support_count,
      SUM(CASE WHEN outcome_type = 'adopted' THEN 1 ELSE 0 END) AS adopted_count,
      SUM(CASE WHEN false_positive = TRUE THEN 1 ELSE 0 END) AS fp_count,
      MAX(created_at) AS last_applied_at
    FROM review_outcomes
    WHERE guidance_ids @> ${JSON.stringify([guidanceId])}::jsonb
      AND outcome_type != 'pending'
  `)) as { rows: Array<Record<string, unknown>> };

  const row = result.rows[0] ?? {};
  const supportCount = toNumber(row.support_count);
  const adoptedCount = toNumber(row.adopted_count);
  const falsePositiveCount = toNumber(row.fp_count);

  return {
    guidanceId,
    supportCount,
    adoptedCount,
    falsePositiveCount,
    adoptionRate: supportCount > 0 ? adoptedCount / supportCount : 0,
    falsePositiveRate: supportCount > 0 ? falsePositiveCount / supportCount : 0,
    lastAppliedAt: row.last_applied_at instanceof Date ? row.last_applied_at : null,
  };
}

interface PromotionCriteria {
  minSupportCount: number;
  maxFalsePositiveRate: number;
  minAdoptionRate: number;
}

const PROMOTION_CRITERIA: Record<string, PromotionCriteria> = {
  pattern: { minSupportCount: 5, maxFalsePositiveRate: 0.1, minAdoptionRate: 0.6 },
  heuristic: { minSupportCount: 10, maxFalsePositiveRate: 0.2, minAdoptionRate: 0.5 },
};

function guidancePriority(metadata: Record<string, unknown>): number {
  const value = metadata.priority;
  return typeof value === 'number' && Number.isFinite(value) ? value : 50;
}

function guidanceTitle(metadata: Record<string, unknown>, fallback: string): string {
  const value = metadata.title;
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function guidanceTags(metadata: Record<string, unknown>): string[] {
  return Array.isArray(metadata.tags)
    ? metadata.tags.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      )
    : [];
}

export async function runAutoPromotion(): Promise<{ promoted: string[]; degraded: string[] }> {
  const candidates = await extractPatternCandidates();
  const promoted: string[] = [];
  const degraded: string[] = [];

  for (const candidate of candidates) {
    const criteria = PROMOTION_CRITERIA[candidate.type];
    if (!criteria) continue;

    const shouldPromote =
      candidate.supportCount >= criteria.minSupportCount &&
      1 - candidate.adoptionRate <= criteria.maxFalsePositiveRate &&
      candidate.adoptionRate >= criteria.minAdoptionRate;

    if (!shouldPromote) continue;

    const title = candidate.title.replace(/^\[候補\]\s*/, '').slice(0, 60);
    const content = `${
      candidate.content
    }\n\nEvidence review ids: ${candidate.evidenceReviewIds.join(', ')}`;
    const result = await saveGuidance({
      title,
      content,
      guidanceType: 'rule',
      scope: 'on_demand',
      priority: candidate.type === 'pattern' ? 70 : 60,
      tags: Array.from(new Set([...candidate.tags, candidate.type])),
    });
    promoted.push(result.archiveKey);
  }

  const guidanceRows = (await db.execute(sql`
    SELECT content, metadata
    FROM vibe_memories
    WHERE session_id = ${config.guidance.sessionId} AND metadata @> '{"kind":"guidance"}'::jsonb
    ORDER BY created_at DESC
  `)) as { rows: Array<{ content: string; metadata: unknown }> };

  for (const row of guidanceRows.rows) {
    const metadata = metadataRecord(row.metadata);
    const archiveKey = typeof metadata.archiveKey === 'string' ? metadata.archiveKey : undefined;
    if (!archiveKey) continue;

    const metrics = await getGuidanceMetrics(archiveKey);
    if (metrics.falsePositiveRate > 0.3 && metrics.supportCount > 5) {
      const newPriority = Math.max(0, guidancePriority(metadata) - 20);
      await saveGuidance({
        title: guidanceTitle(metadata, 'Unknown'),
        content: row.content,
        guidanceType: 'rule',
        scope: 'on_demand',
        priority: newPriority,
        tags: guidanceTags(metadata),
        archiveKey,
      });
      degraded.push(guidanceTitle(metadata, archiveKey));
    }
  }

  return { promoted, degraded };
}
