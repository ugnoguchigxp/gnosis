import { sql } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { parseArgMap } from '../services/knowflow/utils/args.js';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output.js';

type FirewallRow = {
  kind: 'golden_path' | 'pattern';
  id: string;
  title: string;
  status: string;
  severity: string;
  updatedAt: string | null;
};

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);

  let rowsRaw: Array<Record<string, unknown>> = [];
  try {
    const result = await db.execute(
      sql.raw(`
      SELECT 'golden_path'::text AS kind, id, title, status, severity_when_missing AS severity, updated_at::text AS updated_at
      FROM failure_firewall_golden_paths
      UNION ALL
      SELECT 'pattern'::text AS kind, id, title, status, severity, updated_at::text AS updated_at
      FROM failure_firewall_patterns
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1000
    `),
    );
    rowsRaw = result.rows as Array<Record<string, unknown>>;
  } catch {
    rowsRaw = [];
  }

  const rows: FirewallRow[] = rowsRaw.map((row) => ({
    kind: row.kind === 'golden_path' ? 'golden_path' : 'pattern',
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    status: String(row.status ?? ''),
    severity: String(row.severity ?? ''),
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
  }));

  process.stdout.write(renderOutput(rows, outputFormat));
};

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await closeDbPool();
});
