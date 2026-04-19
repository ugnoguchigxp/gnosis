import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/index';
import { topicTasks } from '../src/db/schema';

async function resetStuckTasks() {
  console.log('Checking for stuck tasks...');
  const stuckTasks = await db.select().from(topicTasks).where(eq(topicTasks.status, 'running'));

  if (stuckTasks.length === 0) {
    console.log('No stuck tasks found.');
    return;
  }

  console.log(`Found ${stuckTasks.length} stuck tasks. Resetting to pending...`);
  for (const task of stuckTasks) {
    await db
      .update(topicTasks)
      .set({ status: 'pending', lockedAt: null, lockOwner: null })
      .where(eq(topicTasks.id, task.id));
    const payloadTopic =
      typeof task.payload === 'object' && task.payload !== null && 'topic' in task.payload
        ? String((task.payload as Record<string, unknown>).topic)
        : 'unknown';
    console.log(`Reset task: ${task.id} (${payloadTopic})`);
  }
}

resetStuckTasks()
  .catch(console.error)
  .finally(() => process.exit());
