import { describe, expect, it } from 'bun:test';
import {
  createQueueRepository,
  resolveQueueBackend,
} from '../../src/services/knowflow/queue/factory';
import { PgJsonbQueueRepository } from '../../src/services/knowflow/queue/pgJsonbRepository';
import { FileQueueRepository } from '../../src/services/knowflow/queue/repository';

describe('queue factory', () => {
  it('uses file backend when explicitly requested', () => {
    const repository = createQueueRepository({
      backend: 'file',
      queueFilePath: '.knowflow/factory-test.json',
    });
    expect(repository).toBeInstanceOf(FileQueueRepository);
  });

  it('defaults to postgres backend', () => {
    const prevBackend = process.env.QUEUE_BACKEND;
    const prevUrl = process.env.QUEUE_POSTGRES_URL;
    const prevDb = process.env.DATABASE_URL;
    process.env.QUEUE_BACKEND = undefined;
    process.env.QUEUE_POSTGRES_URL = undefined;
    process.env.DATABASE_URL = undefined;
    try {
      expect(() => createQueueRepository()).toThrow(/QUEUE_POSTGRES_URL/);
    } finally {
      if (prevBackend !== undefined) {
        process.env.QUEUE_BACKEND = prevBackend;
      }
      if (prevUrl !== undefined) {
        process.env.QUEUE_POSTGRES_URL = prevUrl;
      }
      if (prevDb !== undefined) {
        process.env.DATABASE_URL = prevDb;
      }
    }
  });

  it('creates postgres backend when requested', () => {
    const repository = createQueueRepository({
      backend: 'postgres',
      postgresConnectionString: 'postgres://postgres:postgres@localhost:5432/gnosis',
    });
    expect(repository).toBeInstanceOf(PgJsonbQueueRepository);
  });

  it('fails when postgres backend is selected without connection string', () => {
    const prevDb = process.env.DATABASE_URL;
    const prevUrl = process.env.QUEUE_POSTGRES_URL;
    process.env.DATABASE_URL = undefined;
    process.env.QUEUE_POSTGRES_URL = undefined;
    try {
      expect(() =>
        createQueueRepository({
          backend: 'postgres',
        }),
      ).toThrow(/QUEUE_POSTGRES_URL/);
    } finally {
      process.env.DATABASE_URL = prevDb;
      process.env.QUEUE_POSTGRES_URL = prevUrl;
    }
  });

  it('validates backend value', () => {
    expect(resolveQueueBackend('file')).toBe('file');
    expect(resolveQueueBackend('postgres')).toBe('postgres');
    expect(() => resolveQueueBackend('unknown')).toThrow();
  });
});
