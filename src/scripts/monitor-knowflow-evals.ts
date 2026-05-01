import { desc, sql } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { knowflowKeywordEvaluations } from '../db/schema.js';
import { parseArgMap } from '../services/knowflow/utils/args.js';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output.js';

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);

  const byDecisionRows = await db
    .select({
      decision: knowflowKeywordEvaluations.decision,
      count: sql<number>`count(*)::int`,
    })
    .from(knowflowKeywordEvaluations)
    .groupBy(knowflowKeywordEvaluations.decision);

  const byModelRows = await db
    .select({
      modelAlias: knowflowKeywordEvaluations.modelAlias,
      count: sql<number>`count(*)::int`,
    })
    .from(knowflowKeywordEvaluations)
    .groupBy(knowflowKeywordEvaluations.modelAlias);

  const thresholdRows = await db
    .select({
      threshold: knowflowKeywordEvaluations.threshold,
      count: sql<number>`count(*)::int`,
    })
    .from(knowflowKeywordEvaluations)
    .groupBy(knowflowKeywordEvaluations.threshold)
    .orderBy(desc(sql`count(*)`))
    .limit(20);

  const recent = await db
    .select({
      id: knowflowKeywordEvaluations.id,
      runId: knowflowKeywordEvaluations.runId,
      topic: knowflowKeywordEvaluations.topic,
      decision: knowflowKeywordEvaluations.decision,
      threshold: knowflowKeywordEvaluations.threshold,
      modelAlias: knowflowKeywordEvaluations.modelAlias,
      createdAt: knowflowKeywordEvaluations.createdAt,
    })
    .from(knowflowKeywordEvaluations)
    .orderBy(desc(knowflowKeywordEvaluations.createdAt))
    .limit(200);

  process.stdout.write(
    renderOutput(
      {
        summary: {
          byDecision: byDecisionRows,
          byModelAlias: byModelRows,
          byThreshold: thresholdRows,
        },
        recent: recent.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        })),
      },
      outputFormat,
    ),
  );
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
