import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pkg from 'pg';
import { config } from '../../src/config.js';

const { Pool } = pkg;

const shouldRunIntegration = process.env.RUN_BATCH_PROCESS_INTEGRATION === '1';
const connectionString = process.env.DATABASE_URL || config.databaseUrl;
const queueSchema = `phase3_queue_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
const tempDir = path.resolve(process.cwd(), 'tmp', `phase3-${Date.now()}`);
const llmMockScript = path.join(tempDir, 'llm-mock.sh');
const embedMockScript = path.join(tempDir, 'embed-mock.js');

let pool: InstanceType<typeof Pool> | null = null;
let dbReady = false;

function skipMessage(message: string) {
  console.warn(`[skip] ${message}`);
}

function parseLastJsonLine(stdout: string): Record<string, unknown> {
  const jsonLine = stdout
    .split('\n')
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith('{') && line.endsWith('}'));
  if (!jsonLine) return {};
  return JSON.parse(jsonLine) as Record<string, unknown>;
}

function runBun(
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync('bun', args, {
    encoding: 'utf-8',
    env,
  });
  return {
    status: proc.status,
    stdout: proc.stdout || '',
    stderr: proc.stderr || '',
  };
}

function setupMockScripts() {
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  writeFileSync(
    llmMockScript,
    `#!/usr/bin/env bash
cat <<'JSON'
{"story":"phase3 integration story","importance":0.7,"episodeAt":"2026-04-20T00:00:00.000Z"}
JSON
`,
    'utf-8',
  );
  chmodSync(llmMockScript, 0o755);

  writeFileSync(
    embedMockScript,
    `#!/usr/bin/env node
const dim = Number(process.env.GNOSIS_EMBEDDING_DIMENSION || '384');
const vec = Array.from({ length: dim }, () => 0.01);
process.stdout.write(JSON.stringify(vec));
`,
    'utf-8',
  );
  chmodSync(embedMockScript, 0o755);
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

async function cleanupSessionData(
  poolInstance: InstanceType<typeof Pool>,
  sessionId: string,
  episodeId?: string,
) {
  const episodeEntityId = episodeId ? `episode/${episodeId}` : null;

  if (episodeEntityId) {
    await poolInstance.query('DELETE FROM relations WHERE source_id = $1 OR target_id = $1', [
      episodeEntityId,
    ]);
    await poolInstance.query(`DELETE FROM entities WHERE id = $1 OR metadata->>'memoryId' = $2`, [
      episodeEntityId,
      episodeId,
    ]);
  }

  await poolInstance.query('DELETE FROM vibe_memories WHERE session_id = $1', [sessionId]);
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
      setupMockScripts();
      dbReady = true;
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

  it('monitor-episodes consolidate --strict fails when session has no raw memories', () => {
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
      GNOSIS_GEMMA4_SCRIPT: llmMockScript,
      GNOSIS_BONSAI_SCRIPT: llmMockScript,
      GNOSIS_OPENAI_SCRIPT: llmMockScript,
      GNOSIS_BEDROCK_SCRIPT: llmMockScript,
      GNOSIS_EMBED_COMMAND: embedMockScript,
      MEMORY_LOOP_ALLOW_CLOUD: '0',
    };

    const missingSession = `phase3-missing-${randomUUID()}`;
    const proc = runBun(
      ['run', 'src/scripts/monitor-episodes.ts', 'consolidate', missingSession, '--strict'],
      env,
    );

    expect(proc.status).toBe(1);
    expect(proc.stdout).toContain('"success":false');
  });

  it('monitor-episodes consolidate --strict succeeds with mock llm/embed command', async () => {
    if (!shouldRunIntegration) {
      skipMessage('phase3 integration disabled (set RUN_BATCH_PROCESS_INTEGRATION=1)');
      return;
    }
    if (!dbReady || !pool) {
      skipMessage('phase3 integration skipped (database unavailable)');
      return;
    }

    const env = {
      ...process.env,
      DATABASE_URL: connectionString,
      GNOSIS_GEMMA4_SCRIPT: llmMockScript,
      GNOSIS_BONSAI_SCRIPT: llmMockScript,
      GNOSIS_OPENAI_SCRIPT: llmMockScript,
      GNOSIS_BEDROCK_SCRIPT: llmMockScript,
      GNOSIS_EMBED_COMMAND: embedMockScript,
      MEMORY_LOOP_ALLOW_CLOUD: '0',
    };

    let sessionId: string | undefined;
    let episodeId: string | undefined;

    try {
      const register = runBun(
        [
          'run',
          'src/scripts/monitor-episodes.ts',
          'register',
          `phase3 strict success ${Date.now()}`,
        ],
        env,
      );
      expect(register.status).toBe(0);
      const registerPayload = parseLastJsonLine(register.stdout);
      expect(registerPayload.success).toBe(true);
      sessionId = registerPayload.sessionId as string;
      expect(typeof sessionId).toBe('string');

      const consolidate = runBun(
        ['run', 'src/scripts/monitor-episodes.ts', 'consolidate', sessionId, '--strict'],
        env,
      );
      expect(consolidate.status).toBe(0);

      const payload = parseLastJsonLine(consolidate.stdout);
      expect(payload.success).toBe(true);
      expect(typeof payload.episodeId).toBe('string');
      episodeId = payload.episodeId as string;
    } finally {
      if (sessionId) {
        await cleanupSessionData(pool, sessionId, episodeId).catch(() => undefined);
      }
    }
  }, 30000);
});
