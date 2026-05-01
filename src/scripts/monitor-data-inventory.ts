import { sql } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { parseArgMap } from '../services/knowflow/utils/args.js';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output.js';

type MaintenanceState = 'active' | 'deprecated';

type InventoryRow = {
  category: string;
  table: string;
  rowCount: number;
  latestUpdatedAt: string | null;
  statusCounts: Record<string, number>;
  maintenanceState: MaintenanceState;
};

type InventorySignal = {
  key: string;
  label: string;
  value: number;
  unit: 'count' | 'percent';
};

type InventoryPayload = {
  ts: number;
  categories: InventoryRow[];
  signals: InventorySignal[];
};

const asNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

const countRows = async (table: string): Promise<number> => {
  try {
    const result = await db.execute(sql`SELECT count(*)::int AS count FROM ${sql.raw(table)}`);
    const row = result.rows[0] as { count?: number | string } | undefined;
    return asNumber(row?.count ?? 0);
  } catch {
    return 0;
  }
};

const latestTimestamp = async (table: string, column: string): Promise<string | null> => {
  try {
    const result = await db.execute(
      sql`SELECT max(${sql.raw(column)}) AS latest FROM ${sql.raw(table)}`,
    );
    const row = result.rows[0] as { latest?: Date | string | null } | undefined;
    if (!row?.latest) return null;
    if (row.latest instanceof Date) return row.latest.toISOString();
    const date = new Date(String(row.latest));
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
};

const statusBreakdown = async (
  table: string,
  column = 'status',
): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  try {
    const result = await db.execute(
      sql`SELECT ${sql.raw(column)} AS status, count(*)::int AS count FROM ${sql.raw(
        table,
      )} GROUP BY ${sql.raw(column)}`,
    );
    for (const row of result.rows as Array<{ status?: string; count?: number | string }>) {
      const key = typeof row.status === 'string' && row.status.length > 0 ? row.status : 'unknown';
      counts[key] = asNumber(row.count ?? 0);
    }
  } catch {
    return {};
  }
  return counts;
};

const tableExists = async (table: string): Promise<boolean> => {
  const result = await db.execute(sql`SELECT to_regclass(${table}) AS reg`);
  const row = result.rows[0] as { reg?: string | null } | undefined;
  return typeof row?.reg === 'string' && row.reg.length > 0;
};

const countWhere = async (table: string, whereSql: string): Promise<number> => {
  try {
    const result = await db.execute(
      sql.raw(`SELECT count(*)::int AS count FROM ${table} WHERE ${whereSql}`),
    );
    const row = result.rows[0] as { count?: number | string } | undefined;
    return asNumber(row?.count ?? 0);
  } catch {
    return 0;
  }
};

const buildInventory = async (): Promise<InventoryPayload> => {
  const hookExecutionsExists = await tableExists('hook_executions');
  const hookCandidatesExists = await tableExists('hook_candidates');

  const [
    taskStatusCounts,
    failurePathCounts,
    failurePatternCounts,
    reviewCaseCounts,
    reviewOutcomeCounts,
  ] = await Promise.all([
    statusBreakdown('topic_tasks'),
    statusBreakdown('failure_firewall_golden_paths'),
    statusBreakdown('failure_firewall_patterns'),
    statusBreakdown('review_cases'),
    statusBreakdown('review_outcomes', 'outcome_type'),
  ]);

  const categories: InventoryRow[] = [
    {
      category: 'queue',
      table: 'topic_tasks',
      rowCount: await countRows('topic_tasks'),
      latestUpdatedAt: await latestTimestamp('topic_tasks', 'updated_at'),
      statusCounts: taskStatusCounts,
      maintenanceState: 'active',
    },
    {
      category: 'failure_firewall',
      table: 'failure_firewall_golden_paths',
      rowCount: await countRows('failure_firewall_golden_paths'),
      latestUpdatedAt: await latestTimestamp('failure_firewall_golden_paths', 'updated_at'),
      statusCounts: failurePathCounts,
      maintenanceState: 'active',
    },
    {
      category: 'failure_firewall',
      table: 'failure_firewall_patterns',
      rowCount: await countRows('failure_firewall_patterns'),
      latestUpdatedAt: await latestTimestamp('failure_firewall_patterns', 'updated_at'),
      statusCounts: failurePatternCounts,
      maintenanceState: 'active',
    },
    {
      category: 'review',
      table: 'review_cases',
      rowCount: await countRows('review_cases'),
      latestUpdatedAt: await latestTimestamp('review_cases', 'created_at'),
      statusCounts: reviewCaseCounts,
      maintenanceState: 'active',
    },
    {
      category: 'review',
      table: 'review_outcomes',
      rowCount: await countRows('review_outcomes'),
      latestUpdatedAt: await latestTimestamp('review_outcomes', 'created_at'),
      statusCounts: reviewOutcomeCounts,
      maintenanceState: 'active',
    },
    {
      category: 'knowflow_corpus',
      table: 'knowledge_topics',
      rowCount: await countRows('knowledge_topics'),
      latestUpdatedAt: await latestTimestamp('knowledge_topics', 'updated_at'),
      statusCounts: {},
      maintenanceState: 'active',
    },
    {
      category: 'knowflow_corpus',
      table: 'knowledge_sources',
      rowCount: await countRows('knowledge_sources'),
      latestUpdatedAt: await latestTimestamp('knowledge_sources', 'updated_at'),
      statusCounts: {},
      maintenanceState: 'active',
    },
    {
      category: 'knowflow_evals',
      table: 'knowflow_keyword_evaluations',
      rowCount: await countRows('knowflow_keyword_evaluations'),
      latestUpdatedAt: await latestTimestamp('knowflow_keyword_evaluations', 'created_at'),
      statusCounts: {},
      maintenanceState: 'active',
    },
    {
      category: 'communities',
      table: 'communities',
      rowCount: await countRows('communities'),
      latestUpdatedAt: await latestTimestamp('communities', 'created_at'),
      statusCounts: {},
      maintenanceState: 'active',
    },
    {
      category: 'communities',
      table: 'entities',
      rowCount: await countRows('entities'),
      latestUpdatedAt: await latestTimestamp('entities', 'created_at'),
      statusCounts: {},
      maintenanceState: 'active',
    },
    {
      category: 'sync',
      table: 'sync_state',
      rowCount: await countRows('sync_state'),
      latestUpdatedAt: await latestTimestamp('sync_state', 'updated_at'),
      statusCounts: {},
      maintenanceState: 'active',
    },
    {
      category: 'legacy_hooks',
      table: 'hook_executions',
      rowCount: hookExecutionsExists ? await countRows('hook_executions') : 0,
      latestUpdatedAt: hookExecutionsExists
        ? await latestTimestamp('hook_executions', 'updated_at')
        : null,
      statusCounts: hookExecutionsExists ? await statusBreakdown('hook_executions') : {},
      maintenanceState: 'deprecated',
    },
    {
      category: 'legacy_hooks',
      table: 'hook_candidates',
      rowCount: hookCandidatesExists ? await countRows('hook_candidates') : 0,
      latestUpdatedAt: hookCandidatesExists
        ? await latestTimestamp('hook_candidates', 'updated_at')
        : null,
      statusCounts: hookCandidatesExists ? await statusBreakdown('hook_candidates') : {},
      maintenanceState: 'deprecated',
    },
  ];

  const [
    doneTasks,
    runningTasks,
    staleRunningTasks,
    needsReviewGolden,
    needsReviewPatterns,
    staleKnowledgeSources,
    pendingReviewCases,
    pendingReviewOutcomes,
  ] = await Promise.all([
    countWhere('topic_tasks', `status = 'done'`),
    countWhere('topic_tasks', `status = 'running'`),
    countWhere('topic_tasks', `status = 'running' AND updated_at < now() - interval '30 minutes'`),
    countWhere('failure_firewall_golden_paths', `status = 'needs_review'`),
    countWhere('failure_firewall_patterns', `status = 'needs_review'`),
    countWhere(
      'knowledge_sources',
      `fetched_at < extract(epoch from now() - interval '30 days') * 1000`,
    ),
    countWhere('review_cases', `status = 'running'`),
    countWhere('review_outcomes', `outcome_type = 'pending'`),
  ]);

  const signals: InventorySignal[] = [
    { key: 'queue_done_total', label: 'Queue done total', value: doneTasks, unit: 'count' },
    {
      key: 'queue_running_total',
      label: 'Queue running total',
      value: runningTasks,
      unit: 'count',
    },
    {
      key: 'queue_stale_running',
      label: 'Queue stale running(>30m)',
      value: staleRunningTasks,
      unit: 'count',
    },
    {
      key: 'firewall_needs_review_total',
      label: 'Failure Firewall needs_review',
      value: needsReviewGolden + needsReviewPatterns,
      unit: 'count',
    },
    {
      key: 'knowledge_sources_stale_30d',
      label: 'Knowledge sources stale(30d)',
      value: staleKnowledgeSources,
      unit: 'count',
    },
    {
      key: 'review_cases_running',
      label: 'Review cases running',
      value: pendingReviewCases,
      unit: 'count',
    },
    {
      key: 'review_outcomes_pending',
      label: 'Review outcomes pending',
      value: pendingReviewOutcomes,
      unit: 'count',
    },
  ];

  return {
    ts: Date.now(),
    categories,
    signals,
  };
};

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);
  const payload = await buildInventory();
  process.stdout.write(renderOutput(payload, outputFormat));
};

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await closeDbPool();
});
