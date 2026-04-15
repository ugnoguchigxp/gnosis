import { z } from 'zod';
import type { TaskMode, TaskSource } from '../services/knowflow/domain/task.js';
import { PgJsonbQueueRepository } from '../services/knowflow/queue/pgJsonbRepository.js';

// 入力バリデーションスキーマ
const topicSchema = z
  .string()
  .min(1, 'Topic must not be empty')
  .max(500, 'Topic must be less than 500 characters')
  .regex(/^[a-zA-Z0-9\s\-_.,()]+$/, 'Topic contains invalid characters');

const modeSchema = z.enum(['directed', 'expand', 'explore']);
const sourceSchema = z.enum(['user', 'cron', 'ui', 'monitor']);
const prioritySchema = z.number().int().min(0).max(100);

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (key: string) => {
    const idx = argv.indexOf(key);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };

  const topic = getArg('--topic');
  const mode = (getArg('--mode') || 'directed') as TaskMode;
  const source = (getArg('--source') || 'ui') as TaskSource;
  const priority = Number(getArg('--priority')) || 50;
  const requestedBy = getArg('--requested-by') || 'monitor';
  const isJson = argv.includes('--json');

  if (!topic) {
    const usage =
      'Usage: bun run src/scripts/enqueue-task.ts --topic "..." [--mode directed|expand|explore] [--source user|cron|ui] [--priority <n>] [--requested-by <id>] [--json]';
    if (isJson) {
      console.error(JSON.stringify({ success: false, error: usage }));
    } else {
      console.error(usage);
    }
    process.exit(1);
  }

  // バリデーション
  try {
    topicSchema.parse(topic);
    modeSchema.parse(mode);
    sourceSchema.parse(source);
    prioritySchema.parse(priority);
  } catch (error) {
    const message = error instanceof z.ZodError ? error.errors[0].message : String(error);
    if (isJson) {
      console.error(JSON.stringify({ success: false, error: `Validation error: ${message}` }));
    } else {
      console.error(`Validation error: ${message}`);
    }
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

    if (isJson) {
      console.log(
        JSON.stringify({
          success: true,
          taskId: result.task.id,
          topic,
          deduped: result.deduped,
        }),
      );
    } else {
      console.log(`Task enqueued: ${result.task.id} (topic="${topic}", deduped=${result.deduped})`);
    }
  } catch (error) {
    if (isJson) {
      console.error(JSON.stringify({ success: false, error: String(error) }));
    } else {
      console.error('Enqueue task error:', error);
    }
    process.exit(1);
  }
}

main();
