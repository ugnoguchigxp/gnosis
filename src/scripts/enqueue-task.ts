import type { TaskMode, TaskSource } from '../services/knowflow/domain/task.js';
import { PgJsonbQueueRepository } from '../services/knowflow/queue/pgJsonbRepository.js';

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (key: string) => {
    const idx = argv.indexOf(key);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };

  const topic = getArg('--topic');
  const mode = (getArg('--mode') || 'directed') as TaskMode;
  const source = (getArg('--source') || 'user') as TaskSource;
  const priority = Number(getArg('--priority')) || 0;
  const requestedBy = getArg('--requested-by') || 'llmharness';

  if (!topic) {
    console.error(
      'Usage: bun run src/scripts/enqueue-task.ts --topic "..." [--mode directed|expand|explore] [--source user|cron] [--priority <n>] [--requested-by <id>]',
    );
    process.exit(1);
  }

  try {
    const repository = new PgJsonbQueueRepository();
    const result = await repository.enqueue({
      topic,
      mode,
      source,
      priority,
      requestedBy,
    });

    console.log(`Task enqueued: ${result.task.id} (topic="${topic}", deduped=${result.deduped})`);
  } catch (error) {
    console.error('Enqueue task error:', error);
    process.exit(1);
  }
}

main();
