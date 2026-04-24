import { db } from '../src/db/index.js';
import { syncState } from '../src/db/schema.js';

async function main() {
  await db.delete(syncState);
  console.log('Sync state reset.');
  process.exit(0);
}

main();
