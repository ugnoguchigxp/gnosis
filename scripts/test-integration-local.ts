import { Pool } from 'pg';
import { loadLocalEnv, runCommand } from './lib/quality.js';

const INTEGRATION_FILES = [
  'src/services/memory.spec.ts',
  'src/services/graph.spec.ts',
  'test/knowflow/knowledgeSearch.integration.test.ts',
  'test/knowflow/queuePostgres.integration.test.ts',
];

const run = async () => {
  loadLocalEnv();

  if (!process.env.DATABASE_URL) {
    process.stdout.write(
      '[integration-local] skipped: DATABASE_URL is not set. Configure PostgreSQL locally to run integration tests.\n',
    );
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 1_000,
  });

  try {
    await pool.query('select 1');
  } catch {
    process.stdout.write(
      '[integration-local] skipped: DATABASE_URL is set, but PostgreSQL is not reachable. Start the local database before rerunning.\n',
    );
    return;
  } finally {
    await pool.end().catch(() => undefined);
  }

  const bun = process.argv[0];
  const result = await runCommand(bun, ['test', ...INTEGRATION_FILES], {
    env: {
      ...process.env,
      GNOSIS_RUN_INTEGRATION: '1',
      KNOWFLOW_RUN_INTEGRATION: '1',
    },
  });

  if (result.code !== 0) {
    process.exit(result.code);
  }
};

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
