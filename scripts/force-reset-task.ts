import { eq } from 'drizzle-orm';
import { db } from '../src/db/index';
import { topicTasks } from '../src/db/schema';

async function forceResetTask(taskId: string) {
  console.log(`Resetting task ${taskId}...`);
  const result = await db
    .update(topicTasks)
    .set({
      status: 'pending',
      lockedAt: null,
      lockOwner: null,
      nextRunAt: 0, // 即時実行
    })
    .where(eq(topicTasks.id, taskId));

  console.log('Task reset successfully.');
}

const taskId = '31f4f3e0-a494-4344-accf-13cfc6d468dc';
forceResetTask(taskId)
  .catch(console.error)
  .finally(() => process.exit());
