import { eq } from 'drizzle-orm';
import { db } from '../src/db/index';
import { topicTasks } from '../src/db/schema';
import { TaskStatusSchema } from '../src/services/knowflow/domain/task';
import { parseTaskPayload, toTaskRowFields } from '../src/services/knowflow/queue/taskRow';

async function main() {
  console.log('Fetching tasks with status/payload mismatch...');
  const rows = await db.select().from(topicTasks);

  let fixedCount = 0;
  for (const row of rows) {
    const payload = parseTaskPayload(row.payload);
    if (payload.status !== row.status) {
      console.log(`Fixing task ${row.id}: column=${row.status}, payload=${payload.status}`);
      const updatedTask = { ...payload, status: TaskStatusSchema.parse(row.status) };
      const fields = toTaskRowFields(updatedTask);

      await db.update(topicTasks).set({ payload: fields.payload }).where(eq(topicTasks.id, row.id));
      fixedCount++;
    }
  }

  console.log(`Fixed ${fixedCount} tasks.`);
}

main().catch(console.error);
