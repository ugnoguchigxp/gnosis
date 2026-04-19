import { PgJsonbQueueRepository } from '../src/services/knowflow/queue/pgJsonbRepository.js';

async function main() {
  const repository = new PgJsonbQueueRepository();
  console.log('Clearing all stuck tasks in PostgreSQL...');
  // timeoutMs=0 にすることで、現在 'running' のすべてのタスクを 'pending' に戻す
  const cleared = await repository.clearStaleTasks(0);
  console.log(`Successfully cleared ${cleared} stale tasks.`);
}

main().catch(console.error);
