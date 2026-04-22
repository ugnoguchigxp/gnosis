import { db } from '../src/db/index.js';
import { entities } from '../src/db/schema.js';
import { desc } from 'drizzle-orm';

async function list() {
  const latest = await db.select().from(entities).orderBy(desc(entities.createdAt)).limit(10);
  console.log(JSON.stringify(latest, null, 2));
}

list().then(() => process.exit());
