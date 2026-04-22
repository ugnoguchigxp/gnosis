import { db } from '../src/db/index.js';
import { syncState } from '../src/db/schema.js';

async function main() {
  const checkpoints = await db.select().from(syncState);
  console.log(JSON.stringify(checkpoints, null, 2));
}

main().catch(console.error);
