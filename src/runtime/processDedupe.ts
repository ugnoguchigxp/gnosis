import { resolve } from 'node:path';
import {
  type ProcessRegistryEntry,
  getProcessRegistryDir,
  readRegistryEntries,
  removeRegistryFile,
} from './processRegistry.js';
import { type ProcessSnapshot, getProcessSnapshot } from './processWatchdog.js';

export type ProcessDedupeAction = 'keep' | 'remove_registry' | 'sigterm' | 'sigkill' | 'warn';

export type ProcessDedupeFinding = {
  action: ProcessDedupeAction;
  reason: string;
  path?: string;
  entry?: ProcessRegistryEntry;
  detail?: string;
};

export type ProcessDedupeOptions = {
  registryDir?: string;
  role?: ProcessRegistryEntry['role'];
  cwd?: string;
  apply?: boolean;
  signal?: 'SIGTERM' | 'SIGKILL';
  keep?: 'newest' | 'oldest';
  currentPid?: number;
  terminateDuplicates?: boolean;
  getSnapshot?: (pid: number) => ProcessSnapshot | null;
  signalPid?: (pid: number, signal: NodeJS.Signals) => boolean;
};

const isSameRuntime = (entry: ProcessRegistryEntry, role: string, cwd: string): boolean =>
  entry.role === role && resolve(entry.cwd) === resolve(cwd);

const signalPid = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

export function suppressDuplicateProcesses(
  options: ProcessDedupeOptions = {},
): ProcessDedupeFinding[] {
  const role = options.role ?? 'mcp-server';
  const cwd = resolve(options.cwd ?? process.cwd());
  const registryDir = options.registryDir ?? getProcessRegistryDir(cwd);
  const apply = options.apply === true;
  const selectedSignal = options.signal ?? 'SIGTERM';
  const keep = options.keep ?? 'newest';
  const currentPid = options.currentPid ?? process.pid;
  const terminateDuplicates = options.terminateDuplicates ?? true;
  const getSnapshot = options.getSnapshot ?? getProcessSnapshot;
  const sendSignal = options.signalPid ?? signalPid;
  const findings: ProcessDedupeFinding[] = [];
  const healthy: Array<{ path: string; entry: ProcessRegistryEntry }> = [];

  for (const result of readRegistryEntries(registryDir)) {
    if (result.kind === 'corrupt') {
      findings.push({
        action: apply ? 'remove_registry' : 'warn',
        reason: 'corrupt_registry',
        path: result.path,
        detail: result.error,
      });
      if (apply) removeRegistryFile(result.path);
      continue;
    }

    const { entry } = result;
    if (!isSameRuntime(entry, role, cwd)) continue;

    const snapshot = getSnapshot(entry.pid);
    if (!snapshot) {
      findings.push({
        action: apply ? 'remove_registry' : 'warn',
        reason: 'dead_pid',
        path: result.path,
        entry,
      });
      if (apply) removeRegistryFile(result.path);
      continue;
    }

    if (snapshot.cwd && resolve(snapshot.cwd) !== resolve(entry.cwd)) {
      findings.push({
        action: apply ? 'remove_registry' : 'warn',
        reason: 'pid_reuse_or_cwd_mismatch',
        path: result.path,
        entry,
        detail: `snapshotCwd=${snapshot.cwd}`,
      });
      if (apply) removeRegistryFile(result.path);
      continue;
    }

    if (entry.pid === currentPid) {
      findings.push({
        action: 'keep',
        reason: 'current_process',
        path: result.path,
        entry,
      });
      continue;
    }

    healthy.push({ path: result.path, entry });
  }

  const sorted = healthy.sort((left, right) =>
    keep === 'newest'
      ? right.entry.startedAtEpochMs - left.entry.startedAtEpochMs
      : left.entry.startedAtEpochMs - right.entry.startedAtEpochMs,
  );
  const survivor = sorted[0];

  for (const item of sorted) {
    if (!terminateDuplicates) {
      findings.push({
        action: 'keep',
        reason: 'live_duplicate_allowed',
        path: item.path,
        entry: item.entry,
      });
      continue;
    }

    if (survivor && item.entry.pid === survivor.entry.pid) {
      findings.push({
        action: 'keep',
        reason: 'selected_survivor',
        path: item.path,
        entry: item.entry,
      });
      continue;
    }

    const action: ProcessDedupeAction = selectedSignal === 'SIGKILL' ? 'sigkill' : 'sigterm';
    findings.push({
      action: apply ? action : 'warn',
      reason: 'duplicate_instance',
      path: item.path,
      entry: item.entry,
    });
    if (apply) sendSignal(item.entry.pid, selectedSignal);
  }

  return findings;
}

export function renderProcessDedupeFindings(findings: ProcessDedupeFinding[]): string {
  if (findings.length === 0) return 'No duplicate process registry entries found.';
  return findings
    .map((finding) => {
      const role = finding.entry?.role ?? 'unknown';
      const pid = finding.entry?.pid ?? 'unknown';
      const detail = finding.detail ? ` detail=${finding.detail}` : '';
      return `[${finding.action}] role=${role} pid=${pid} reason=${finding.reason}${detail}`;
    })
    .join('\n');
}
