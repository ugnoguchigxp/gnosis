import { desc } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { syncState } from '../db/schema.js';
import { parseArgMap } from '../services/knowflow/utils/args.js';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output.js';

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);
  const rows = await db
    .select({
      id: syncState.id,
      lastSyncedAt: syncState.lastSyncedAt,
      cursor: syncState.cursor,
      updatedAt: syncState.updatedAt,
    })
    .from(syncState)
    .orderBy(desc(syncState.updatedAt));
  process.stdout.write(renderOutput(rows, outputFormat));
};

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await closeDbPool();
});
