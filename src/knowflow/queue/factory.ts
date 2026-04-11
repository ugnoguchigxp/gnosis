import { PgJsonbQueueRepository } from './pgJsonbRepository';
import { FileQueueRepository, type QueueRepository } from './repository';

export type QueueConfig = {
  backend?: 'file' | 'postgres';
  queueFilePath?: string;
  postgresConnectionString?: string;
};

export function resolveQueueBackend(name?: string): 'file' | 'postgres' {
  if (!name || name === 'postgres') return 'postgres';
  if (name === 'file') return 'file';
  throw new Error(`Unknown queue backend: ${name}`);
}

export function createQueueRepository(config: QueueConfig = {}): QueueRepository {
  const backend = resolveQueueBackend(config.backend || process.env.QUEUE_BACKEND);

  if (backend === 'file') {
    const path = config.queueFilePath || process.env.QUEUE_FILE_PATH || '.knowflow/tasks.json';
    return new FileQueueRepository(path);
  }

  // postgres
  const url =
    config.postgresConnectionString || process.env.QUEUE_POSTGRES_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('QUEUE_POSTGRES_URL or DATABASE_URL is required for postgres backend');
  }

  return new PgJsonbQueueRepository();
}
