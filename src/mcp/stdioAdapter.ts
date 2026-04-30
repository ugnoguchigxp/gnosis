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
import {
  type McpHostHealth,
  type McpHostToolResult,
  getMcpHostSocketPath,
  sendMcpHostRequest,
} from './hostProtocol.js';

function toErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: `[MCP_HOST_ERROR] ${message}` }],
    isError: true,
  };
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
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await sendMcpHostRequest<McpHostHealth>(
        { type: 'health' },
        { rootDir, timeoutMs: 500 },
      );
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function ensureHostRunning(rootDir: string): Promise<void> {
  try {
    await sendMcpHostRequest<McpHostHealth>({ type: 'health' }, { rootDir, timeoutMs: 500 });
    return;
  } catch {
    // Fall through to optional autostart.
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
  child.unref();
  await waitForHost(rootDir, envNumber(process.env.GNOSIS_MCP_HOST_START_TIMEOUT_MS, 5000));
}

export async function runStdioAdapter(rootDir = process.cwd()): Promise<void> {
  process.title = 'gnosis-mcp-adapter';
  redirectLogs();
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
    try {
      await ensureHostRunning(rootDir);
      const result = await sendMcpHostRequest<ListToolsResult>({ type: 'listTools' }, { rootDir });
      return { tools: result.tools as Tool[] };
    } finally {
      activeRequests -= 1;
      lastActivityAt = Date.now();
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    activeRequests += 1;
    lastActivityAt = Date.now();
    try {
      await ensureHostRunning(rootDir);
      return await sendMcpHostRequest<McpHostToolResult>(
        {
          type: 'callTool',
          name: request.params.name,
          arguments: request.params.arguments,
        },
        { rootDir },
      );
    } catch (error) {
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
