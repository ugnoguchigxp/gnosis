import { db } from '../src/db/index.js';
import { syncState } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

async function check() {
  const state = await db.select().from(syncState).where(eq(syncState.id, 'knowflow_keyword_cron'));
  console.log(JSON.stringify(state, null, 2));
}

check().then(() => process.exit());
