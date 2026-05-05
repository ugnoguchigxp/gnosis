import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

const COMMAND_TIMEOUT_MS = 120_000;

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function runCommand(command: string, args: string[]) {
  log(`\n> Running: ${command} ${args.join(' ')}`, colors.cyan);
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    timeout: COMMAND_TIMEOUT_MS,
    env: {
      ...process.env,
      GNOSIS_LLM_CONCURRENCY_LIMIT: '1',
      KNOWFLOW_LLM_QUEUE_NAME: 'llm-pool',
    },
  });
  return result;
}

function cleanLocks() {
  const tmpDir = '/tmp';
  if (existsSync(tmpDir)) {
    const files = readdirSync(tmpDir).filter((f) => f.startsWith('gnosis-') && f.endsWith('.lock'));
    if (files.length > 0) {
      log(`Cleaning up ${files.length} stale locks in ${tmpDir}...`, colors.yellow);
      for (const f of files) {
        try {
          const fullPath = path.join(tmpDir, f);
          spawnSync('rm', [fullPath]);
        } catch (e) {
          // ignore
        }
      }
    }
  }
}

function getLatestLogFile() {
  const logDir = path.join(process.cwd(), 'logs', 'runs');
  if (!existsSync(logDir)) return null;
  const files = readdirSync(logDir)
    .filter((f) => f.endsWith('.jsonl') && !f.includes('worker-daemon'))
    .map((f) => {
      const fullPath = path.join(logDir, f);
      return {
        name: f,
        time: existsSync(fullPath) ? readFileSync(fullPath, 'utf-8').split('\n')[0] : null,
        fullPath,
      };
    })
    .filter((f) => f.time)
    .sort((a, b) => {
      // Sort by timestamp in the first line of JSONL
      try {
        const tA = a.time ? JSON.parse(a.time).ts : '';
        const tB = b.time ? JSON.parse(b.time).ts : '';
        return tB.localeCompare(tA);
      } catch (e) {
        return b.name.localeCompare(a.name);
      }
    });
  return files.length > 0 ? files[0].fullPath : null;
}

async function verify() {
  log('=== Gnosis Background Task Operation Verification ===', colors.bold + colors.blue);
  let hasHardFailure = false;

  // 0. Cleanup
  cleanLocks();

  // 1. KnowFlow verification
  log('\n[1/2] Verifying KnowFlow Task...', colors.bold);
  const kfResult = runCommand('bun', [
    'run',
    'src/services/knowflow/cli.ts',
    'run-once',
    '--strict-complete',
    '--verbose',
  ]);

  if (kfResult.status === 0) {
    log('✓ KnowFlow task processed successfully.', colors.green);
  } else {
    log('! KnowFlow task skipped or failed (Queue might be empty).', colors.yellow);
    if (kfResult.error) log(kfResult.error.message, colors.red);
    if (kfResult.stderr) log(kfResult.stderr.trim(), colors.red);
  }

  const kfLog = getLatestLogFile();
  if (kfLog) log(`  Details: ${kfLog}`, colors.blue);

  // 2. Monitor snapshot verification
  log('\n[2/2] Verifying Monitor Snapshot...', colors.bold);
  const snapshotResult = runCommand('bun', ['run', 'src/scripts/monitor-snapshot.ts', '--json']);

  if (snapshotResult.status !== 0) {
    hasHardFailure = true;
    log('! Monitor snapshot failed.', colors.red);
    if (snapshotResult.error) log(snapshotResult.error.message, colors.red);
    if (snapshotResult.stderr) log(snapshotResult.stderr.trim(), colors.red);
    if (snapshotResult.stdout) log(snapshotResult.stdout.trim(), colors.cyan);
  } else {
    try {
      const snapshot = JSON.parse(snapshotResult.stdout);
      const queue = snapshot.queue ?? {};
      const automation = snapshot.automation ?? {};
      const knowflow = snapshot.knowflow ?? {};

      log(
        `  Queue: pending=${queue.pending ?? 0}, running=${queue.running ?? 0}, deferred=${
          queue.deferred ?? 0
        }, failed=${queue.failed ?? 0}`,
        colors.blue,
      );
      log(
        `  Gates: automation=${Boolean(automation.automationGate)}, backgroundWorker=${Boolean(
          automation.backgroundWorkerGate,
        )}`,
        automation.automationGate && automation.backgroundWorkerGate ? colors.green : colors.yellow,
      );
      log(`  KnowFlow status: ${knowflow.status ?? 'unknown'}`, colors.blue);

      if (automation.automationGate !== true || automation.backgroundWorkerGate !== true) {
        log('! Automation or background worker gate is disabled.', colors.yellow);
      }
      if (knowflow.status === 'degraded') {
        hasHardFailure = true;
        log('! KnowFlow is degraded in the monitor snapshot.', colors.red);
      } else {
        log('✓ Monitor snapshot collected successfully.', colors.green);
      }
    } catch (error) {
      hasHardFailure = true;
      log('! Failed to parse monitor snapshot JSON.', colors.red);
      log(error instanceof Error ? error.message : String(error), colors.red);
    }
  }

  log('\n=== Verification Summary ===', colors.bold + colors.blue);
  log(`Logs are stored in: ${path.join(process.cwd(), 'logs', 'runs/')}`);
  log('Use "bun run task:verify:operation" to run this verification again.');
  if (hasHardFailure) {
    process.exitCode = 1;
  }
}

verify().catch(console.error);
