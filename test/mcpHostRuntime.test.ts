import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GNOSIS_CONSTANTS } from '../src/constants.js';
import { startMcpHost } from '../src/mcp/host.js';
import { MCP_HOST_SOURCE_FINGERPRINT } from '../src/mcp/hostFingerprint.js';
import {
  type McpHostHealth,
  type McpHostService,
  getMcpHostSocketPath,
  sendMcpHostRequest,
} from '../src/mcp/hostProtocol.js';

const tempDirs: string[] = [];

const originalEnv = {
  GNOSIS_MCP_HOST_SOCKET_IDLE_MS: process.env.GNOSIS_MCP_HOST_SOCKET_IDLE_MS,
  GNOSIS_MCP_HOST_REQUEST_TIMEOUT_MS: process.env.GNOSIS_MCP_HOST_REQUEST_TIMEOUT_MS,
  GNOSIS_NO_WORKERS: process.env.GNOSIS_NO_WORKERS,
};

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gnosis-mcp-host-'));
  tempDirs.push(dir);
  return dir;
}

function setEnv(key: keyof typeof originalEnv, value: string): void {
  process.env[key] = value;
}

function clearEnv(key: keyof typeof originalEnv): void {
  delete process.env[key];
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function makeService(behavior: { hang?: boolean } = {}): McpHostService {
  return {
    name: 'test-service',
    version: '0.0.0',
    listTools: () => [
      {
        name: 'test_tool',
        inputSchema: { type: 'object', additionalProperties: true },
      },
    ],
    callTool: async (_name, _args, callOptions) => {
      if (behavior.hang) {
        await new Promise((_resolve, reject) => {
          callOptions?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

async function startTestHost(rootDir: string, services: McpHostService[]): Promise<string> {
  setEnv('GNOSIS_NO_WORKERS', 'true');
  const socketPath = getMcpHostSocketPath(rootDir);
  await startMcpHost({
    rootDir,
    socketPath,
    services,
    bindProcessEvents: false,
    exit: () => {},
  });
  return socketPath;
}

async function shutdownHost(rootDir: string, socketPath: string): Promise<void> {
  await sendMcpHostRequest({ type: 'shutdown' }, { rootDir, socketPath, timeoutMs: 1_000 }).catch(
    () => undefined,
  );
  await Bun.sleep(50);
}

afterEach(() => {
  restoreEnv();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('MCP host runtime', () => {
  it('defaults request timeout above the MCP review LLM timeout', async () => {
    const rootDir = tempRoot();
    clearEnv('GNOSIS_MCP_HOST_REQUEST_TIMEOUT_MS');
    const socketPath = await startTestHost(rootDir, [makeService()]);

    const health = await sendMcpHostRequest<McpHostHealth>(
      { type: 'health' },
      { rootDir, socketPath },
    );

    expect(health.requestTimeoutMs).toBe(GNOSIS_CONSTANTS.MCP_HOST_REQUEST_TIMEOUT_MS_DEFAULT);
    expect(health.requestTimeoutMs ?? 0).toBeGreaterThan(
      GNOSIS_CONSTANTS.MCP_REVIEW_LLM_TIMEOUT_MS_DEFAULT,
    );

    await shutdownHost(rootDir, socketPath);
  });

  it('serves multiple client connections through the same host', async () => {
    const rootDir = tempRoot();
    const socketPath = await startTestHost(rootDir, [makeService()]);

    const [first, second] = await Promise.all([
      sendMcpHostRequest<McpHostHealth>({ type: 'health' }, { rootDir, socketPath }),
      sendMcpHostRequest<McpHostHealth>({ type: 'health' }, { rootDir, socketPath }),
    ]);

    expect(first.services).toContain('test-service');
    expect(first.serviceVersions).toContainEqual({ name: 'test-service', version: '0.0.0' });
    expect(first.sourceFingerprint).toBe(MCP_HOST_SOURCE_FINGERPRINT);
    expect(first.cwd).toBe(rootDir);
    expect(second.services).toContain('test-service');
    expect((second.totalConnections ?? 0) + (first.totalConnections ?? 0)).toBeGreaterThanOrEqual(
      2,
    );

    await shutdownHost(rootDir, socketPath);
  });

  it('closes idle sockets and times out stuck requests', async () => {
    const rootDir = tempRoot();
    setEnv('GNOSIS_MCP_HOST_SOCKET_IDLE_MS', '50');
    setEnv('GNOSIS_MCP_HOST_REQUEST_TIMEOUT_MS', '50');
    const socketPath = await startTestHost(rootDir, [makeService({ hang: true })]);

    const idleClosed = new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      socket.once('close', () => resolve());
      socket.once('error', reject);
      socket.connect(socketPath);
    });
    await expect(idleClosed).resolves.toBeUndefined();

    await expect(
      sendMcpHostRequest(
        { type: 'callTool', name: 'test_tool', arguments: {} },
        { rootDir, socketPath, timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/timed out/);

    const health = await sendMcpHostRequest<McpHostHealth>(
      { type: 'health' },
      { rootDir, socketPath },
    );
    expect(health.timedOutRequests).toBeGreaterThanOrEqual(1);
    expect(health.activeRequests).toBe(0);

    await shutdownHost(rootDir, socketPath);
  });
});
