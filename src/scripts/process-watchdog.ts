#!/usr/bin/env bun

import { renderWatchdogFindings, scanWatchdog } from '../runtime/processWatchdog.js';

const args = new Set(process.argv.slice(2));
const apply =
  !args.has('--dry-run') &&
  (process.env.GNOSIS_PROCESS_WATCHDOG_APPLY === 'true' || args.has('--apply'));
const once = args.has('--once');
const signal = args.has('--sigkill') ? 'SIGKILL' : 'SIGTERM';

function runOnce(): void {
  const findings = scanWatchdog({ apply, signal });
  process.stdout.write(`${renderWatchdogFindings(findings)}\n`);
}

if (once || args.has('--dry-run') || apply) {
  runOnce();
} else {
  const intervalMs = Number(process.env.GNOSIS_PROCESS_WATCHDOG_INTERVAL_MS ?? 60_000);
  runOnce();
  setInterval(runOnce, intervalMs);
}
