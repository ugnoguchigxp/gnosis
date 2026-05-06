import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { envBoolean } from '../config.js';
import { GNOSIS_CONSTANTS } from '../constants.js';
import { db } from '../db/index.js';
import { experienceLogs, knowledgeClaims, knowledgeTopics, vibeMemories } from '../db/schema.js';

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

function buildValueReport(): ValueReport {
  const qualityGates = readQualityGates();
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
      verifyFast: qualityGates.verifyFast ?? { status: 'unknown' },
      verify: qualityGates.verify ?? { status: 'unknown' },
      verifyStrict: qualityGates.verifyStrict ?? { status: 'unknown' },
      monitorQueueInterpretation: {
        command: 'bun run monitor:snapshot -- --json',
        note: 'Use monitor snapshot for live queue, KnowFlow, and backlog interpretation.',
      },
      latestAgenticSearchSmoke: {
        command:
          'bun run agentic-search -- --request "Gnosis の agentic_search 改善で守るべきルールを調べて" --intent plan --change-type mcp --json',
        note: 'This live smoke is not persisted in quality-gates.json; attach command output when updating value score.',
      },
      latestReviewTaskSmoke: {
        command: 'bun run smoke',
        status: gateStatus(qualityGates, 'smoke'),
      },
      docsLinkCheck: {
        command: 'rg -n "TODO|存在しない|unavailable_in_minimal_mode" README.md docs',
        note: 'Run before final value-score updates when docs changed.',
      },
      knownDegradedReasons: failedOrUnknownGates,
    },
    missingEvidence,
    commands: {
      doctor: 'bun run doctor',
      doctorStrict: 'GNOSIS_DOCTOR_STRICT=1 bun run doctor',
      smoke: 'bun run smoke',
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

function runValueReport(json: boolean): void {
  const report = buildValueReport();
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
    runValueReport(args.json);
    process.exit(0);
  }
  await runNotificationReport();
}

main();
