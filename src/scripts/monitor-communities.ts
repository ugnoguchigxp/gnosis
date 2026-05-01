import { desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { communities, entities } from '../db/schema.js';
import { parseArgMap } from '../services/knowflow/utils/args.js';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output.js';

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);
  const rows = await db
    .select({
      id: communities.id,
      name: communities.name,
      summary: communities.summary,
      createdAt: communities.createdAt,
      memberCount: sql<number>`count(${entities.id})::int`,
    })
    .from(communities)
    .leftJoin(entities, sql`${entities.communityId} = ${communities.id}`)
    .groupBy(communities.id, communities.name, communities.summary, communities.createdAt)
    .orderBy(desc(communities.createdAt))
    .limit(1000);
  process.stdout.write(
    renderOutput(
      rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      outputFormat,
    ),
  );
};

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
