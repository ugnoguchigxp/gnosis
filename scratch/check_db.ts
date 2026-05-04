import { Database } from 'bun:sqlite';
import { eq, sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { syncState, topicTasks } from '../src/db/schema';

async function check() {
  const sqlite = new Database('data/gnosis-tasks.sqlite');
  const tasks = sqlite
    .query(
      'SELECT type, status, priority, count(*) as count FROM background_tasks GROUP BY type, status, priority',
    )
    .all();
  console.log('Background Tasks (SQLite):', tasks);

  const sync = await db.select().from(syncState);
  console.log('Sync State (Postgres):', sync);

  const taskCount = await db
    .select({ count: sql`count(*)`, status: topicTasks.status })
    .from(topicTasks)
    .groupBy(topicTasks.status);
  console.log('Topic Tasks by Status:', taskCount);

  const pendingTasks = await db
    .select()
    .from(topicTasks)
    .where(eq(topicTasks.status, 'pending'))
    .limit(5);
  console.log('Pending Topic Tasks:', pendingTasks);
}

check().catch(console.error);
