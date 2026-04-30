import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMcpHost } from '../src/mcp/host.js';
import {
  type FailureFirewallHostResponse,
  getMcpHostSocketPath,
  sendMcpHostRequest,
} from '../src/mcp/hostProtocol.js';

const tempDirs: string[] = [];
const originalNoWorkers = process.env.GNOSIS_NO_WORKERS;

const cacheMissingDiff = [
  'diff --git a/src/users/hooks.ts b/src/users/hooks.ts',
  'index 0000000..1111111 100644',
  '--- a/src/users/hooks.ts',
  '+++ b/src/users/hooks.ts',
  '@@ -1,3 +1,10 @@',
  ' import { useMutation } from "@tanstack/react-query";',
  '+export function useSaveUser() {',
  '+  return useMutation({',
  '+    mutationFn: async (input: UserInput) => fetch("/api/users", { method: "POST" }),',
  '+  });',
  '+}',
].join('\n');

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gnosis-ff-host-'));
  tempDirs.push(dir);
  return dir;
}

async function startTestHost(rootDir: string): Promise<string> {
  process.env.GNOSIS_NO_WORKERS = 'true';
  const socketPath = getMcpHostSocketPath(rootDir);
  await startMcpHost({
    rootDir,
    socketPath,
    services: [],
    bindProcessEvents: false,
    exit: () => {},
  });
  return socketPath;
}

afterEach(() => {
  if (originalNoWorkers === undefined) {
    process.env.GNOSIS_NO_WORKERS = undefined;
  } else {
    process.env.GNOSIS_NO_WORKERS = originalNoWorkers;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('failure firewall host private requests', () => {
  test('runs Failure Firewall without exposing a primary tool', async () => {
    const rootDir = tempRoot();
    const socketPath = await startTestHost(rootDir);

    const tools = await sendMcpHostRequest<{ tools: Array<{ name: string }> }>(
      { type: 'listTools' },
      { rootDir, socketPath },
    );
    expect(tools.tools.some((tool) => tool.name.includes('failure_firewall'))).toBe(false);

    const result = await sendMcpHostRequest<FailureFirewallHostResponse>(
      {
        type: 'failure_firewall/run',
        input: { rawDiff: cacheMissingDiff, mode: 'fast' },
      },
      { rootDir, socketPath },
    );
    expect('status' in result ? result.status : undefined).toBe('changes_requested');

    await sendMcpHostRequest({ type: 'shutdown' }, { rootDir, socketPath }).catch(() => undefined);
  });

  test('returns context and learning candidates through private requests', async () => {
    const rootDir = tempRoot();
    const socketPath = await startTestHost(rootDir);

    const context = await sendMcpHostRequest<FailureFirewallHostResponse>(
      {
        type: 'failure_firewall/context',
        input: { rawDiff: cacheMissingDiff },
      },
      { rootDir, socketPath },
    );
    expect('shouldUse' in context ? context.shouldUse : false).toBe(true);

    const candidates = await sendMcpHostRequest<FailureFirewallHostResponse>(
      {
        type: 'failure_firewall/suggest_learning_candidates',
        input: {
          rawDiff: cacheMissingDiff,
          verifyCommand: 'bun run verify',
          verifyPassed: true,
          commitApprovedByUser: true,
        },
      },
      { rootDir, socketPath },
    );
    expect('candidates' in candidates ? candidates.candidates.length : 0).toBeGreaterThan(0);

    await sendMcpHostRequest({ type: 'shutdown' }, { rootDir, socketPath }).catch(() => undefined);
  });
});
