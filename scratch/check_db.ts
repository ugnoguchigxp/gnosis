import { Database } from 'bun:sqlite';
import { eq, sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { knowflowKeywordEvaluations, syncState, topicTasks } from '../src/db/schema';

async function check() {
  const sqlite = new Database('gnosis-tasks.sqlite');
  const tasks = sqlite
    .query(
      'SELECT type, status, priority, count(*) as count FROM background_tasks GROUP BY type, status, priority',
    )
    .all();
  console.log('Background Tasks (SQLite):', tasks);

  const sync = await db.select().from(syncState);
  console.log('Sync State (Postgres):', sync);

  const evalCount = await db.select({ count: sql`count(*)` }).from(knowflowKeywordEvaluations);
  console.log('Keyword Evaluations Count:', evalCount);

  const taskCount = await db
    .select({ count: sql`count(*)`, status: topicTasks.status })
    .from(topicTasks)
    .groupBy(topicTasks.status);
  console.log('Topic Tasks by Status:', taskCount);

  const recentEvals = await db
    .select()
    .from(knowflowKeywordEvaluations)
    .orderBy(sql`created_at DESC`)
    .limit(5);
  console.log('Recent Evaluations:', recentEvals);

  const pendingTasks = await db
    .select()
    .from(topicTasks)
    .where(eq(topicTasks.status, 'pending'))
    .limit(5);
  console.log('Pending Topic Tasks:', pendingTasks);
}

check().catch(console.error);
