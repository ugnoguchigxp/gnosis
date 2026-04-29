import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ProcessRegistryEntry,
  getProcessRegistryDir,
  readRegistryEntries,
  removeRegistryFile,
} from './processRegistry.js';

export type ProcessSnapshot = {
  pid: number;
  ppid: number;
  stat: string;
  rssKb: number;
  etime: string;
  elapsedMs: number | null;
  command: string;
  cwd?: string;
};

export type WatchdogAction = 'none' | 'remove_registry' | 'warn' | 'sigterm' | 'sigkill';

export type WatchdogFinding = {
  action: WatchdogAction;
  applyEligible: boolean;
  reason: string;
  path?: string;
  entry?: ProcessRegistryEntry;
  snapshot?: ProcessSnapshot;
  detail?: string;
};

type WatchdogState = {
  observations: Record<string, { reason: string; count: number }>;
};

const KNOWN_COMMAND_PATTERNS = [
  'bun run src/index.ts',
  'src/index.ts',
  'bun run src/scripts/mcpToolsServer.ts',
  'src/scripts/mcpToolsServer.ts',
  'bun run src/scripts/semanticCodeMcpServer.ts',
  'src/scripts/semanticCodeMcpServer.ts',
  'bun run src/scripts/worker.ts',
  'src/scripts/worker.ts',
];

const KNOWN_TITLE_PATTERNS = [
  'gnosis-mcp-server',
  'gnosis-mcp-logic',
  'gnosis-tools',
  'gnosis-worker',
  'semantic-code-tools',
];

function run(command: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.toString() ?? '',
  };
}

export function parseElapsedMs(etime: string): number | null {
  const trimmed = etime.trim();
  const daySplit = trimmed.split('-');
  const days = daySplit.length === 2 ? Number(daySplit[0]) : 0;
  const time = daySplit.length === 2 ? daySplit[1] : daySplit[0];
  const parts = time.split(':').map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (parts.length === 3) {
    [hours, minutes, seconds] = parts;
  } else if (parts.length === 2) {
    [minutes, seconds] = parts;
  } else {
    return null;
  }
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

export function getProcessSnapshot(pid: number): ProcessSnapshot | null {
  const result = run('ps', ['-p', String(pid), '-o', 'pid=,ppid=,stat=,rss=,etime=,command=']);
  const line = result.stdout.trim();
  if (!result.ok || line.length === 0) return null;

  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.+)$/);
  if (!match) return null;
  const [, rawPid, rawPpid, stat, rawRss, etime, command] = match;
  const snapshot: ProcessSnapshot = {
    pid: Number(rawPid),
    ppid: Number(rawPpid),
    stat,
    rssKb: Number(rawRss),
    etime,
    elapsedMs: parseElapsedMs(etime),
    command,
  };

  const cwd = getProcessCwd(pid);
  if (cwd) snapshot.cwd = cwd;
  return snapshot;
}

function getProcessCwd(pid: number): string | null {
  const result = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (!result.ok) return null;
  const line = result.stdout
    .split('\n')
    .find((candidate) => candidate.startsWith('n') && candidate.length > 1);
  return line ? line.slice(1) : null;
}

function parentAlive(pid: number): boolean {
  if (pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isKnownGnosisProcess(snapshot: ProcessSnapshot): boolean {
  return (
    KNOWN_COMMAND_PATTERNS.some((pattern) => snapshot.command.includes(pattern)) ||
    KNOWN_TITLE_PATTERNS.some((pattern) => snapshot.command.includes(pattern))
  );
}

function isMcpStdioRole(entry: ProcessRegistryEntry): boolean {
  return entry.role === 'mcp-server' || entry.role === 'mcp-tools' || entry.role === 'semantic-mcp';
}

function isStale(entry: ProcessRegistryEntry, snapshot: ProcessSnapshot): string | null {
  if (snapshot.stat.includes('Z')) return 'zombie_state';
  if (entry.registryStatus === 'degraded') return 'registry_degraded';
  if (!isKnownGnosisProcess(snapshot)) return 'pid_reuse_or_command_mismatch';
  if (isMcpStdioRole(entry) && snapshot.ppid === 1) return 'orphan_ppid_1';
  if (entry.originalPpid > 1 && !parentAlive(entry.originalPpid)) return 'original_parent_dead';

  const heartbeatMs = Date.parse(entry.heartbeatAt);
  if (!Number.isNaN(heartbeatMs) && Date.now() - heartbeatMs > 60_000) {
    return 'heartbeat_stale';
  }

  return null;
}

function hardGate(entry: ProcessRegistryEntry, snapshot: ProcessSnapshot | null): string | null {
  if (!snapshot) return 'identity_incomplete:ps';
  if (snapshot.stat.includes('Z')) return 'identity_incomplete:zombie';
  if (!isKnownGnosisProcess(snapshot)) return 'identity_incomplete:command';
  if (!snapshot.cwd) return 'identity_incomplete:cwd';
  if (snapshot.cwd !== entry.cwd) return 'identity_incomplete:cwd_mismatch';
  if (snapshot.elapsedMs === null) return 'identity_incomplete:elapsed';
  if (Date.now() - snapshot.elapsedMs > entry.startedAtEpochMs + 5_000) {
    return 'identity_incomplete:pid_reuse';
  }
  return null;
}

function statePath(registryDir: string): string {
  return join(registryDir, '..', 'watchdog-state.json');
}

function readState(registryDir: string): WatchdogState {
  const path = statePath(registryDir);
  if (!existsSync(path)) return { observations: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WatchdogState;
  } catch {
    return { observations: {} };
  }
}

function writeState(registryDir: string, state: WatchdogState): void {
  const path = statePath(registryDir);
  const tmp = `${path}.tmp-${process.pid}`;
  mkdirSync(join(registryDir, '..'), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function observationKey(entry: ProcessRegistryEntry): string {
  return `${entry.role}:${entry.pid}:${entry.startedAtEpochMs}`;
}

function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function scanWatchdog(
  options: {
    registryDir?: string;
    apply?: boolean;
    signal?: 'SIGTERM' | 'SIGKILL';
    requireConsecutive?: boolean;
  } = {},
): WatchdogFinding[] {
  const registryDir = options.registryDir ?? getProcessRegistryDir();
  const apply = options.apply === true;
  const signal = options.signal ?? 'SIGTERM';
  const requireConsecutive = options.requireConsecutive ?? true;
  const results = readRegistryEntries(registryDir);
  const shouldPersistState = apply && requireConsecutive;
  const state = shouldPersistState ? readState(registryDir) : { observations: {} };
  let stateDirty = false;
  const findings: WatchdogFinding[] = [];

  for (const result of results) {
    if (result.kind === 'corrupt') {
      findings.push({
        action: apply ? 'remove_registry' : 'warn',
        applyEligible: false,
        reason: 'corrupt_registry',
        path: result.path,
        detail: result.error,
      });
      if (apply) removeRegistryFile(result.path);
      continue;
    }

    const { entry } = result;
    const snapshot = getProcessSnapshot(entry.pid);
    if (!snapshot) {
      findings.push({
        action: apply ? 'remove_registry' : 'warn',
        applyEligible: false,
        reason: 'dead_pid',
        path: result.path,
        entry,
      });
      if (apply) removeRegistryFile(result.path);
      continue;
    }

    const staleReason = isStale(entry, snapshot);
    if (!staleReason) {
      findings.push({
        action: 'none',
        applyEligible: false,
        reason: 'healthy',
        path: result.path,
        entry,
        snapshot,
      });
      continue;
    }

    const gateFailure = hardGate(entry, snapshot);
    const key = observationKey(entry);
    const previous = state.observations[key];
    const count = previous?.reason === staleReason ? previous.count + 1 : 1;
    if (shouldPersistState) {
      state.observations[key] = { reason: staleReason, count };
      stateDirty = true;
    }
    const consecutiveOk = !requireConsecutive || count >= 2;

    if (gateFailure || !consecutiveOk) {
      findings.push({
        action: 'warn',
        applyEligible: false,
        reason: gateFailure ?? `awaiting_consecutive_scan:${staleReason}`,
        path: result.path,
        entry,
        snapshot,
      });
      continue;
    }

    const action: WatchdogAction = signal === 'SIGKILL' ? 'sigkill' : 'sigterm';
    findings.push({
      action: apply ? action : 'warn',
      applyEligible: true,
      reason: staleReason,
      path: result.path,
      entry,
      snapshot,
    });
    if (apply) signalPid(entry.pid, signal);
  }

  if (stateDirty) writeState(registryDir, state);
  return findings;
}

export function renderWatchdogFindings(findings: WatchdogFinding[]): string {
  if (findings.length === 0) return 'No Gnosis process registry entries found.';
  return findings
    .map((finding) => {
      const pid = finding.entry?.pid ?? 'unknown';
      const role = finding.entry?.role ?? 'unknown';
      const rss = finding.snapshot ? ` rss=${finding.snapshot.rssKb}KB` : '';
      return `[${finding.action}] role=${role} pid=${pid} reason=${finding.reason}${rss}`;
    })
    .join('\n');
}

export function clearWatchdogState(registryDir = getProcessRegistryDir()): void {
  rmSync(statePath(registryDir), { force: true });
}
