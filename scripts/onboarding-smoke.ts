#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import path from 'node:path';
import pkg from 'pg';
import { recordQualityGate } from './lib/quality-gates.js';
import { COLORS, loadLocalEnv } from './lib/quality.ts';

const { Pool } = pkg;

const ROOT_DIR = process.cwd();
const BUN = process.env.GNOSIS_BUN_COMMAND || process.argv[0] || 'bun';

type SmokeCheck = {
  name: string;
  run: () => Promise<void>;
};

function fail(message: string): never {
  process.stderr.write(`${COLORS.red}${message}${COLORS.reset}\n`);
  process.exit(1);
}

async function withDb<T>(fn: (pool: InstanceType<typeof Pool>) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set.');
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    return await fn(pool);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function checkDbConnection(): Promise<void> {
  await withDb(async (pool) => {
    await pool.query('select 1');
  });
}

async function checkVectorExtension(): Promise<void> {
  await withDb(async (pool) => {
    const result = await pool.query<{ exists: boolean }>(
      "select exists(select 1 from pg_extension where extname = 'vector') as exists",
    );
    if (!result.rows[0]?.exists) {
      throw new Error('pgvector extension "vector" is not enabled.');
    }
  });
}

async function checkSeedMarker(): Promise<void> {
  await withDb(async (pool) => {
    const result = await pool.query<{ exists: boolean }>(
      'select exists(select 1 from vibe_memories where metadata @> \'{"seedMarker":"gnosis-bootstrap-v1"}\'::jsonb) as exists',
    );
    if (!result.rows[0]?.exists) {
      throw new Error('Seed marker was not found. Run `bun run db:seed`.');
    }
  });
}

async function checkMcpStartup(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(BUN, ['run', 'src/index.ts'], {
      cwd: ROOT_DIR,
      env: { ...process.env, GNOSIS_NO_WORKERS: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    let stderr = '';
    let settled = false;

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    const closeTimer = setTimeout(() => {
      child.stdin.end();
    }, 1200);

    const hardTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('MCP startup probe timed out.'));
    }, 10000);

    child.on('close', (code) => {
      clearTimeout(closeTimer);
      clearTimeout(hardTimeout);
      if (settled) return;
      settled = true;

      if (code === 0) {
        resolve();
        return;
      }

      if (stderr.includes('already running')) {
        resolve();
        return;
      }

      reject(new Error(`MCP startup failed (exit=${code}). ${stderr.trim()}`));
    });
  });
}

async function run(): Promise<void> {
  loadLocalEnv(path.join(ROOT_DIR, '.env'));

  const checks: SmokeCheck[] = [
    { name: 'DB connection', run: checkDbConnection },
    { name: 'pgvector extension', run: checkVectorExtension },
    { name: 'seed marker', run: checkSeedMarker },
    { name: 'MCP minimal startup', run: checkMcpStartup },
  ];

  process.stdout.write(`${COLORS.cyan}=== Gnosis Onboarding Smoke ===${COLORS.reset}\n`);
  for (const check of checks) {
    process.stdout.write(`${COLORS.cyan}>>> ${check.name}${COLORS.reset}\n`);
    await check.run();
    process.stdout.write(`${COLORS.green}✔ ${check.name}${COLORS.reset}\n`);
  }
  recordQualityGate('onboardingSmoke', 'passed', 'bun run onboarding:smoke passed');
  process.stdout.write(`${COLORS.green}✨ onboarding:smoke passed${COLORS.reset}\n`);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  recordQualityGate('onboardingSmoke', 'failed', message);
  fail(`onboarding:smoke failed\n${message}`);
});
