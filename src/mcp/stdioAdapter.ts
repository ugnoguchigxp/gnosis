import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { envBoolean, envNumber } from '../config.js';
import { RuntimeLifecycle } from '../runtime/lifecycle.js';
import { registerProcess } from '../runtime/processRegistry.js';
import { computeMcpHostSourceFingerprint } from './hostFingerprint.js';
import {
  type McpHostHealth,
  type McpHostToolResult,
  getMcpHostSocketPath,
  sendMcpHostRequest,
} from './hostProtocol.js';

function adapterLog(event: string, fields: Record<string, unknown> = {}): void {
  console.error(
    `[McpAdapter] ${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      pid: process.pid,
      ppid: process.ppid,
      ...fields,
    })}`,
  );
}

function toErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  adapterLog('tool_error_result', { message });
  return {
    content: [{ type: 'text' as const, text: `[MCP_HOST_ERROR] ${message}` }],
    isError: true,
  };
}

function resolveRequestRootDir(defaultRootDir: string, args: unknown): string {
  if (!args || typeof args !== 'object') return defaultRootDir;
  const candidate = (args as Record<string, unknown>).repoPath;
  if (typeof candidate !== 'string' || candidate.trim().length === 0) return defaultRootDir;
  return candidate;
}

function redirectLogs(): void {
  const originalError = console.error;
  console.log = (...args: unknown[]) => originalError(...args);
  console.info = (...args: unknown[]) => originalError(...args);
  console.warn = (...args: unknown[]) => originalError(...args);
}

async function waitForHost(rootDir: string, timeoutMs: number): Promise<McpHostHealth> {
  const startedAt = Date.now();
  let lastError: unknown;
  adapterLog('wait_for_host_start', {
    rootDir,
    timeoutMs,
    socketPath: getMcpHostSocketPath(rootDir),
  });
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const health = await sendMcpHostRequest<McpHostHealth>(
        { type: 'health' },
        { rootDir, timeoutMs: 500 },
      );
      adapterLog('wait_for_host_success', {
        rootDir,
        hostPid: health.pid,
        sourceFingerprint: health.sourceFingerprint ?? null,
        durationMs: Date.now() - startedAt,
      });
      return health;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  adapterLog('wait_for_host_failed', {
    rootDir,
    timeoutMs,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function hostMatchesCurrentSource(rootDir: string, health: McpHostHealth): boolean {
  return health.sourceFingerprint === computeMcpHostSourceFingerprint(rootDir);
}

async function waitForHostExit(rootDir: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await sendMcpHostRequest<McpHostHealth>({ type: 'health' }, { rootDir, timeoutMs: 500 });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Stale MCP host did not exit within ${timeoutMs}ms`);
}

async function shutdownStaleHost(rootDir: string): Promise<void> {
  adapterLog('shutdown_stale_host_start', { rootDir, socketPath: getMcpHostSocketPath(rootDir) });
  await sendMcpHostRequest({ type: 'shutdown' }, { rootDir, timeoutMs: 1_000 }).catch(
    async (error) => {
      try {
        await sendMcpHostRequest<McpHostHealth>({ type: 'health' }, { rootDir, timeoutMs: 500 });
      } catch {
        return;
      }
      throw error;
    },
  );
  await waitForHostExit(rootDir, envNumber(process.env.GNOSIS_MCP_HOST_REPLACE_TIMEOUT_MS, 5000));
  adapterLog('shutdown_stale_host_complete', { rootDir });
}

let hostStartupPromise: Promise<void> | null = null;

async function ensureHostRunning(rootDir: string): Promise<void> {
  if (hostStartupPromise) return hostStartupPromise;

  hostStartupPromise = (async () => {
    let health: McpHostHealth | null = null;
    try {
      health = await sendMcpHostRequest<McpHostHealth>(
        { type: 'health' },
        { rootDir, timeoutMs: 1000 }, // Increased from 500ms
      );
      adapterLog('ensure_host_health_ok', {
        rootDir,
        hostPid: health.pid,
        sourceFingerprint: health.sourceFingerprint ?? null,
        currentFingerprint: computeMcpHostSourceFingerprint(rootDir),
      });
    } catch (error) {
      adapterLog('ensure_host_health_failed', {
        rootDir,
        socketPath: getMcpHostSocketPath(rootDir),
        error: error instanceof Error ? error.message : String(error),
      });
      health = null;
    }

    if (health) {
      if (hostMatchesCurrentSource(rootDir, health)) {
        adapterLog('ensure_host_current', { rootDir, hostPid: health.pid });
        return;
      }
      const replaceStale = envBoolean(process.env.GNOSIS_MCP_HOST_REPLACE_STALE, true);
      if (!replaceStale) {
        const currentFingerprint = computeMcpHostSourceFingerprint(rootDir);
        throw new Error(
          `MCP host source fingerprint mismatch: running=${
            health.sourceFingerprint ?? 'unknown'
          }, current=${currentFingerprint}`,
        );
      }
      adapterLog('ensure_host_stale', {
        rootDir,
        hostPid: health.pid,
        runningFingerprint: health.sourceFingerprint ?? null,
        currentFingerprint: computeMcpHostSourceFingerprint(rootDir),
      });
      await shutdownStaleHost(rootDir);
    }

    const autostart = envBoolean(process.env.GNOSIS_MCP_HOST_AUTOSTART, true);
    if (!autostart) {
      throw new Error(`MCP host is not running at ${getMcpHostSocketPath(rootDir)}`);
    }

    const bunCommand = process.argv[0] || 'bun';
    const child = spawn(bunCommand, ['run', 'src/scripts/mcp-host.ts'], {
      cwd: rootDir,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    adapterLog('ensure_host_spawned', { rootDir, childPid: child.pid ?? null, bunCommand });
    child.unref();
    await waitForHost(rootDir, envNumber(process.env.GNOSIS_MCP_HOST_START_TIMEOUT_MS, 10000)); // Increased from 5000ms
  })().finally(() => {
    hostStartupPromise = null;
  });

  return hostStartupPromise;
}

export async function runStdioAdapter(rootDir = process.cwd()): Promise<void> {
  process.title = 'gnosis-mcp-adapter';
  redirectLogs();
  adapterLog('start', { rootDir, argv: process.argv.slice(0, 4) });
  const registration = registerProcess({
    role: 'mcp-adapter',
    title: process.title,
    cwd: rootDir,
  });
  let unregistered = false;
  const unregister = () => {
    if (unregistered) return;
    unregistered = true;
    registration.unregister();
  };
  const lifecycle = new RuntimeLifecycle({
    name: 'McpAdapter',
    registration,
    originalPpid: process.ppid,
    cleanupTimeoutMs: envNumber(process.env.GNOSIS_MCP_ADAPTER_CLEANUP_TIMEOUT_MS, 5000),
    parentPollMs: envNumber(process.env.GNOSIS_MCP_ADAPTER_PARENT_POLL_MS, 2000),
  });
  lifecycle.addCleanupStep(() => {
    unregister();
  });

  const server = new Server(
    {
      name: 'gnosis-mcp-adapter',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );
  let lastActivityAt = Date.now();
  let activeRequests = 0;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    activeRequests += 1;
    lastActivityAt = Date.now();
    const startedAt = Date.now();
    adapterLog('list_tools_start', { rootDir, activeRequests });
    try {
      await ensureHostRunning(rootDir);
      const result = await sendMcpHostRequest<ListToolsResult>({ type: 'listTools' }, { rootDir });
      adapterLog('list_tools_success', {
        rootDir,
        toolCount: result.tools.length,
        durationMs: Date.now() - startedAt,
      });
      return { tools: result.tools as Tool[] };
    } catch (error) {
      adapterLog('list_tools_error', {
        rootDir,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      activeRequests -= 1;
      lastActivityAt = Date.now();
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    activeRequests += 1;
    lastActivityAt = Date.now();
    const startedAt = Date.now();
    const requestRootDir = resolveRequestRootDir(rootDir, request.params.arguments);
    adapterLog('call_tool_start', {
      rootDir: requestRootDir,
      defaultRootDir: rootDir,
      toolName: request.params.name,
      activeRequests,
    });
    try {
      await ensureHostRunning(requestRootDir);
      const result = await sendMcpHostRequest<McpHostToolResult>(
        {
          type: 'callTool',
          name: request.params.name,
          arguments: request.params.arguments,
        },
        { rootDir: requestRootDir },
      );
      adapterLog('call_tool_success', {
        rootDir: requestRootDir,
        toolName: request.params.name,
        isError: result.isError ?? false,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      adapterLog('call_tool_error', {
        rootDir: requestRootDir,
        toolName: request.params.name,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return toErrorResult(error);
    } finally {
      activeRequests -= 1;
      lastActivityAt = Date.now();
    }
  });

  const transport = new StdioServerTransport();
  process.on('exit', () => {
    unregister();
  });
  (transport as unknown as { onclose?: () => void }).onclose = () => {
    void lifecycle.requestShutdown('transport_close');
  };
  lifecycle.bindProcessEvents(process.stdin);
  lifecycle.startHeartbeat();
  lifecycle.startParentWatch();

  const idleMs = envNumber(process.env.GNOSIS_MCP_ADAPTER_IDLE_MS, 0);
  if (idleMs > 0) {
    const idleTimer = setInterval(
      () => {
        if (activeRequests === 0 && Date.now() - lastActivityAt >= idleMs) {
          void lifecycle.requestShutdown('transport_close');
        }
      },
      Math.min(idleMs, 1000),
    );
    idleTimer.unref?.();
    lifecycle.addCleanupStep(() => {
      clearInterval(idleTimer);
    });
  }

  await server.connect(transport);
  lifecycle.markRunning();
}
