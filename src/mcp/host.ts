import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { type Socket, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { envBoolean, envNumber } from '../config.js';
import { GNOSIS_CONSTANTS } from '../constants.js';
import { closeDbPool } from '../db/index.js';
import { RuntimeLifecycle } from '../runtime/lifecycle.js';
import { registerProcess } from '../runtime/processRegistry.js';
import { startBackgroundWorkers, stopBackgroundWorkers } from '../services/background/manager.js';
import { MCP_HOST_SOURCE_FINGERPRINT } from './hostFingerprint.js';
import {
  MCP_HOST_MESSAGE_DELIMITER,
  type McpHostHealth,
  type McpHostRequest,
  type McpHostResponse,
  type McpHostService,
  ensureMcpHostSocketDir,
  getMcpHostLockPath,
  getMcpHostSocketPath,
  sendMcpHostRequest,
} from './hostProtocol.js';
import { createMcpHostRouter, createMcpHostServices } from './services/index.js';

type HostOptions = {
  rootDir?: string;
  socketPath?: string;
  services?: McpHostService[];
  bindProcessEvents?: boolean;
  exit?: (code: number) => void;
};

function writeResponse(socket: Socket, response: McpHostResponse): boolean {
  if (socket.destroyed || !socket.writable) return false;
  return socket.write(`${JSON.stringify(response)}${MCP_HOST_MESSAGE_DELIMITER}`);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostLockPath(rootDir: string): string {
  return getMcpHostLockPath(rootDir);
}

async function getExistingHostHealth(
  rootDir: string,
  socketPath?: string,
): Promise<McpHostHealth | null> {
  try {
    return await sendMcpHostRequest<McpHostHealth>(
      { type: 'health' },
      { rootDir, socketPath, timeoutMs: 500 },
    );
  } catch {
    return null;
  }
}

async function existingHostIsHealthy(rootDir: string, socketPath?: string): Promise<boolean> {
  return (await getExistingHostHealth(rootDir, socketPath)) !== null;
}

function existingHostMatchesCurrentSource(health: McpHostHealth | null): boolean {
  return health?.sourceFingerprint === MCP_HOST_SOURCE_FINGERPRINT;
}

async function waitForExistingHostExit(
  rootDir: string,
  socketPath: string | undefined,
  timeoutMs = 5000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await existingHostIsHealthy(rootDir, socketPath))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Existing MCP host did not exit within ${timeoutMs}ms`);
}

async function replaceExistingHost(rootDir: string, socketPath?: string): Promise<void> {
  try {
    await sendMcpHostRequest({ type: 'shutdown' }, { rootDir, socketPath, timeoutMs: 1000 });
  } catch (error) {
    if (!(await existingHostIsHealthy(rootDir, socketPath))) return;
    throw error;
  }
  await waitForExistingHostExit(rootDir, socketPath);
}

async function acquireHostLock(
  rootDir: string,
  options: { replaceExisting: boolean; socketPath?: string },
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
        const existingHealth = await getExistingHostHealth(rootDir, options.socketPath);
        if (existingHealth) {
          if (options.replaceExisting || !existingHostMatchesCurrentSource(existingHealth)) {
            await replaceExistingHost(rootDir, options.socketPath);
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
  const activeSockets = new Set<Socket>();
  let activeRequests = 0;
  let lastActivityAt = Date.now();
  let totalConnections = 0;
  let timedOutRequests = 0;

  process.title = 'gnosis-mcp-host';
  ensureMcpHostSocketDir(rootDir);
  const replaceExisting = envBoolean(process.env.GNOSIS_MCP_HOST_REPLACE_EXISTING, false);
  const existingHealth = await getExistingHostHealth(rootDir, socketPath);
  if (existingHealth) {
    if (!replaceExisting && existingHostMatchesCurrentSource(existingHealth)) process.exit(0);
    await replaceExistingHost(rootDir, socketPath);
  }
  const releaseHostLock = await acquireHostLock(rootDir, { replaceExisting, socketPath });

  const automationEnabled = envBoolean(
    process.env.GNOSIS_ENABLE_AUTOMATION,
    GNOSIS_CONSTANTS.AUTOMATION_ENABLED_DEFAULT,
  );
  const workersEnabled = automationEnabled && process.env.GNOSIS_NO_WORKERS !== 'true';
  const services = options.services ?? (await createMcpHostServices(rootDir));
  const router = createMcpHostRouter(services);
  const registration = registerProcess({
    role: 'mcp-host',
    title: process.title,
    cwd: rootDir,
  });
  const lifecycle = new RuntimeLifecycle({
    name: 'McpHost',
    registration,
    exit: options.exit,
  });
  const server = createServer();
  const maxConnections = Math.max(1, envNumber(process.env.GNOSIS_MCP_HOST_MAX_CONNECTIONS, 128));
  const socketIdleTimeoutMs = Math.max(
    0,
    envNumber(process.env.GNOSIS_MCP_HOST_SOCKET_IDLE_MS, 60_000),
  );
  const requestTimeoutMs = Math.max(
    0,
    envNumber(process.env.GNOSIS_MCP_HOST_REQUEST_TIMEOUT_MS, 180_000),
  );

  lifecycle.addCleanupStep(async () => {
    server.close();
  });
  lifecycle.addCleanupStep(() => {
    for (const socket of activeSockets) {
      socket.destroy();
    }
    activeSockets.clear();
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
  if (options.bindProcessEvents !== false) lifecycle.bindProcessEvents();
  lifecycle.markRunning();
  lifecycle.startHeartbeat();

  if (workersEnabled) {
    startBackgroundWorkers();
  } else {
    console.error('[McpHost] Background workers are OFF for MCP host.');
  }

  server.on('connection', (socket) => {
    let buffer = '';
    let socketActiveRequests = 0;
    totalConnections += 1;

    if (activeSockets.size >= maxConnections) {
      writeResponse(socket, {
        id: 'connection',
        ok: false,
        error: `MCP host connection limit exceeded: active=${activeSockets.size}, max=${maxConnections}`,
      });
      socket.destroy();
      return;
    }

    activeSockets.add(socket);
    lastActivityAt = Date.now();

    if (socketIdleTimeoutMs > 0) {
      socket.setTimeout(socketIdleTimeoutMs, () => {
        if (socketActiveRequests > 0) {
          socket.setTimeout(socketIdleTimeoutMs);
          return;
        }
        console.error(
          `[McpHost] Closing idle socket after ${socketIdleTimeoutMs}ms (activeConnections=${activeSockets.size})`,
        );
        socket.destroy();
      });
    }

    socket.on('close', () => {
      activeSockets.delete(socket);
      lastActivityAt = Date.now();
    });

    socket.on('error', (error) => {
      console.error(`[McpHost] Socket error: ${toErrorMessage(error)}`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split(MCP_HOST_MESSAGE_DELIMITER);
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        if (!part.trim()) continue;
        void handleRawMessage(socket, part, {
          begin: () => {
            socketActiveRequests += 1;
          },
          end: () => {
            socketActiveRequests = Math.max(0, socketActiveRequests - 1);
          },
        });
      }
    });
  });

  async function handleRawMessage(
    socket: Socket,
    raw: string,
    hooks: { begin: () => void; end: () => void },
  ): Promise<void> {
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

    hooks.begin();
    activeRequests += 1;
    lastActivityAt = Date.now();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      hooks.end();
      activeRequests -= 1;
      lastActivityAt = Date.now();
    };
    const respond = (response: McpHostResponse) => {
      if (finished) return;
      writeResponse(socket, response);
    };
    const abortController = new AbortController();
    const requestTimer =
      requestTimeoutMs > 0
        ? setTimeout(() => {
            timedOutRequests += 1;
            abortController.abort();
            respond({
              id: request.id,
              ok: false,
              error: `MCP host request timed out after ${requestTimeoutMs}ms`,
            });
            finish();
          }, requestTimeoutMs)
        : null;
    requestTimer?.unref?.();

    try {
      if (request.type === 'listTools') {
        respond({ id: request.id, ok: true, result: { tools: router.listTools() } });
        return;
      }
      if (request.type === 'callTool') {
        const result = await router.callTool(request.name, request.arguments, {
          signal: abortController.signal,
        });
        respond({ id: request.id, ok: true, result });
        return;
      }
      if (request.type === 'health') {
        respond({
          id: request.id,
          ok: true,
          result: {
            pid: process.pid,
            uptimeMs: Date.now() - startedAt,
            socketPath,
            services: router.serviceNames(),
            serviceVersions: router.serviceInfo(),
            sourceFingerprint: MCP_HOST_SOURCE_FINGERPRINT,
            cwd: rootDir,
            argv: process.argv.slice(0, 4),
            backgroundWorkers: workersEnabled ? 'enabled' : 'disabled',
            activeConnections: activeSockets.size,
            totalConnections,
            maxConnections,
            activeRequests: Math.max(0, activeRequests - 1),
            timedOutRequests,
            socketIdleTimeoutMs,
            requestTimeoutMs,
          },
        });
        return;
      }
      if (request.type === 'shutdown') {
        respond({ id: request.id, ok: true, result: null });
        void lifecycle.requestShutdown('manual');
        return;
      }
      respond({
        id: (request as { id: string }).id,
        ok: false,
        error: 'Unknown host request type',
      });
    } catch (error) {
      respond({ id: request.id, ok: false, error: toErrorMessage(error) });
    } finally {
      if (requestTimer) clearTimeout(requestTimer);
      finish();
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
    lifecycle.addCleanupStep(() => {
      clearInterval(idleTimer);
    });
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
