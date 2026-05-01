import { eq } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { syncState } from '../db/schema.js';
import { parseArgMap, readStringFlag } from '../services/knowflow/utils/args.js';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output.js';

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);
  const action = readStringFlag(args, 'action');
  const id = readStringFlag(args, 'id');
  const confirm = readStringFlag(args, 'confirm');

  if (!action || !['preview-reset', 'reset'].includes(action)) {
    throw new Error('--action must be preview-reset|reset');
  }
  if (!id) {
    throw new Error('--id is required');
  }

  const rows = await db
    .select({
      id: syncState.id,
      lastSyncedAt: syncState.lastSyncedAt,
      cursor: syncState.cursor,
      updatedAt: syncState.updatedAt,
    })
    .from(syncState)
    .where(eq(syncState.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`sync_state not found: ${id}`);
  }

  if (action === 'preview-reset') {
    process.stdout.write(
      renderOutput(
        {
          action,
          id,
          current: row,
          preview: {
            cursor: {},
            updatedAt: new Date().toISOString(),
          },
          confirmToken: `RESET:${id}`,
        },
        outputFormat,
      ),
    );
    return;
  }

  const expectedToken = `RESET:${id}`;
  if (confirm !== expectedToken) {
    throw new Error(
      `confirm token mismatch. run preview first and pass --confirm ${expectedToken}`,
    );
  }

  await db
    .update(syncState)
    .set({
      cursor: {},
      updatedAt: new Date(),
    })
    .where(eq(syncState.id, id));

  process.stdout.write(
    renderOutput(
      {
        success: true,
        action,
        id,
        reset: {
          cursor: {},
          updatedAt: new Date().toISOString(),
        },
      },
      outputFormat,
    ),
  );
};

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await closeDbPool();
});
