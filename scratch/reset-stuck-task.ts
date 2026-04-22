import { db } from '../src/db/index.js';
import { topicTasks } from '../src/db/schema.js';
import { eq, and } from 'drizzle-orm';

async function reset() {
  const taskId = 'f72184e9-cb59-4254-900e-fd4ed6c34dca';
  
  // Get current task to update payload
  const tasks = await db.select().from(topicTasks).where(eq(topicTasks.id, taskId));
  if (tasks.length === 0) {
    console.log('Task not found.');
    return;
  }
  
  const task = tasks[0];
  const payload = task.payload as any;
  const newPayload = { ...payload, status: 'pending' };
  delete newPayload.lockedAt;
  delete newPayload.lockOwner;

  const result = await db.update(topicTasks)
    .set({ 
      status: 'pending',
      lockedAt: null,
      lockOwner: null,
      payload: newPayload
    })
    .where(eq(topicTasks.id, taskId))
    .returning();
  
  if (result.length > 0) {
    const r = result[0] as any;
    console.log('Reset stuck task (with payload):', r.id, r.payload?.topic);
  } else {
    console.log('Update failed.');
  }
}

reset().then(() => process.exit());
