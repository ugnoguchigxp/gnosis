import { db } from '../db/index.js';
import { syncState } from '../db/schema.js';

async function main() {
  await db.delete(syncState);
  console.log('Sync state reset.');
  process.exit(0);
}

main();
