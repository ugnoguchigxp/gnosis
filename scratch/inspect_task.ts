import { eq } from 'drizzle-orm';
import { db } from '../src/db/index';
import { topicTasks } from '../src/db/schema';

async function main() {
  const id = 'bda14274-9d57-4f53-a9cb-aa25a533d494';
  const rows = await db.select().from(topicTasks).where(eq(topicTasks.id, id));
  console.log(JSON.stringify(rows[0], null, 2));
}

main().catch(console.error);
