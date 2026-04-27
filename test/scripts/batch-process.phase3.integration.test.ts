import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import pkg from 'pg';
import { config } from '../../src/config.js';

const { Pool } = pkg;

const shouldRunIntegration = process.env.RUN_BATCH_PROCESS_INTEGRATION === '1';
const connectionString = process.env.DATABASE_URL || config.databaseUrl;
const queueSchema = `phase3_queue_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
const tempDir = path.resolve(process.cwd(), 'tmp', `phase3-${Date.now()}`);

let pool: InstanceType<typeof Pool> | null = null;
let dbReady = false;

function skipMessage(message: string) {
  console.warn(`[skip] ${message}`);
}

function runBun(
  args: string[],
  userEnv: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const bunCommand = process.env.GNOSIS_BUN_COMMAND || '/Users/y.noguchi/.bun/bin/bun';
  const env = {
    ...userEnv,
    PATH: `${path.dirname(bunCommand)}:${process.env.PATH}`,
  };

  const proc = spawnSync(bunCommand, args, {
    encoding: 'utf-8',
    env,
  });
  return {
    status: proc.status,
    stdout: proc.stdout || '',
    stderr: proc.stderr || '',
  };
}

async function ensureQueueSchema(poolInstance: InstanceType<typeof Pool>) {
  await poolInstance.query(`CREATE SCHEMA IF NOT EXISTS "${queueSchema}"`);
  await poolInstance.query(`
    CREATE TABLE IF NOT EXISTS "${queueSchema}".topic_tasks (
      id uuid PRIMARY KEY,
      dedupe_key text NOT NULL,
      status text NOT NULL,
      priority integer NOT NULL,
      next_run_at bigint,
      locked_at bigint,
      lock_owner text,
      payload jsonb NOT NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
}

async function cleanupQueueTable(poolInstance: InstanceType<typeof Pool>) {
  await poolInstance.query(`TRUNCATE TABLE "${queueSchema}".topic_tasks`);
}

describe('Phase3 CLI integration', () => {
  beforeAll(async () => {
    if (!shouldRunIntegration) return;

    pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 1500,
    });

    try {
      await pool.query('select 1');
      await ensureQueueSchema(pool);
      dbReady = true;
      if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true });
      }
    } catch {
      dbReady = false;
    }
  });

  beforeEach(async () => {
    if (!shouldRunIntegration || !dbReady || !pool) return;
    await cleanupQueueTable(pool);
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${queueSchema}" CASCADE`);
    } finally {
      await pool.end();
    }

    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('strict-complete fails when queue is empty', () => {
    if (!shouldRunIntegration) {
      skipMessage('phase3 integration disabled (set RUN_BATCH_PROCESS_INTEGRATION=1)');
      return;
    }
    if (!dbReady) {
      skipMessage('phase3 integration skipped (database unavailable)');
      return;
    }

    const env = {
      ...process.env,
      DATABASE_URL: connectionString,
      PGOPTIONS: `-c search_path=${queueSchema}`,
    };
    const proc = runBun(
      ['run', 'src/services/knowflow/cli.ts', 'run-once', '--strict-complete', '--json'],
      env,
    );

    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain('--strict-complete failed: no runnable task was processed');
  }, 30000);

  it('strict-complete fails when task is deferred', () => {
    if (!shouldRunIntegration) {
      skipMessage('phase3 integration disabled (set RUN_BATCH_PROCESS_INTEGRATION=1)');
      return;
    }
    if (!dbReady) {
      skipMessage('phase3 integration skipped (database unavailable)');
      return;
    }

    const env = {
      ...process.env,
      DATABASE_URL: connectionString,
      PGOPTIONS: `-c search_path=${queueSchema}`,
    };

    const topic = `phase3-deferred-${Date.now()}`;
    const enqueue = runBun(
      [
        'run',
        'src/services/knowflow/cli.ts',
        'enqueue',
        '--topic',
        topic,
        '--mode',
        'directed',
        '--source',
        'cron',
        '--priority',
        '999999',
        '--json',
      ],
      env,
    );
    expect(enqueue.status).toBe(0);

    const runOnce = runBun(
      [
        'run',
        'src/services/knowflow/cli.ts',
        'run-once',
        '--strict-complete',
        '--fail',
        '--max-attempts',
        '3',
        '--json',
      ],
      env,
    );

    expect(runOnce.status).toBe(1);
    expect(runOnce.stderr).toContain('ended with status=deferred');
  }, 30000);

  it('strict-complete fails when task is failed', () => {
    if (!shouldRunIntegration) {
      skipMessage('phase3 integration disabled (set RUN_BATCH_PROCESS_INTEGRATION=1)');
      return;
    }
    if (!dbReady) {
      skipMessage('phase3 integration skipped (database unavailable)');
      return;
    }

    const env = {
      ...process.env,
      DATABASE_URL: connectionString,
      PGOPTIONS: `-c search_path=${queueSchema}`,
    };

    const topic = `phase3-failed-${Date.now()}`;
    const enqueue = runBun(
      [
        'run',
        'src/services/knowflow/cli.ts',
        'enqueue',
        '--topic',
        topic,
        '--mode',
        'directed',
        '--source',
        'cron',
        '--priority',
        '999999',
        '--json',
      ],
      env,
    );
    expect(enqueue.status).toBe(0);

    const runOnce = runBun(
      [
        'run',
        'src/services/knowflow/cli.ts',
        'run-once',
        '--strict-complete',
        '--fail',
        '--max-attempts',
        '1',
        '--json',
      ],
      env,
    );

    expect(runOnce.status).toBe(1);
    expect(runOnce.stderr).toContain('ended with status=failed');
  }, 30000);
});
