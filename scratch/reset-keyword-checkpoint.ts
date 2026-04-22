import { db } from '../src/db/index.js';
import { syncState } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

async function reset() {
  const yesterdayDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayStr = yesterdayDate.toISOString();
  await db.update(syncState)
    .set({ 
      lastSyncedAt: yesterdayDate,
      cursor: { since: yesterdayStr }
    })
    .where(eq(syncState.id, 'knowflow_keyword_cron'));
  console.log('Reset knowflow_keyword_cron checkpoint to yesterday:', yesterdayStr);
}

reset().then(() => process.exit());
