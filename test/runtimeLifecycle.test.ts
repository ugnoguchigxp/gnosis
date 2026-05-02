import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeLifecycle } from '../src/runtime/lifecycle.js';
import { registerProcess } from '../src/runtime/processRegistry.js';
import {
  parseElapsedMs,
  pruneDeadRegistryEntries,
  scanWatchdog,
} from '../src/runtime/processWatchdog.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gnosis-runtime-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runtime lifecycle', () => {
  it('runs cleanup once when shutdown is requested multiple times', async () => {
    let cleanupCount = 0;
    const exitCodes: number[] = [];
    const lifecycle = new RuntimeLifecycle({
      name: 'test',
      exit: (code) => {
        exitCodes.push(code);
      },
      logger: { error: () => {} },
    });
    lifecycle.addCleanupStep(() => {
      cleanupCount += 1;
    });

    const first = lifecycle.requestShutdown('SIGTERM');
    const second = lifecycle.requestShutdown('uncaughtException');
    await Promise.all([first, second]);

    expect(cleanupCount).toBe(1);
    expect(exitCodes).toEqual([0]);
    expect(lifecycle.state).toBe('stopped');
  });
});

describe('process registry', () => {
  it('registers, heartbeats, and unregisters a process entry', () => {
    const registryDir = tempDir();
    const registration = registerProcess({
      role: 'mcp-server',
      registryDir,
      logger: { error: () => {} },
    });

    expect(registration.status).toBe('enabled');
    expect(registration.filePath).toBeTruthy();
    expect(registration.heartbeat()).toBe('enabled');
    registration.unregister();

    const findings = scanWatchdog({ registryDir, apply: false, requireConsecutive: false });
    expect(findings).toHaveLength(0);
  });
});

describe('process watchdog', () => {
  it('parses ps elapsed time formats', () => {
    expect(parseElapsedMs('01:02')).toBe(62_000);
    expect(parseElapsedMs('03:01:02')).toBe(10_862_000);
    expect(parseElapsedMs('2-03:01:02')).toBe(183_662_000);
  });

  it('does not kill corrupt registry entries', () => {
    const registryDir = tempDir();
    writeFileSync(join(registryDir, 'bad.json'), '{bad json', 'utf8');

    const findings = scanWatchdog({ registryDir, apply: true, requireConsecutive: false });

    expect(findings[0]?.reason).toBe('corrupt_registry');
    expect(findings[0]?.applyEligible).toBe(false);
  });

  it('does not persist watchdog state for dry-run scans', () => {
    const rootDir = tempDir();
    const registryDir = join(rootDir, 'processes');

    scanWatchdog({ registryDir, apply: false });

    expect(existsSync(join(rootDir, 'watchdog-state.json'))).toBe(false);
  });
});

describe('pruneDeadRegistryEntries', () => {
  it('removes registry entries for dead PIDs', () => {
    const registryDir = tempDir();
    // Create a registry entry for a PID that definitely does not exist
    const fakePid = 999999;
    const fakeEntry = {
      schemaVersion: 1,
      pid: fakePid,
      ppid: 1,
      originalPpid: 1,
      startedAt: new Date().toISOString(),
      startedAtEpochMs: Date.now(),
      heartbeatAt: new Date().toISOString(),
      cwd: process.cwd(),
      argv: [],
      title: 'test',
      role: 'mcp-host',
      registryStatus: 'enabled',
    };
    const fileName = `mcp-host-${fakePid}-${fakeEntry.startedAtEpochMs}.json`;
    writeFileSync(join(registryDir, fileName), JSON.stringify(fakeEntry), 'utf8');

    const pruned = pruneDeadRegistryEntries({
      registryDir,
      selfPid: process.pid,
      logger: { error: () => {} },
    });

    expect(pruned).toBe(1);
    expect(existsSync(join(registryDir, fileName))).toBe(false);
  });

  it('removes corrupt registry files', () => {
    const registryDir = tempDir();
    writeFileSync(join(registryDir, 'corrupt.json'), '{invalid', 'utf8');

    const pruned = pruneDeadRegistryEntries({
      registryDir,
      logger: { error: () => {} },
    });

    expect(pruned).toBe(1);
    expect(existsSync(join(registryDir, 'corrupt.json'))).toBe(false);
  });

  it('never prunes own process entry', () => {
    const registryDir = tempDir();
    const registration = registerProcess({
      role: 'mcp-host',
      registryDir,
      logger: { error: () => {} },
    });

    const pruned = pruneDeadRegistryEntries({
      registryDir,
      selfPid: process.pid,
      logger: { error: () => {} },
    });

    expect(pruned).toBe(0);
    expect(registration.filePath).toBeTruthy();
    expect(existsSync(registration.filePath ?? '')).toBe(true);
    registration.unregister();
  });
});
