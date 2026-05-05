import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  MCP_HOST_SOURCE_FINGERPRINT,
  computeMcpHostSourceFingerprint,
} from '../src/mcp/hostFingerprint.js';
import {
  MCP_HOST_MESSAGE_DELIMITER,
  type McpHostHealth,
  sendMcpHostRequest,
} from '../src/mcp/hostProtocol.js';

describe('MCP stdio integration', () => {
  let transport: StdioClientTransport | null = null;
  let staleHost: Server | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (transport) {
      await transport.close().catch(() => {});
      transport = null;
    }
    if (staleHost) {
      await new Promise<void>((resolve) => {
        if (!staleHost?.listening) {
          resolve();
          return;
        }
        staleHost.close(() => resolve());
      });
      staleHost = null;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function startStaleHost(socketPath: string): Promise<{ shutdowns: () => number }> {
    let shutdownCount = 0;
    staleHost = createServer((socket: Socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split(MCP_HOST_MESSAGE_DELIMITER);
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          if (!part.trim()) continue;
          const request = JSON.parse(part) as { id: string; type: string };
          if (request.type === 'health') {
            socket.write(
              `${JSON.stringify({
                id: request.id,
                ok: true,
                result: {
                  pid: process.pid,
                  uptimeMs: 1,
                  socketPath,
                  services: ['stale-service'],
                  backgroundWorkers: 'disabled',
                  requestTimeoutMs: 30000,
                },
              })}${MCP_HOST_MESSAGE_DELIMITER}`,
            );
            continue;
          }
          if (request.type === 'shutdown') {
            shutdownCount += 1;
            socket.write(
              `${JSON.stringify({
                id: request.id,
                ok: true,
                result: null,
              })}${MCP_HOST_MESSAGE_DELIMITER}`,
            );
            socket.end();
            staleHost?.close();
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      staleHost?.once('error', reject);
      staleHost?.listen(socketPath, () => {
        staleHost?.off('error', reject);
        resolve();
      });
    });
    return { shutdowns: () => shutdownCount };
  }

  async function startHealthyHost(
    socketPath: string,
    sourceFingerprint: string,
  ): Promise<{
    shutdowns: () => number;
    listToolCalls: () => number;
  }> {
    let shutdownCount = 0;
    let listToolCount = 0;
    staleHost = createServer((socket: Socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split(MCP_HOST_MESSAGE_DELIMITER);
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          if (!part.trim()) continue;
          const request = JSON.parse(part) as { id: string; type: string };
          if (request.type === 'health') {
            socket.write(
              `${JSON.stringify({
                id: request.id,
                ok: true,
                result: {
                  pid: process.pid,
                  uptimeMs: 1,
                  socketPath,
                  services: ['healthy-service'],
                  sourceFingerprint,
                  backgroundWorkers: 'disabled',
                  requestTimeoutMs: 30000,
                },
              })}${MCP_HOST_MESSAGE_DELIMITER}`,
            );
            continue;
          }
          if (request.type === 'listTools') {
            listToolCount += 1;
            socket.write(
              `${JSON.stringify({
                id: request.id,
                ok: true,
                result: {
                  tools: [
                    {
                      name: 'healthy_tool',
                      description: 'fake healthy tool',
                      inputSchema: { type: 'object', properties: {} },
                    },
                  ],
                },
              })}${MCP_HOST_MESSAGE_DELIMITER}`,
            );
            continue;
          }
          if (request.type === 'shutdown') {
            shutdownCount += 1;
            socket.write(
              `${JSON.stringify({
                id: request.id,
                ok: true,
                result: null,
              })}${MCP_HOST_MESSAGE_DELIMITER}`,
            );
            socket.end();
            staleHost?.close();
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      staleHost?.once('error', reject);
      staleHost?.listen(socketPath, () => {
        staleHost?.off('error', reject);
        resolve();
      });
    });
    return { shutdowns: () => shutdownCount, listToolCalls: () => listToolCount };
  }

  it('starts the stdio server and calls initial_instructions', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'gnosis-stdio-mcp-'));
    tempDirs.push(runtimeDir);
    const socketPath = join(runtimeDir, 'mcp-host.sock');
    const lockPath = join(runtimeDir, 'mcp-host.lock');

    transport = new StdioClientTransport({
      command: process.argv[0] ?? 'bun',
      args: ['run', 'src/index.ts'],
      env: {
        ...process.env,
        GNOSIS_NO_WORKERS: 'true',
        GNOSIS_MCP_ADAPTER_IDLE_MS: '1000',
        GNOSIS_MCP_HOST_IDLE_EXIT_MS: '1000',
        GNOSIS_MCP_HOST_SOCKET_PATH: socketPath,
        GNOSIS_MCP_HOST_LOCK_PATH: lockPath,
      },
    });
    const client = new Client(
      { name: 'gnosis-stdio-integration-test', version: '0.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);
    const tools = await client.listTools();
    const result = (await client.callTool({ name: 'initial_instructions', arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };

    expect(tools.tools.map((tool) => tool.name)).toContain('initial_instructions');
    expect(tools.tools.map((tool) => tool.name)).toContain('analyze_references_from_text');
    expect(tools.tools.map((tool) => tool.name)).toContain('analyze_diff');
    expect(result.content.length).toBeGreaterThanOrEqual(1);
    expect(
      result.content.some(
        (item) => item.type === 'text' && String(item.text).includes('agentic_search'),
      ),
    ).toBe(true);
  });

  it('replaces a healthy stale singleton host before forwarding tool calls', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'gnosis-stdio-stale-mcp-'));
    tempDirs.push(runtimeDir);
    const socketPath = join(runtimeDir, 'mcp-host.sock');
    const lockPath = join(runtimeDir, 'mcp-host.lock');
    const stale = await startStaleHost(socketPath);

    transport = new StdioClientTransport({
      command: process.argv[0] ?? 'bun',
      args: ['run', 'src/index.ts'],
      env: {
        ...process.env,
        GNOSIS_NO_WORKERS: 'true',
        GNOSIS_MCP_ADAPTER_IDLE_MS: '1000',
        GNOSIS_MCP_HOST_IDLE_EXIT_MS: '1000',
        GNOSIS_MCP_HOST_START_TIMEOUT_MS: '5000',
        GNOSIS_MCP_HOST_SOCKET_PATH: socketPath,
        GNOSIS_MCP_HOST_LOCK_PATH: lockPath,
      },
    });
    const client = new Client(
      { name: 'gnosis-stdio-stale-host-test', version: '0.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);
    const tools = await client.listTools();
    const health = await sendMcpHostRequest<McpHostHealth>(
      { type: 'health' },
      { socketPath, timeoutMs: 1_000 },
    );

    expect(stale.shutdowns()).toBe(1);
    expect(tools.tools.map((tool) => tool.name)).toContain('initial_instructions');
    expect(health.sourceFingerprint).toBe(MCP_HOST_SOURCE_FINGERPRINT);
    expect(health.requestTimeoutMs).toBe(180000);

    await sendMcpHostRequest({ type: 'shutdown' }, { socketPath, timeoutMs: 1_000 }).catch(
      () => undefined,
    );
  });

  it('compares singleton host source against the current request root, not adapter startup state', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'gnosis-stdio-current-root-mcp-'));
    tempDirs.push(runtimeDir);
    mkdirSync(join(runtimeDir, 'src', 'mcp'), { recursive: true });
    mkdirSync(join(runtimeDir, 'src', 'scripts'), { recursive: true });
    writeFileSync(join(runtimeDir, 'package.json'), '{"name":"runtime-root"}\n');
    writeFileSync(join(runtimeDir, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(runtimeDir, 'src', 'scripts', 'mcp-host.ts'), 'export {};\n');
    writeFileSync(join(runtimeDir, 'src', 'mcp', 'placeholder.ts'), 'export {};\n');

    const socketPath = join(runtimeDir, 'mcp-host.sock');
    const lockPath = join(runtimeDir, 'mcp-host.lock');
    const runtimeFingerprint = computeMcpHostSourceFingerprint(runtimeDir);
    const healthy = await startHealthyHost(socketPath, runtimeFingerprint);

    transport = new StdioClientTransport({
      command: process.argv[0] ?? 'bun',
      args: ['run', join(process.cwd(), 'src/index.ts')],
      cwd: runtimeDir,
      env: {
        ...process.env,
        GNOSIS_MCP_HOST_AUTOSTART: 'false',
        GNOSIS_MCP_HOST_SOCKET_PATH: socketPath,
        GNOSIS_MCP_HOST_LOCK_PATH: lockPath,
      },
    });
    const client = new Client(
      { name: 'gnosis-stdio-current-root-test', version: '0.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);
    const tools = await client.listTools();

    expect(runtimeFingerprint).not.toBe(MCP_HOST_SOURCE_FINGERPRINT);
    expect(healthy.shutdowns()).toBe(0);
    expect(healthy.listToolCalls()).toBe(1);
    expect(tools.tools.map((tool) => tool.name)).toContain('healthy_tool');
  });
});
