import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { envBoolean } from '../config.js';
import { GNOSIS_CONSTANTS } from '../constants.js';
import { closeDbPool, db } from '../db/index.js';
import {
  experienceLogs,
  knowledgeClaims,
  knowledgeTopics,
  topicTasks,
  vibeMemories,
} from '../db/schema.js';

type QualityGateRecord = {
  status?: string;
  updatedAt?: string | null;
  message?: string | null;
};

type ValueReport = {
  generatedAt: string;
  qualityGates: Record<string, QualityGateRecord>;
  evidence: Record<string, unknown>;
  missingEvidence: string[];
  commands: Record<string, string>;
};

const QUALITY_GATE_NAMES = [
  'doctor',
  'doctorStrict',
  'onboardingSmoke',
  'smoke',
  'semanticSmoke',
  'verifyFast',
  'verify',
  'verifyStrict',
  'mcpContract',
] as const;

async function showNotification(message: string, subtitle = 'Gnosis Metrics') {
  const title = 'Gnosis System Report';
  const command = `osascript -e 'display notification "${message}" with title "${title}" subtitle "${subtitle}"'`;

  return new Promise((resolve, reject) => {
    exec(command, (error) => {
      if (error) reject(error);
      else resolve(true);
    });
  });
}

async function getDbSize(): Promise<string> {
  const result = await db.execute(
    sql`SELECT pg_size_pretty(pg_database_size(current_database())) as size`,
  );
  return (result.rows[0] as { size: string }).size;
}

function parseArgs(argv: string[]): { mode: 'notify' | 'value'; json: boolean } {
  return {
    mode: argv.includes('--value') || argv.includes('--json') ? 'value' : 'notify',
    json: argv.includes('--json'),
  };
}

function readQualityGates(): Record<string, QualityGateRecord> {
  const filePath = join(process.cwd(), 'logs', 'quality-gates.json');
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, QualityGateRecord>;
    }
  } catch {
    return {};
  }
  return {};
}

function gateStatus(gates: Record<string, QualityGateRecord>, name: string): string {
  return gates[name]?.status ?? 'unknown';
}

type FailedQueueReasonRow = {
  reason: string;
  count: number;
  classification: string;
};

export function classifyQueueFailureReason(reason: string): string {
  const normalized = reason.trim().toLowerCase();
  if (normalized.length === 0 || normalized === 'unknown') return 'unknown';
  if (
    normalized.includes('all api attempts failed') ||
    normalized.includes('provider') ||
    normalized.includes('api key') ||
    normalized.includes('rate limit')
  ) {
    return 'llm_provider_unavailable';
  }
  if (
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('aborted')
  ) {
    return 'timeout';
  }
  if (
    normalized.includes('failed query') ||
    normalized.includes('database') ||
    normalized.includes('postgres') ||
    normalized.includes('econnrefused') ||
    normalized.includes('connection refused')
  ) {
    return 'db_connectivity';
  }
  if (
    normalized.includes('validation') ||
    normalized.includes('invalid') ||
    normalized.includes('schema') ||
    normalized.includes('parse') ||
    normalized.includes('requires ')
  ) {
    return 'input_validation';
  }
  if (
    normalized.includes('http ') ||
    normalized.includes('fetch failed') ||
    normalized.includes('search failed') ||
    normalized.includes('network')
  ) {
    return 'network_or_fetch';
  }
  if (
    normalized.includes('system_task_exception') ||
    normalized.includes('unexpected crash') ||
    normalized.includes('typeerror') ||
    normalized.includes('referenceerror') ||
    normalized.includes('worker')
  ) {
    return 'worker_runtime';
  }
  return 'task_failure';
}

async function collectQueueBacklogEvidence(): Promise<{
  reachable: boolean;
  statuses: {
    pending: number;
    running: number;
    deferred: number;
    failed: number;
  } | null;
  failedReasonClasses: FailedQueueReasonRow[];
}> {
  try {
    const statusRows = await db
      .select({
        status: topicTasks.status,
        count: sql<number>`count(*)::int`,
      })
      .from(topicTasks)
      .where(sql`${topicTasks.status} IN ('pending', 'running', 'deferred', 'failed')`)
      .groupBy(topicTasks.status);

    const statuses = {
      pending: 0,
      running: 0,
      deferred: 0,
      failed: 0,
    };
    for (const row of statusRows) {
      if (
        row.status === 'pending' ||
        row.status === 'running' ||
        row.status === 'deferred' ||
        row.status === 'failed'
      ) {
        statuses[row.status] = Number(row.count) || 0;
      }
    }

    const failedReasonRows = await db
      .select({
        errorReason: sql<string>`COALESCE(${topicTasks.payload}->>'errorReason', 'unknown')`,
        count: sql<number>`count(*)::int`,
      })
      .from(topicTasks)
      .where(sql`${topicTasks.status} = 'failed'`)
      .groupBy(sql`COALESCE(${topicTasks.payload}->>'errorReason', 'unknown')`);

    const rows = failedReasonRows.map((row) => {
      const reason = typeof row.errorReason === 'string' ? row.errorReason : 'unknown';
      return {
        reason,
        count: Number(row.count) || 0,
        classification: classifyQueueFailureReason(reason),
      };
    });

    return {
      reachable: true,
      statuses,
      failedReasonClasses: rows,
    };
  } catch {
    return {
      reachable: false,
      statuses: null,
      failedReasonClasses: [],
    };
  }
}

async function buildValueReport(): Promise<ValueReport> {
  const qualityGates = readQualityGates();
  const queueBacklog = await collectQueueBacklogEvidence();
  const missingEvidence: string[] = [];
  for (const gate of QUALITY_GATE_NAMES) {
    if (gateStatus(qualityGates, gate) !== 'passed') {
      missingEvidence.push(`${gate}: ${gateStatus(qualityGates, gate)}`);
    }
  }

  const failedOrUnknownGates = QUALITY_GATE_NAMES.filter(
    (gate) => gateStatus(qualityGates, gate) !== 'passed',
  ).map((gate) => ({
    gate,
    status: gateStatus(qualityGates, gate),
    message: qualityGates[gate]?.message ?? null,
  }));
  const knownDegradedReasons: Array<Record<string, unknown>> = [...failedOrUnknownGates];
  if ((queueBacklog.statuses?.failed ?? 0) > 0) {
    knownDegradedReasons.push({
      gate: 'queueBacklog',
      status: 'degraded',
      message: `failed=${queueBacklog.statuses?.failed ?? 0}`,
      classifications: queueBacklog.failedReasonClasses.map((row) => row.classification),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    qualityGates,
    evidence: {
      primary6ToolExposure: {
        doctor: gateStatus(qualityGates, 'doctor'),
        mcpContract: gateStatus(qualityGates, 'mcpContract'),
      },
      doctorResult: qualityGates.doctor ?? { status: 'unknown' },
      smokeResult: qualityGates.smoke ?? { status: 'unknown' },
      strictResult: qualityGates.doctorStrict ?? { status: 'unknown' },
      semanticSmoke: qualityGates.semanticSmoke ?? { status: 'unknown' },
      verifyFast: qualityGates.verifyFast ?? { status: 'unknown' },
      verify: qualityGates.verify ?? { status: 'unknown' },
      verifyStrict: qualityGates.verifyStrict ?? { status: 'unknown' },
      monitorQueueInterpretation: {
        command: 'bun run monitor:snapshot -- --json',
        note: 'Use monitor snapshot for live queue, KnowFlow, and backlog interpretation.',
      },
      queueBacklog,
      latestAgenticSearchSmoke: {
        command: 'bun run agentic-search:semantic-smoke',
        status: gateStatus(qualityGates, 'semanticSmoke'),
      },
      latestReviewTaskSmoke: {
        command: 'bun run smoke',
        status: gateStatus(qualityGates, 'smoke'),
      },
      docsLinkCheck: {
        command: 'rg -n "TODO|存在しない|unavailable_in_minimal_mode" README.md docs',
        note: 'Run before final value-score updates when docs changed.',
      },
      knownDegradedReasons,
    },
    missingEvidence,
    commands: {
      doctor: 'bun run doctor',
      doctorStrict: 'GNOSIS_DOCTOR_STRICT=1 bun run doctor',
      smoke: 'bun run smoke',
      semanticSmoke: 'bun run agentic-search:semantic-smoke',
      verifyFast: 'bun run verify:fast',
      verify: 'bun run verify',
      verifyStrict: 'bun run verify:strict',
      monitorSnapshot: 'bun run monitor:snapshot -- --json',
    },
  };
}

function renderValueReport(report: ValueReport): string {
  const lines = [
    '# Gnosis Value Evidence Report',
    '',
    `generatedAt: ${report.generatedAt}`,
    '',
    '## Quality Gates',
    ...QUALITY_GATE_NAMES.map((gate) => {
      const record = report.qualityGates[gate];
      const updatedAt = record?.updatedAt ? ` updatedAt=${record.updatedAt}` : '';
      const message = record?.message ? ` message=${record.message}` : '';
      return `- ${gate}: ${record?.status ?? 'unknown'}${updatedAt}${message}`;
    }),
    '',
    '## Evidence Commands',
    ...Object.entries(report.commands).map(([name, command]) => `- ${name}: ${command}`),
    '',
    '## Missing Evidence',
    ...(report.missingEvidence.length > 0
      ? report.missingEvidence.map((item) => `- ${item}`)
      : ['- none']),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

async function runValueReport(json: boolean): Promise<void> {
  const report = await buildValueReport();
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderValueReport(report));
}

async function runNotificationReport() {
  const automationEnabled = envBoolean(
    process.env.GNOSIS_ENABLE_AUTOMATION,
    GNOSIS_CONSTANTS.AUTOMATION_ENABLED_DEFAULT,
  );
  if (!automationEnabled) {
    console.log('[status-report] Automation is OFF. Skipping scheduled report.');
    process.exit(0);
  }

  try {
    const size = await getDbSize();

    // 並列で集計
    const [topicCount, claimCount, skillCount, memoryCount, expCount] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(knowledgeTopics)
        .then((r) => r[0].count),
      db
        .select({ count: sql<number>`count(*)` })
        .from(knowledgeClaims)
        .then((r) => r[0].count),
      db
        .select({ count: sql<number>`count(*)` })
        .from(vibeMemories)
        .where(sql`${vibeMemories.metadata}->>'kind' = 'guidance'`)
        .then((r) => r[0].count),
      db
        .select({ count: sql<number>`count(*)` })
        .from(vibeMemories)
        .where(
          sql`${vibeMemories.metadata}->>'kind' IS NULL OR ${vibeMemories.metadata}->>'kind' != 'guidance'`,
        )
        .then((r) => r[0].count),
      db
        .select({ count: sql<number>`count(*)` })
        .from(experienceLogs)
        .then((r) => r[0].count),
    ]);

    const message = `DB: ${size} / 知識: ${topicCount}個(${claimCount}事実) / スキル: ${skillCount}件 / 記憶: ${memoryCount}件 / 経験: ${expCount}件`;

    await showNotification(message);
    console.log('Notification sent:', message);

    process.exit(0);
  } catch (error) {
    console.error('Failed to generate report:', error);
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'value') {
    await runValueReport(args.json);
    await closeDbPool();
    process.exit(0);
  }
  await runNotificationReport();
}

if (import.meta.main) {
  main();
}
