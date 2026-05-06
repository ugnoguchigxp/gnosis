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
  projectValueEvidence: ProjectValueEvidence;
  missingEvidence: string[];
  commands: Record<string, string>;
};

const QUALITY_GATE_NAMES = [
  'doctor',
  'doctorStrict',
  'onboardingSmoke',
  'smoke',
  'semanticSmoke',
  'freshCloneValueSmoke',
  'verifyFast',
  'verify',
  'verifyStrict',
  'mcpContract',
] as const;

const VALUE_EVIDENCE_MAX_DURATION_MS = 300_000;

type QueueBacklogStatus = 'unknown' | 'clear' | 'needs_attention' | 'blocked';

type QueueBacklogEvidence = {
  reachable: boolean;
  statuses: {
    pending: number;
    running: number;
    deferred: number;
    failed: number;
  } | null;
  failedReasonClasses: FailedQueueReasonRow[];
};

export type QueueBacklogInterpretation = {
  status: QueueBacklogStatus;
  failedCount: number | null;
  deferredCount: number | null;
  failedReasonClasses: string[];
  humanSummary: string;
  nextCommand: string;
};

type ClaimAllowed =
  | 'stable_ok'
  | 'single_run_ok'
  | 'structured_degraded_only'
  | 'skipped_with_reason'
  | 'missing_evidence';

type ProjectValueEvidenceItem = {
  status: 'passed' | 'failed' | 'degraded' | 'skipped' | 'missing';
  claimAllowed: ClaimAllowed;
  command?: string;
  reason?: string;
  details?: Record<string, unknown>;
};

type ProjectValueEvidence = {
  scoreReady: boolean;
  missingEvidence: string[];
  claimAllowed: {
    reviewTaskLocal: ClaimAllowed;
    monitorBacklog: ClaimAllowed;
    freshCloneValueArrival: ClaimAllowed;
  };
  reviewTaskLocal: ProjectValueEvidenceItem;
  reviewTaskDegradedSemantics: ProjectValueEvidenceItem;
  monitorBacklogInterpretation: ProjectValueEvidenceItem;
  freshCloneValueArrival: ProjectValueEvidenceItem;
  successExamples: ProjectValueEvidenceItem;
  docsLinks: ProjectValueEvidenceItem;
};

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

function readJsonArtifact(filePath: string): unknown | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
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
    normalized.includes('tool/think block parse failure') ||
    normalized.includes('tool call or think block') ||
    normalized.includes('empty-output sentinel')
  ) {
    return 'llm_control_parse_failure';
  }
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

export function interpretQueueBacklog(
  queueBacklog: QueueBacklogEvidence,
): QueueBacklogInterpretation {
  if (!queueBacklog.reachable || !queueBacklog.statuses) {
    return {
      status: 'unknown',
      failedCount: null,
      deferredCount: null,
      failedReasonClasses: [],
      humanSummary: 'Queue backlog could not be read; check DATABASE_URL and Postgres.',
      nextCommand: 'bun run doctor',
    };
  }

  const failedCount = queueBacklog.statuses.failed;
  const deferredCount = queueBacklog.statuses.deferred;
  const failedReasonClasses = [
    ...new Set(queueBacklog.failedReasonClasses.map((row) => row.classification)),
  ];
  if (failedCount === 0 && deferredCount === 0) {
    return {
      status: 'clear',
      failedCount,
      deferredCount,
      failedReasonClasses,
      humanSummary: 'Queue backlog is clear.',
      nextCommand: 'bun run monitor:snapshot -- --json',
    };
  }

  const blockingClasses = new Set(['db_connectivity', 'input_validation', 'worker_runtime']);
  const hasBlockingClass = failedReasonClasses.some((classification) =>
    blockingClasses.has(classification),
  );
  const status: QueueBacklogStatus =
    failedCount > 0 && hasBlockingClass ? 'blocked' : 'needs_attention';
  const nextCommand =
    failedCount > 0 ? 'bun run monitor:knowflow-failures -- --json' : 'bun run task:knowflow:once';

  return {
    status,
    failedCount,
    deferredCount,
    failedReasonClasses,
    humanSummary:
      status === 'blocked'
        ? `Queue backlog has ${failedCount} failed task(s) with blocking reason classes.`
        : `Queue runtime may be healthy, but backlog still needs attention: failed=${failedCount}, deferred=${deferredCount}.`,
    nextCommand,
  };
}

function latestArtifactRecord(fileName: string): Record<string, unknown> | null {
  const value = readJsonArtifact(join(process.cwd(), 'logs', fileName));
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function evidenceFromGate(
  gates: Record<string, QualityGateRecord>,
  gate: string,
  command: string,
): ProjectValueEvidenceItem {
  const status = gateStatus(gates, gate);
  if (status === 'passed') {
    return { status: 'passed', claimAllowed: 'stable_ok', command };
  }
  if (status === 'failed') {
    return {
      status: 'failed',
      claimAllowed: 'missing_evidence',
      command,
      reason: gates[gate]?.message ?? `${gate} failed`,
    };
  }
  return {
    status: 'missing',
    claimAllowed: 'missing_evidence',
    command,
    reason: `${gate} has not been recorded`,
  };
}

export function buildProjectValueEvidence(
  qualityGates: Record<string, QualityGateRecord>,
  queueBacklog: QueueBacklogEvidence,
): ProjectValueEvidence {
  const missingEvidence: string[] = [];
  const queueInterpretation = interpretQueueBacklog(queueBacklog);
  const reviewTaskArtifact = latestArtifactRecord('review-task-local-smoke.json');
  const freshCloneArtifact = latestArtifactRecord('fresh-clone-value-smoke.json');

  const reviewTaskLocal = (() => {
    if (!reviewTaskArtifact) {
      missingEvidence.push('reviewTaskLocal');
      return {
        status: 'missing',
        claimAllowed: 'missing_evidence',
        command: 'bun run review:local-smoke',
        reason: 'logs/review-task-local-smoke.json is missing',
      } satisfies ProjectValueEvidenceItem;
    }
    const status = String(reviewTaskArtifact.status ?? 'missing');
    const durationMs =
      typeof reviewTaskArtifact.durationMs === 'number' ? reviewTaskArtifact.durationMs : null;
    const consecutiveOkRuns =
      typeof reviewTaskArtifact.consecutiveOkRuns === 'number'
        ? reviewTaskArtifact.consecutiveOkRuns
        : status === 'ok'
          ? 1
          : 0;
    if (
      reviewTaskArtifact.passed !== false &&
      status === 'ok' &&
      durationMs !== null &&
      durationMs <= VALUE_EVIDENCE_MAX_DURATION_MS
    ) {
      if (consecutiveOkRuns < 3) {
        missingEvidence.push('reviewTaskLocalStableOk');
      }
      return {
        status: 'passed',
        claimAllowed: consecutiveOkRuns >= 3 ? 'stable_ok' : 'single_run_ok',
        command: String(reviewTaskArtifact.command ?? 'MCP review_task provider=local'),
        details: {
          durationMs,
          provider: reviewTaskArtifact.provider ?? 'local',
          consecutiveOkRuns,
        },
      } satisfies ProjectValueEvidenceItem;
    }
    if (status === 'degraded') {
      return {
        status: 'degraded',
        claimAllowed: 'structured_degraded_only',
        command: String(reviewTaskArtifact.command ?? 'MCP review_task provider=local'),
        reason: 'local review returned structured degraded evidence',
        details: reviewTaskArtifact,
      } satisfies ProjectValueEvidenceItem;
    }
    missingEvidence.push('reviewTaskLocalStableOk');
    return {
      status: 'skipped',
      claimAllowed: 'skipped_with_reason',
      command: String(reviewTaskArtifact.command ?? 'MCP review_task provider=local'),
      reason: String(
        reviewTaskArtifact.reason ?? 'local review did not produce stable ok evidence',
      ),
      details: reviewTaskArtifact,
    } satisfies ProjectValueEvidenceItem;
  })();

  const reviewTaskDegradedSemantics = evidenceFromGate(
    qualityGates,
    'mcpContract',
    'bun test test/mcpContract.test.ts test/mcp/tools/agentFirst.test.ts',
  );

  const monitorBacklogInterpretation: ProjectValueEvidenceItem =
    queueInterpretation.status === 'unknown'
      ? {
          status: 'missing',
          claimAllowed: 'missing_evidence',
          command: 'bun run monitor:snapshot -- --json',
          reason: queueInterpretation.humanSummary,
        }
      : {
          status: queueInterpretation.status === 'clear' ? 'passed' : 'degraded',
          claimAllowed:
            queueInterpretation.status === 'clear' ? 'stable_ok' : 'structured_degraded_only',
          command: queueInterpretation.nextCommand,
          reason: queueInterpretation.humanSummary,
          details: { queueInterpretation },
        };

  if (queueInterpretation.status === 'unknown') {
    missingEvidence.push('monitorBacklogInterpretation');
  }

  const freshCloneValueArrival = (() => {
    const gateEvidence = evidenceFromGate(
      qualityGates,
      'freshCloneValueSmoke',
      'bun run fresh-clone:value-smoke',
    );
    if (gateEvidence.status !== 'passed') {
      missingEvidence.push('freshCloneValueArrival');
      return gateEvidence;
    }
    const durationMs =
      freshCloneArtifact && typeof freshCloneArtifact.totalDurationMs === 'number'
        ? freshCloneArtifact.totalDurationMs
        : null;
    const withinFiveMinutes =
      freshCloneArtifact?.passed !== false &&
      durationMs !== null &&
      durationMs <= VALUE_EVIDENCE_MAX_DURATION_MS;
    if (!withinFiveMinutes) {
      missingEvidence.push('freshCloneUnderFiveMinutes');
    }
    return {
      status: withinFiveMinutes ? 'passed' : 'degraded',
      claimAllowed: withinFiveMinutes ? 'stable_ok' : 'structured_degraded_only',
      command: 'bun run fresh-clone:value-smoke',
      reason: withinFiveMinutes
        ? 'fresh clone value smoke completed within five minutes'
        : 'fresh clone value smoke has not proven five-minute value arrival',
      details: freshCloneArtifact ?? {},
    } satisfies ProjectValueEvidenceItem;
  })();

  const successExamplesExist = [
    'docs/examples/agentic-search-success.md',
    'docs/examples/review-task-success.md',
    'docs/examples/failure-firewall-success.md',
  ].every((filePath) => existsSync(join(process.cwd(), filePath)));
  if (!successExamplesExist) {
    missingEvidence.push('successExamples');
  }

  const successExamples: ProjectValueEvidenceItem = successExamplesExist
    ? {
        status: 'passed',
        claimAllowed: 'stable_ok',
        command: 'test -e docs/examples/agentic-search-success.md',
      }
    : {
        status: 'missing',
        claimAllowed: 'missing_evidence',
        command: 'test -e docs/examples/agentic-search-success.md',
        reason: 'docs/examples success fixtures are missing',
      };

  const docsLinks: ProjectValueEvidenceItem = {
    status: 'skipped',
    claimAllowed: 'skipped_with_reason',
    command: 'rg -n "TODO|存在しない|unavailable_in_minimal_mode" README.md docs',
    reason: 'docs link check is manual until a dedicated checker is added',
  };

  const claimAllowed = {
    reviewTaskLocal: reviewTaskLocal.claimAllowed,
    monitorBacklog: monitorBacklogInterpretation.claimAllowed,
    freshCloneValueArrival: freshCloneValueArrival.claimAllowed,
  };

  return {
    scoreReady: missingEvidence.length === 0,
    missingEvidence,
    claimAllowed,
    reviewTaskLocal,
    reviewTaskDegradedSemantics,
    monitorBacklogInterpretation,
    freshCloneValueArrival,
    successExamples,
    docsLinks,
  };
}

async function collectQueueBacklogEvidence(): Promise<QueueBacklogEvidence> {
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
  const queueBacklogInterpretation = interpretQueueBacklog(queueBacklog);
  const projectValueEvidence = buildProjectValueEvidence(qualityGates, queueBacklog);
  const missingEvidence: string[] = [];
  for (const gate of QUALITY_GATE_NAMES) {
    if (gateStatus(qualityGates, gate) !== 'passed') {
      missingEvidence.push(`${gate}: ${gateStatus(qualityGates, gate)}`);
    }
  }
  for (const item of projectValueEvidence.missingEvidence) {
    if (!missingEvidence.includes(item)) {
      missingEvidence.push(item);
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
      queueBacklogInterpretation,
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
    projectValueEvidence,
    missingEvidence,
    commands: {
      doctor: 'bun run doctor',
      doctorStrict: 'GNOSIS_DOCTOR_STRICT=1 bun run doctor',
      smoke: 'bun run smoke',
      semanticSmoke: 'bun run agentic-search:semantic-smoke',
      freshCloneValueSmoke: 'bun run fresh-clone:value-smoke',
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
    '## Project Value Evidence',
    `- scoreReady: ${report.projectValueEvidence.scoreReady}`,
    `- reviewTaskLocal: ${report.projectValueEvidence.reviewTaskLocal.status} (${report.projectValueEvidence.reviewTaskLocal.claimAllowed})`,
    `- monitorBacklogInterpretation: ${report.projectValueEvidence.monitorBacklogInterpretation.status} (${report.projectValueEvidence.monitorBacklogInterpretation.claimAllowed})`,
    `- freshCloneValueArrival: ${report.projectValueEvidence.freshCloneValueArrival.status} (${report.projectValueEvidence.freshCloneValueArrival.claimAllowed})`,
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
