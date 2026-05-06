import { sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import type { ReviewKPIs } from '../types.js';

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function calculateMetrics(
  timeRange: { start: Date; end: Date },
  projectKey?: string,
): Promise<ReviewKPIs> {
  const base = (await db.execute(sql`
    SELECT
      COUNT(*) AS total_reviews,
      COALESCE(SUM(finding_count), 0) AS total_findings,
      COALESCE(SUM(adopted_count), 0) AS adopted,
      COALESCE(SUM(fp_count), 0) AS fp_count,
      COALESCE(SUM(with_guidance_count), 0) AS with_guidance,
      AVG(duration_ms) AS avg_duration_ms
    FROM (
      SELECT
        rc.id,
        EXTRACT(EPOCH FROM (rc.completed_at - rc.created_at)) * 1000 AS duration_ms,
        COUNT(ro.id) AS finding_count,
        SUM(CASE WHEN ro.outcome_type = 'resolved' THEN 1 ELSE 0 END) AS adopted_count,
        SUM(CASE WHEN ro.false_positive = TRUE THEN 1 ELSE 0 END) AS fp_count,
        SUM(CASE WHEN jsonb_array_length(COALESCE(ro.guidance_ids, '[]'::jsonb)) > 0 THEN 1 ELSE 0 END) AS with_guidance_count
      FROM review_cases rc
      LEFT JOIN review_outcomes ro ON ro.review_case_id = rc.id
      WHERE rc.created_at BETWEEN ${timeRange.start} AND ${timeRange.end}
        AND rc.status = 'completed'
        ${projectKey ? sql`AND rc.repo_path LIKE ${`%${projectKey}%`}` : sql``}
      GROUP BY rc.id, rc.created_at, rc.completed_at
    ) per_review
  `)) as { rows: Array<Record<string, unknown>> };

  const row = base.rows[0] ?? {};
  const totalReviews = toNumber(row.total_reviews);
  const totalFindings = toNumber(row.total_findings);
  const adopted = toNumber(row.adopted);
  const fpCount = toNumber(row.fp_count);
  const withGuidance = toNumber(row.with_guidance);

  return {
    totalReviews,
    totalFindings,
    avgFindingsPerReview: totalFindings / Math.max(totalReviews, 1),
    precisionRate: adopted / Math.max(totalFindings, 1),
    falsePositiveRate: fpCount / Math.max(totalFindings, 1),
    knowledgeContributionRate: withGuidance / Math.max(totalFindings, 1),
    zeroFpDays: await calculateZeroFpDays(timeRange, projectKey),
    avgReviewDurationMs: toNumber(row.avg_duration_ms),
    precisionByCategory: await calculatePrecisionByCategory(timeRange, projectKey),
  };
}

async function calculateZeroFpDays(
  timeRange: { start: Date; end: Date },
  projectKey?: string,
): Promise<number> {
  const fpByDay = (await db.execute(sql`
    SELECT
      DATE_TRUNC('day', rc.created_at) AS day,
      SUM(CASE WHEN ro.false_positive THEN 1 ELSE 0 END) AS fp_count
    FROM review_cases rc
    JOIN review_outcomes ro ON ro.review_case_id = rc.id
    WHERE rc.created_at BETWEEN ${timeRange.start} AND ${timeRange.end}
      ${projectKey ? sql`AND rc.repo_path LIKE ${`%${projectKey}%`}` : sql``}
    GROUP BY 1
    ORDER BY 1 DESC
  `)) as { rows: Array<Record<string, unknown>> };

  let consecutiveZero = 0;
  for (const row of fpByDay.rows) {
    if (toNumber(row.fp_count) === 0) consecutiveZero++;
    else break;
  }
  return consecutiveZero;
}

async function calculatePrecisionByCategory(
  timeRange: { start: Date; end: Date },
  projectKey?: string,
): Promise<Record<string, number>> {
  const result = (await db.execute(sql`
    SELECT
      vm.metadata->>'category' AS category,
      COUNT(*) AS total,
      SUM(CASE WHEN ro.outcome_type = 'resolved' THEN 1 ELSE 0 END) AS adopted
    FROM review_outcomes ro
    JOIN vibe_memories vm
      ON vm.metadata->>'reviewCaseId' = ro.review_case_id
    JOIN review_cases rc ON rc.id = ro.review_case_id
    WHERE rc.created_at BETWEEN ${timeRange.start} AND ${timeRange.end}
      ${projectKey ? sql`AND rc.repo_path LIKE ${`%${projectKey}%`}` : sql``}
    GROUP BY vm.metadata->>'category'
  `)) as { rows: Array<Record<string, unknown>> };

  return Object.fromEntries(
    result.rows.map((row) => [
      String(row.category ?? 'unknown'),
      toNumber(row.adopted) / Math.max(toNumber(row.total), 1),
    ]),
  );
}
