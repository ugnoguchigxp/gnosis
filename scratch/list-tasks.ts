import { db } from '../src/db/index.js';
import { topicTasks } from '../src/db/schema.js';
import { desc } from 'drizzle-orm';

async function list() {
  const tasks = await db.select().from(topicTasks).orderBy(desc(topicTasks.createdAt)).limit(10);
  console.log(JSON.stringify(tasks, null, 2));
}

list().then(() => process.exit());
