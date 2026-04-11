import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { closeAllPgPools } from '../../src/knowflow/db/pg';
import { PgJsonbQueueRepository } from '../../src/knowflow/queue/pgJsonbRepository';

const connectionString = process.env.QUEUE_POSTGRES_URL;
const shouldRunIntegration = process.env.KNOWFLOW_RUN_INTEGRATION === '1' && !!connectionString;

const describeIntegration = shouldRunIntegration ? describe : describe.skip;

describeIntegration('postgres queue integration', () => {
  let pool: Pool;
  let repository: PgJsonbQueueRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    const migrationSql = await readFile(
      resolve(process.cwd(), 'migrations/0001_phase3_pg.sql'),
      'utf-8',
    );
    await pool.query(migrationSql);

    // Gnosis integrated version uses global db instance
    repository = new PgJsonbQueueRepository();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE topic_tasks');
  });

  afterAll(async () => {
    await pool.end();
    await closeAllPgPools();
  });

  it('locks different tasks for concurrent workers using SKIP LOCKED', async () => {
    await repository.enqueue({
      topic: 'TypeScript Compiler API',
      mode: 'directed',
      source: 'user',
      priority: 100,
    });
    await repository.enqueue({
      topic: 'ts-morph',
      mode: 'directed',
      source: 'user',
      priority: 90,
    });
    await repository.enqueue({
      topic: 'TypeScript Language Service',
      mode: 'directed',
      source: 'user',
      priority: 80,
    });

    const [locked1, locked2, locked3] = await Promise.all([
      repository.dequeueAndLock('worker-1'),
      repository.dequeueAndLock('worker-2'),
      repository.dequeueAndLock('worker-3'),
    ]);

    const lockedTasks = [locked1, locked2, locked3].filter(
      (task): task is NonNullable<typeof task> => task !== null,
    );

    expect(lockedTasks).toHaveLength(3);
    expect(new Set(lockedTasks.map((task) => task.id)).size).toBe(3);

    const rows = await pool.query<{
      id: string;
      status: string;
      lock_owner: string | null;
    }>(
      `
        SELECT id, status, lock_owner
        FROM topic_tasks
        WHERE status = 'running'
      `,
    );

    expect(rows.rowCount).toBe(3);
    expect(rows.rows.every((row) => row.lock_owner?.startsWith('worker-'))).toBe(true);
  });
});
