import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { type Socket, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { envBoolean, envNumber } from '../config.js';
import { GNOSIS_CONSTANTS } from '../constants.js';
import { closeDbPool } from '../db/index.js';
import { RuntimeLifecycle } from '../runtime/lifecycle.js';
import { registerProcess } from '../runtime/processRegistry.js';
import { startBackgroundWorkers, stopBackgroundWorkers } from '../services/background/manager.js';
import {
  MCP_HOST_MESSAGE_DELIMITER,
  type McpHostRequest,
  type McpHostResponse,
  ensureMcpHostSocketDir,
  getMcpHostSocketPath,
  sendMcpHostRequest,
} from './hostProtocol.js';
import { createMcpHostRouter, createMcpHostServices } from './services/index.js';

type HostOptions = {
  rootDir?: string;
  socketPath?: string;
};

function writeResponse(socket: Socket, response: McpHostResponse): void {
  socket.write(`${JSON.stringify(response)}${MCP_HOST_MESSAGE_DELIMITER}`);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostLockPath(rootDir: string): string {
  return join(resolve(rootDir), '.gnosis', 'mcp-host.lock');
}

async function existingHostIsHealthy(rootDir: string): Promise<boolean> {
  try {
    await sendMcpHostRequest({ type: 'health' }, { rootDir, timeoutMs: 500 });
    return true;
  } catch {
    return false;
  }
}

async function waitForExistingHostExit(rootDir: string, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await existingHostIsHealthy(rootDir))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Existing MCP host did not exit within ${timeoutMs}ms`);
}

async function replaceExistingHost(rootDir: string): Promise<void> {
  try {
    await sendMcpHostRequest({ type: 'shutdown' }, { rootDir, timeoutMs: 1000 });
  } catch (error) {
    if (!(await existingHostIsHealthy(rootDir))) return;
    throw error;
  }
  await waitForExistingHostExit(rootDir);
}

async function acquireHostLock(
  rootDir: string,
  options: { replaceExisting: boolean },
): Promise<() => void> {
  const lockPath = hostLockPath(rootDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { encoding: 'utf8', flag: 'wx' });
      return () => {
        try {
          const pid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
          if (pid === process.pid) rmSync(lockPath, { force: true });
        } catch {
          // best-effort cleanup
        }
      };
    } catch {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 5000) {
        if (await existingHostIsHealthy(rootDir)) {
          if (options.replaceExisting) {
            await replaceExistingHost(rootDir);
            break;
          }
          process.exit(0);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`Could not acquire MCP host lock: ${lockPath}`);
}

export async function startMcpHost(options: HostOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();
  const socketPath = options.socketPath ?? getMcpHostSocketPath(rootDir);
  const startedAt = Date.now();
  let activeRequests = 0;
  let lastActivityAt = Date.now();

  process.title = 'gnosis-mcp-host';
  ensureMcpHostSocketDir(rootDir);
  const replaceExisting = envBoolean(process.env.GNOSIS_MCP_HOST_REPLACE_EXISTING, false);
  if (await existingHostIsHealthy(rootDir)) {
    if (!replaceExisting) process.exit(0);
    await replaceExistingHost(rootDir);
  }
  const releaseHostLock = await acquireHostLock(rootDir, { replaceExisting });

  const automationEnabled = envBoolean(
    process.env.GNOSIS_ENABLE_AUTOMATION,
    GNOSIS_CONSTANTS.AUTOMATION_ENABLED_DEFAULT,
  );
  const workersEnabled = automationEnabled && process.env.GNOSIS_NO_WORKERS !== 'true';
  const services = await createMcpHostServices(rootDir);
  const router = createMcpHostRouter(services);
  const registration = registerProcess({
    role: 'mcp-host',
    title: process.title,
    cwd: rootDir,
  });
  const lifecycle = new RuntimeLifecycle({
    name: 'McpHost',
    registration,
  });
  const server = createServer();

  lifecycle.addCleanupStep(async () => {
    server.close();
  });
  lifecycle.addCleanupStep(() => {
    stopBackgroundWorkers();
  });
  lifecycle.addCleanupStep(async () => {
    await closeDbPool().catch((error) =>
      console.error(`[McpHost] Error closing DB pool: ${error}`),
    );
  });
  lifecycle.addCleanupStep(() => {
    registration.unregister();
    if (existsSync(socketPath)) unlinkSync(socketPath);
    releaseHostLock();
  });
  lifecycle.bindProcessEvents();
  lifecycle.markRunning();
  lifecycle.startHeartbeat();

  if (workersEnabled) {
    startBackgroundWorkers();
  } else {
    console.error('[McpHost] Background workers are OFF for MCP host.');
  }

  server.on('connection', (socket) => {
    let buffer = '';

    socket.on('error', (error) => {
      console.error(`[McpHost] Socket error: ${toErrorMessage(error)}`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split(MCP_HOST_MESSAGE_DELIMITER);
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        if (!part.trim()) continue;
        void handleRawMessage(socket, part);
      }
    });
  });

  async function handleRawMessage(socket: Socket, raw: string): Promise<void> {
    let request: McpHostRequest;
    try {
      request = JSON.parse(raw) as McpHostRequest;
    } catch (error) {
      writeResponse(socket, {
        id: 'unknown',
        ok: false,
        error: `Invalid host request JSON: ${toErrorMessage(error)}`,
      });
      return;
    }

    activeRequests += 1;
    lastActivityAt = Date.now();
    try {
      if (request.type === 'listTools') {
        writeResponse(socket, { id: request.id, ok: true, result: { tools: router.listTools() } });
        return;
      }
      if (request.type === 'callTool') {
        const result = await router.callTool(request.name, request.arguments);
        writeResponse(socket, { id: request.id, ok: true, result });
        return;
      }
      if (request.type === 'health') {
        writeResponse(socket, {
          id: request.id,
          ok: true,
          result: {
            pid: process.pid,
            uptimeMs: Date.now() - startedAt,
            socketPath,
            services: router.serviceNames(),
            backgroundWorkers: workersEnabled ? 'enabled' : 'disabled',
          },
        });
        return;
      }
      if (request.type === 'shutdown') {
        writeResponse(socket, { id: request.id, ok: true, result: null });
        void lifecycle.requestShutdown('manual');
        return;
      }
      writeResponse(socket, {
        id: (request as { id: string }).id,
        ok: false,
        error: 'Unknown host request type',
      });
    } catch (error) {
      writeResponse(socket, { id: request.id, ok: false, error: toErrorMessage(error) });
    } finally {
      activeRequests -= 1;
      lastActivityAt = Date.now();
    }
  }

  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const idleExitMs = envNumber(process.env.GNOSIS_MCP_HOST_IDLE_EXIT_MS, 0);
  if (idleExitMs > 0) {
    const idleTimer = setInterval(
      () => {
        if (activeRequests === 0 && Date.now() - lastActivityAt >= idleExitMs) {
          void lifecycle.requestShutdown('manual');
        }
      },
      Math.min(idleExitMs, 1000),
    );
    idleTimer.unref?.();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      console.error(`[McpHost] Listening on ${socketPath}`);
      resolve();
    });
  });
}
