import { eq } from 'drizzle-orm';
import { db } from '../src/db/index';
import { topicTasks } from '../src/db/schema';

async function resetDbTasks() {
  console.log('Resetting running tasks in DB via Drizzle...');
  const result = await db
    .update(topicTasks)
    .set({
      status: 'pending',
      lockedAt: null,
      lockOwner: null,
    })
    .where(eq(topicTasks.status, 'running'));
  console.log('Reset complete.');
}

resetDbTasks().catch(console.error);
