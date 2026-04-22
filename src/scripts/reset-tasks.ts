import { eq, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { topicTasks } from '../db/schema.js';

async function resetTasks() {
  console.log('Resetting stagnant KnowFlow tasks...');

  await db
    .update(topicTasks)
    .set({
      status: 'pending',
      lockedAt: null,
      lockOwner: null,
      updatedAt: new Date(),
    })
    .where(or(eq(topicTasks.status, 'failed'), eq(topicTasks.status, 'running')));

  console.log('Finished resetting stagnant tasks.');
  process.exit(0);
}

resetTasks().catch((err) => {
  console.error(err);
  process.exit(1);
});
