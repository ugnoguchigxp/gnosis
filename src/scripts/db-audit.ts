import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

type TableStatRow = {
  schema_name: string;
  table_name: string;
  live_rows: number;
  dead_rows: number;
  seq_scan: number;
  idx_scan: number;
  index_scan_ratio: number;
  last_vacuum: Date | null;
  last_autovacuum: Date | null;
  last_analyze: Date | null;
  last_autoanalyze: Date | null;
  total_size: string;
  total_bytes: number;
};

type MissingFkIndexRow = {
  table_name: string;
  constraint_name: string;
  definition: string;
};

function isJsonMode(): boolean {
  return process.argv.includes('--json');
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value: unknown): Date | null {
  return value instanceof Date ? value : null;
}

function formatDate(value: Date | null): string {
  return value ? value.toISOString() : '-';
}

async function loadTableStats(): Promise<TableStatRow[]> {
  const result = await db.execute(sql`
    SELECT
      schemaname AS schema_name,
      relname AS table_name,
      n_live_tup::bigint AS live_rows,
      n_dead_tup::bigint AS dead_rows,
      seq_scan::bigint AS seq_scan,
      idx_scan::bigint AS idx_scan,
      COALESCE(
        ROUND((idx_scan::numeric / NULLIF(seq_scan + idx_scan, 0)::numeric) * 100, 2),
        0
      ) AS index_scan_ratio,
      last_vacuum,
      last_autovacuum,
      last_analyze,
      last_autoanalyze,
      pg_size_pretty(pg_total_relation_size((quote_ident(schemaname) || '.' || quote_ident(relname))::regclass)) AS total_size,
      pg_total_relation_size((quote_ident(schemaname) || '.' || quote_ident(relname))::regclass)::bigint AS total_bytes
    FROM pg_stat_user_tables
    ORDER BY total_bytes DESC, table_name ASC
  `);

  return result.rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      schema_name: String(record.schema_name ?? 'public'),
      table_name: String(record.table_name ?? ''),
      live_rows: toNumber(record.live_rows),
      dead_rows: toNumber(record.dead_rows),
      seq_scan: toNumber(record.seq_scan),
      idx_scan: toNumber(record.idx_scan),
      index_scan_ratio: toNumber(record.index_scan_ratio),
      last_vacuum: toDate(record.last_vacuum),
      last_autovacuum: toDate(record.last_autovacuum),
      last_analyze: toDate(record.last_analyze),
      last_autoanalyze: toDate(record.last_autoanalyze),
      total_size: String(record.total_size ?? '-'),
      total_bytes: toNumber(record.total_bytes),
    };
  });
}

async function loadMissingFkIndexes(): Promise<MissingFkIndexRow[]> {
  const result = await db.execute(sql`
    SELECT
      c.conrelid::regclass::text AS table_name,
      c.conname AS constraint_name,
      pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_index i
        WHERE i.indrelid = c.conrelid
          AND i.indisready
          AND i.indisvalid
          AND i.indpred IS NULL
          AND cardinality(i.indkey::smallint[]) >= cardinality(c.conkey::smallint[])
          AND (i.indkey::smallint[])[0:cardinality(c.conkey::smallint[]) - 1] = c.conkey::smallint[]
      )
    ORDER BY 1, 2
  `);

  return result.rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      table_name: String(record.table_name ?? ''),
      constraint_name: String(record.constraint_name ?? ''),
      definition: String(record.definition ?? ''),
    };
  });
}

async function main() {
  const [stats, missingFkIndexes] = await Promise.all([loadTableStats(), loadMissingFkIndexes()]);

  const unusedTables = stats.filter(
    (row) => row.live_rows === 0 && row.seq_scan === 0 && row.idx_scan === 0,
  );
  const coldTables = stats.filter(
    (row) => row.live_rows > 0 && row.seq_scan === 0 && row.idx_scan === 0,
  );
  const seqScanHeavy = stats.filter(
    (row) => row.live_rows >= 1_000 && row.seq_scan > 0 && row.idx_scan === 0,
  );
  const vacuumCandidates = stats.filter(
    (row) => row.live_rows >= 10_000 && row.dead_rows / Math.max(row.live_rows, 1) >= 0.2,
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    totals: {
      tables: stats.length,
      totalBytes: stats.reduce((acc, row) => acc + row.total_bytes, 0),
    },
    candidates: {
      unusedTables,
      coldTables,
      seqScanHeavy,
      vacuumCandidates,
      missingFkIndexes,
    },
    stats,
  };

  if (isJsonMode()) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('=== Gnosis DB Audit ===');
  console.log(`Generated: ${payload.generatedAt}`);
  console.log(`Tables: ${payload.totals.tables}`);
  console.log('');

  console.log('[Top tables by size]');
  for (const row of stats.slice(0, 10)) {
    console.log(
      `- ${row.schema_name}.${row.table_name}: size=${row.total_size}, rows=${row.live_rows}, dead=${row.dead_rows}, seq=${row.seq_scan}, idx=${row.idx_scan}, idxRatio=${row.index_scan_ratio}%`,
    );
  }

  console.log('');
  console.log(`[Unused tables: ${unusedTables.length}]`);
  for (const row of unusedTables) {
    console.log(`- ${row.schema_name}.${row.table_name}`);
  }

  console.log('');
  console.log(`[Cold tables (rows exist, no scans): ${coldTables.length}]`);
  for (const row of coldTables) {
    console.log(
      `- ${row.schema_name}.${row.table_name}: rows=${row.live_rows}, lastAnalyze=${formatDate(
        row.last_analyze ?? row.last_autoanalyze,
      )}`,
    );
  }

  console.log('');
  console.log(`[Seq-scan heavy tables: ${seqScanHeavy.length}]`);
  for (const row of seqScanHeavy) {
    console.log(
      `- ${row.schema_name}.${row.table_name}: rows=${row.live_rows}, seq=${row.seq_scan}, idx=${row.idx_scan}`,
    );
  }

  console.log('');
  console.log(`[Vacuum candidates: ${vacuumCandidates.length}]`);
  for (const row of vacuumCandidates) {
    const deadRatio = ((row.dead_rows / Math.max(row.live_rows, 1)) * 100).toFixed(1);
    console.log(`- ${row.schema_name}.${row.table_name}: dead/live=${deadRatio}%`);
  }

  console.log('');
  console.log(`[FK index gaps: ${missingFkIndexes.length}]`);
  for (const row of missingFkIndexes) {
    console.log(`- ${row.table_name} (${row.constraint_name}): ${row.definition}`);
  }
}

main().catch((error) => {
  console.error('Failed to run DB audit:', error);
  process.exit(1);
});
