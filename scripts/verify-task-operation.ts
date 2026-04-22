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

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function runCommand(command: string, args: string[]) {
  log(`\n> Running: ${command} ${args.join(' ')}`, colors.cyan);
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    env: {
      ...process.env,
      GNOSIS_LLM_CONCURRENCY_LIMIT: '3',
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
    if (kfResult.stderr) log(kfResult.stderr.trim(), colors.red);
  }

  const kfLog = getLatestLogFile();
  if (kfLog) log(`  Details: ${kfLog}`, colors.blue);

  // 2. Episode verification
  log('\n[2/2] Verifying Episode Consolidation...', colors.bold);

  // Create a temporary raw memory to ensure we have something to consolidate
  // Create multiple raw memories to ensure we have enough to consolidate (minRawCount=5)
  log('> Registering 5 test memories for session...', colors.cyan);
  const baseSessionId = `manual-reg-${Date.now()}`;
  let registeredCount = 0;
  for (let i = 1; i <= 5; i++) {
    const regResult = runCommand('bun', [
      'run',
      'src/scripts/monitor-episodes.ts',
      'register',
      `Verification test memory ${i}`,
      baseSessionId,
    ]);
    if (regResult.status === 0) {
      registeredCount++;
    } else {
      log(`! Registration failed for memory ${i}`, colors.red);
      if (regResult.stderr) log(regResult.stderr, colors.red);
      if (regResult.stdout) log(regResult.stdout, colors.cyan);
    }
  }

  if (registeredCount >= 5) {
    const sessionId = baseSessionId;
    log(`  Registered 5 memories for session: ${sessionId}`, colors.cyan);
    log(
      `\n> Running: bun run src/scripts/monitor-episodes.ts consolidate ${sessionId} --strict --verbose`,
      colors.cyan,
    );

    const conResult = runCommand('bun', [
      'run',
      'src/scripts/monitor-episodes.ts',
      'consolidate',
      sessionId,
      '--strict',
      '--verbose',
    ]);

    if (conResult.status === 0) {
      log('✓ Episode consolidated successfully.', colors.green);
    } else {
      log('! Episode consolidation failed.', colors.red);
      if (conResult.stderr) log(conResult.stderr.trim(), colors.red);
      if (conResult.stdout) log(conResult.stdout.trim(), colors.cyan);
    }
  } else {
    log('! Failed to register test raw memories.', colors.red);
  }

  const epLog = getLatestLogFile();
  if (epLog) log(`  Details: ${epLog}`, colors.blue);

  log('\n=== Verification Summary ===', colors.bold + colors.blue);
  log(`Logs are stored in: ${path.join(process.cwd(), 'logs', 'runs/')}`);
  log('Use "bun run task:verify:operation" to run this verification again.');
}

verify().catch(console.error);
