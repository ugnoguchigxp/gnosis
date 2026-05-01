import { sql } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { parseArgMap } from '../services/knowflow/utils/args.js';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output.js';

type ReviewCaseRow = {
  id: string;
  taskId: string;
  repoPath: string;
  status: string;
  reviewStatus: string | null;
  createdAt: string | null;
  outcomeCount: number;
  pendingOutcomes: number;
};

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);

  const result = await db.execute(
    sql.raw(`
    SELECT
      rc.id,
      rc.task_id,
      rc.repo_path,
      rc.status,
      rc.review_status,
      rc.created_at::text AS created_at,
      count(ro.id)::int AS outcome_count,
      count(*) FILTER (WHERE ro.outcome_type = 'pending')::int AS pending_outcomes
    FROM review_cases rc
    LEFT JOIN review_outcomes ro ON ro.review_case_id = rc.id
    GROUP BY rc.id, rc.task_id, rc.repo_path, rc.status, rc.review_status, rc.created_at
    ORDER BY rc.created_at DESC
    LIMIT 1000
  `),
  );

  const rows: ReviewCaseRow[] = (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id ?? ''),
    taskId: String(row.task_id ?? ''),
    repoPath: String(row.repo_path ?? ''),
    status: String(row.status ?? ''),
    reviewStatus: typeof row.review_status === 'string' ? row.review_status : null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : null,
    outcomeCount: Number(row.outcome_count ?? 0),
    pendingOutcomes: Number(row.pending_outcomes ?? 0),
  }));

  process.stdout.write(renderOutput(rows, outputFormat));
};

run()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
