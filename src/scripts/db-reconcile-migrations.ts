import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { buildExpectedMigrations } from '../db/migrationMeta.js';

type AppliedMigrationRow = {
  id: number;
  hash: string;
  created_at: number | null;
};

const CORE_TABLES = ['entities', 'relations', 'vibe_memories'] as const;
const REQUIRED_TABLES = [
  'entities',
  'relations',
  'vibe_memories',
  'sync_state',
  'communities',
  'experience_logs',
  'topic_tasks',
  'knowflow_keyword_evaluations',
  'knowledge_topics',
  'knowledge_claims',
  'knowledge_relations',
  'knowledge_sources',
  'review_cases',
  'review_outcomes',
] as const;
const REQUIRED_INDEXES = [
  'topic_tasks_active_dedupe_idx',
  'topic_tasks_running_updated_idx',
  'idx_review_outcomes_guidance_ids_gin',
  'entities_community_id_idx',
] as const;

function inList(values: readonly string[]) {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

async function ensureMigrationTable(): Promise<void> {
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
}

async function loadAppliedMigrations(): Promise<AppliedMigrationRow[]> {
  const result = await db.execute(sql`
    SELECT id, hash, created_at
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at ASC, id ASC
  `);
  return result.rows as AppliedMigrationRow[];
}

async function countPublicTables(tableNames: readonly string[]): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (${inList(tableNames)})
  `);
  const row = result.rows[0] as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

async function countPublicIndexes(indexNames: readonly string[]): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (${inList(indexNames)})
  `);
  const row = result.rows[0] as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

async function isFullyProvisionedLegacySchema(): Promise<boolean> {
  const [tableCount, indexCount] = await Promise.all([
    countPublicTables(REQUIRED_TABLES),
    countPublicIndexes(REQUIRED_INDEXES),
  ]);
  return tableCount === REQUIRED_TABLES.length && indexCount === REQUIRED_INDEXES.length;
}

async function repairHashDrift(
  expected: Array<{ hash: string; createdAt: number; tag: string }>,
  applied: AppliedMigrationRow[],
): Promise<number> {
  const expectedByCreatedAt = new Map(expected.map((entry) => [entry.createdAt, entry]));

  let repaired = 0;
  for (const row of applied) {
    if (row.created_at === null) continue;
    const match = expectedByCreatedAt.get(Number(row.created_at));
    if (!match || row.hash === match.hash) continue;

    await db.execute(sql`
      UPDATE drizzle.__drizzle_migrations
      SET hash = ${match.hash}
      WHERE id = ${row.id}
    `);
    repaired += 1;
  }

  return repaired;
}

async function baselineLegacyDatabase(
  expected: Array<{ hash: string; createdAt: number }>,
): Promise<void> {
  for (const migration of expected) {
    await db.execute(sql`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${migration.hash}, ${migration.createdAt})
    `);
  }
}

async function main() {
  await ensureMigrationTable();

  const expected = (await buildExpectedMigrations()).map((entry) => ({
    tag: entry.tag,
    hash: entry.hash,
    createdAt: entry.when,
  }));

  const applied = await loadAppliedMigrations();

  if (applied.length > 0) {
    const repaired = await repairHashDrift(expected, applied);
    if (repaired > 0) {
      console.log(`Reconciled ${repaired} migration hash record(s).`);
    } else {
      console.log('Migration records are already consistent.');
    }
    return;
  }

  const coreTables = await countPublicTables(CORE_TABLES);
  if (coreTables === 0) {
    console.log('Fresh database detected (no baseline reconciliation needed).');
    return;
  }

  const fullyProvisioned = await isFullyProvisionedLegacySchema();
  if (!fullyProvisioned) {
    throw new Error(
      'Legacy schema detected with empty drizzle.__drizzle_migrations, but schema is only partially provisioned. Refusing auto-baseline to avoid corruption. Complete schema setup or start from a clean DB.',
    );
  }

  await baselineLegacyDatabase(expected);
  console.log(`Backfilled drizzle.__drizzle_migrations with ${expected.length} entries.`);
}

main().catch((error) => {
  console.error('Failed to reconcile migration metadata:', error);
  process.exit(1);
});
