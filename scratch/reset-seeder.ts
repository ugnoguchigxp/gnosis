import { db } from '../src/db/index.js';
import { syncState } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

async function main() {
  const lookbackHours = 48; // 48時間前に戻す
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  
  await db.update(syncState)
    .set({
      lastSyncedAt: since,
      cursor: { since: since.toISOString() }
    })
    .where(eq(syncState.id, 'knowflow_keyword_cron'));
    
  console.log(`Reset knowflow_keyword_cron to: ${since.toISOString()}`);
}

main().catch(console.error);
