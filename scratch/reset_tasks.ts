import { resolve } from 'node:path';
import { FileQueueRepository } from '../src/services/knowflow/queue/repository';

const queuePath = resolve(process.cwd(), 'data/knowflow/queue.json');
const repository = new FileQueueRepository(queuePath);

async function resetStaleTasks() {
  console.log(`Checking queue at ${queuePath}...`);
  const cleared = await repository.clearStaleTasks(0); // すべての running タスクをリセット
  console.log(`Cleared ${cleared} stale tasks.`);
}

resetStaleTasks().catch(console.error);
