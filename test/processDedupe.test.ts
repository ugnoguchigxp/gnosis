import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suppressDuplicateProcesses } from '../src/runtime/processDedupe.js';
import {
  type ProcessRegistryEntry,
  getProcessRegistryDir,
} from '../src/runtime/processRegistry.js';
import type { ProcessSnapshot } from '../src/runtime/processWatchdog.js';

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gnosis-dedupe-'));
  tempDirs.push(dir);
  return dir;
}

function entry(root: string, pid: number, startedAtEpochMs: number): ProcessRegistryEntry {
  const startedAt = new Date(startedAtEpochMs).toISOString();
  return {
    schemaVersion: 1,
    pid,
    ppid: 10,
    originalPpid: 10,
    startedAt,
    startedAtEpochMs,
    heartbeatAt: startedAt,
    cwd: root,
    argv: ['bun', 'run', 'src/index.ts'],
    title: 'gnosis-mcp-server',
    role: 'mcp-server',
    registryStatus: 'enabled',
  };
}

function snapshot(pid: number, cwd: string): ProcessSnapshot {
  return {
    pid,
    ppid: 10,
    stat: 'S',
    rssKb: 100,
    etime: '00:01',
    elapsedMs: 1000,
    command: 'bun run src/index.ts',
    cwd,
  };
}

function writeEntry(registryDir: string, value: ProcessRegistryEntry): string {
  mkdirSync(registryDir, { recursive: true });
  const path = join(registryDir, `mcp-server-${value.pid}-${value.startedAtEpochMs}.json`);
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('process dedupe', () => {
  it('allows live duplicate MCP servers when termination is disabled', () => {
    const root = tempRoot();
    const registryDir = getProcessRegistryDir(root);
    writeEntry(registryDir, entry(root, 111, 1000));
    writeEntry(registryDir, entry(root, 222, 2000));
    const signaled: number[] = [];

    const findings = suppressDuplicateProcesses({
      registryDir,
      cwd: root,
      apply: true,
      currentPid: 999,
      terminateDuplicates: false,
      getSnapshot: (pid) => snapshot(pid, root),
      signalPid: (pid) => {
        signaled.push(pid);
        return true;
      },
    });

    expect(signaled).toEqual([]);
    expect(findings.filter((finding) => finding.reason === 'live_duplicate_allowed')).toHaveLength(
      2,
    );
  });

  it('still supports explicit duplicate termination for manual cleanup', () => {
    const root = tempRoot();
    const registryDir = getProcessRegistryDir(root);
    writeEntry(registryDir, entry(root, 111, 1000));
    writeEntry(registryDir, entry(root, 222, 2000));
    const signaled: number[] = [];

    const findings = suppressDuplicateProcesses({
      registryDir,
      cwd: root,
      apply: true,
      currentPid: 999,
      terminateDuplicates: true,
      getSnapshot: (pid) => snapshot(pid, root),
      signalPid: (pid) => {
        signaled.push(pid);
        return true;
      },
    });

    expect(signaled).toEqual([111]);
    expect(findings.some((finding) => finding.reason === 'selected_survivor')).toBe(true);
    expect(findings.some((finding) => finding.reason === 'duplicate_instance')).toBe(true);
  });

  it('removes registry entries when the PID has been reused in another cwd', () => {
    const root = tempRoot();
    const registryDir = getProcessRegistryDir(root);
    const path = writeEntry(registryDir, entry(root, 111, 1000));
    const signaled: number[] = [];

    const findings = suppressDuplicateProcesses({
      registryDir,
      cwd: root,
      apply: true,
      currentPid: 999,
      getSnapshot: (pid) => snapshot(pid, '/tmp/another-project'),
      signalPid: (pid) => {
        signaled.push(pid);
        return true;
      },
    });

    expect(signaled).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(findings[0]?.reason).toBe('pid_reuse_or_cwd_mismatch');
  });
});
