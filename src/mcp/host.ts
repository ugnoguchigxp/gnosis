import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { type Socket, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { envBoolean, envNumber } from '../config.js';
import { GNOSIS_CONSTANTS } from '../constants.js';
import { closeDbPool } from '../db/index.js';
import { isProcessAlive } from '../runtime/childProcesses.js';
import { RuntimeLifecycle } from '../runtime/lifecycle.js';
import { getProcessRegistryDir, registerProcess } from '../runtime/processRegistry.js';
import { pruneDeadRegistryEntries } from '../runtime/processWatchdog.js';
import { startBackgroundWorkers, stopBackgroundWorkers } from '../services/background/manager.js';
import { lookupFailureFirewallContext } from '../services/failureFirewall/context.js';
import { runFailureFirewall } from '../services/failureFirewall/index.js';
import { suggestFailureFirewallLearningCandidates } from '../services/failureFirewall/learningCandidates.js';
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

function hostLog(event: string, fields: Record<string, unknown> = {}): void {
  console.error(
    `[McpHost] ${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      pid: process.pid,
      ...fields,
    })}`,
  );
}

function writeResponse(socket: Socket, response: McpHostResponse): boolean {
  if (socket.destroyed || !socket.writable) return false;
  return socket.write(`${JSON.stringify(response)}${MCP_HOST_MESSAGE_DELIMITER}`);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleFailureFirewallHostRequest(request: McpHostRequest) {
  if (request.type === 'failure_firewall/context') {
    return lookupFailureFirewallContext(request.input);
  }
  if (request.type === 'failure_firewall/run') {
    return runFailureFirewall({
      repoPath: request.input.repoPath,
      rawDiff: request.input.rawDiff,
      mode: request.input.mode,
      diffMode: request.input.diffMode,
      knowledgeSource: request.input.knowledgeSource,
    });
  }
  if (request.type === 'failure_firewall/suggest_learning_candidates') {
    return suggestFailureFirewallLearningCandidates(request.input);
  }
  return null;
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
    hostLog('replace_existing_start', { rootDir, socketPath });
    await sendMcpHostRequest({ type: 'shutdown' }, { rootDir, socketPath, timeoutMs: 1000 });
  } catch (error) {
    if (!(await existingHostIsHealthy(rootDir, socketPath))) return;
    hostLog('replace_existing_error', { rootDir, socketPath, error: toErrorMessage(error) });
    throw error;
  }
  await waitForExistingHostExit(rootDir, socketPath);
  hostLog('replace_existing_complete', { rootDir, socketPath });
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
      const lockContent = existsSync(lockPath) ? readFileSync(lockPath, 'utf8').trim() : '';
      const existingPid = Number.parseInt(lockContent, 10);
      hostLog('lock_busy', {
        rootDir,
        lockPath,
        existingPid,
        replaceExisting: options.replaceExisting,
      });

      while (Date.now() - startedAt < 10000) {
        const existingHealth = await getExistingHostHealth(rootDir, options.socketPath);
        if (existingHealth) {
          if (options.replaceExisting || !existingHostMatchesCurrentSource(existingHealth)) {
            hostLog('lock_replacing_existing_host', {
              rootDir,
              existingPid: existingHealth.pid,
              existingFingerprint: existingHealth.sourceFingerprint ?? null,
              currentFingerprint: MCP_HOST_SOURCE_FINGERPRINT,
              replaceExisting: options.replaceExisting,
            });
            await replaceExistingHost(rootDir, options.socketPath);
            break;
          }
          hostLog('lock_existing_host_current', {
            rootDir,
            existingPid: existingHealth.pid,
            sourceFingerprint: existingHealth.sourceFingerprint ?? null,
          });
          process.exit(0);
        }

        // ロック保持プロセスが死んでいれば即座にブレイク
        if (!Number.isNaN(existingPid) && !isProcessAlive(existingPid)) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // プロセスが生きているのに応答がない場合は、そちらに任せて終了する
      if (!Number.isNaN(existingPid) && isProcessAlive(existingPid)) {
        hostLog('lock_owner_alive_without_health', { rootDir, lockPath, existingPid });
        process.exit(0);
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
    hostLog('existing_host_detected', {
      rootDir,
      socketPath,
      existingPid: existingHealth.pid,
      existingFingerprint: existingHealth.sourceFingerprint ?? null,
      currentFingerprint: MCP_HOST_SOURCE_FINGERPRINT,
      replaceExisting,
    });
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
    envNumber(
      process.env.GNOSIS_MCP_HOST_REQUEST_TIMEOUT_MS,
      GNOSIS_CONSTANTS.MCP_HOST_REQUEST_TIMEOUT_MS_DEFAULT,
    ),
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

  // Periodic auto-cleanup of dead process registry entries (every 30s)
  const pruneIntervalMs = 30_000;
  const registryDir = getProcessRegistryDir(rootDir);
  const pruneTimer = setInterval(() => {
    try {
      pruneDeadRegistryEntries({ registryDir, selfPid: process.pid });
    } catch (error) {
      console.error(`[McpHost] Registry prune failed: ${toErrorMessage(error)}`);
    }
  }, pruneIntervalMs);
  pruneTimer.unref?.();
  lifecycle.addCleanupStep(() => {
    clearInterval(pruneTimer);
  });

  if (workersEnabled) {
    startBackgroundWorkers();
  } else {
    console.error('[McpHost] Background workers are OFF for MCP host.');
  }

  server.on('connection', (socket) => {
    let buffer = '';
    let socketActiveRequests = 0;
    totalConnections += 1;
    const connectionId = `${process.pid}-${Date.now()}-${totalConnections}`;

    if (activeSockets.size >= maxConnections) {
      hostLog('connection_rejected', {
        connectionId,
        activeConnections: activeSockets.size,
        maxConnections,
      });
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
    hostLog('connection_open', {
      connectionId,
      activeConnections: activeSockets.size,
      totalConnections,
    });

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
      hostLog('connection_close', {
        connectionId,
        activeConnections: activeSockets.size,
        socketActiveRequests,
      });
    });

    socket.on('error', (error) => {
      hostLog('socket_error', { connectionId, error: toErrorMessage(error) });
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split(MCP_HOST_MESSAGE_DELIMITER);
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        if (!part.trim()) continue;
        void handleRawMessage(socket, part, connectionId, {
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
    connectionId: string,
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
    const requestStartedAt = Date.now();
    const requestLabel =
      request.type === 'callTool' ? `${request.type}:${request.name}` : request.type;
    hostLog('request_start', {
      connectionId,
      requestId: request.id,
      requestType: request.type,
      requestLabel,
      activeRequests,
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      hooks.end();
      activeRequests -= 1;
      lastActivityAt = Date.now();
    };
    const respond = (response: McpHostResponse) => {
      if (finished) return;
      const written = writeResponse(socket, response);
      hostLog('response_write', {
        connectionId,
        requestId: request.id,
        requestType: request.type,
        ok: response.ok,
        written,
        durationMs: Date.now() - requestStartedAt,
      });
    };
    const abortController = new AbortController();
    const requestTimer =
      requestTimeoutMs > 0
        ? setTimeout(() => {
            timedOutRequests += 1;
            abortController.abort();
            hostLog('request_timeout', {
              connectionId,
              requestId: request.id,
              requestType: request.type,
              timeoutMs: requestTimeoutMs,
            });
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
        hostLog('shutdown_requested', { connectionId, requestId: request.id });
        void lifecycle.requestShutdown('manual');
        return;
      }
      if (
        request.type === 'failure_firewall/context' ||
        request.type === 'failure_firewall/run' ||
        request.type === 'failure_firewall/suggest_learning_candidates'
      ) {
        const result = await handleFailureFirewallHostRequest(request);
        respond({ id: request.id, ok: true, result });
        return;
      }
      respond({
        id: (request as { id: string }).id,
        ok: false,
        error: 'Unknown host request type',
      });
    } catch (error) {
      hostLog('request_error', {
        connectionId,
        requestId: request.id,
        requestType: request.type,
        error: toErrorMessage(error),
        durationMs: Date.now() - requestStartedAt,
      });
      respond({ id: request.id, ok: false, error: toErrorMessage(error) });
    } finally {
      if (requestTimer) clearTimeout(requestTimer);
      hostLog('request_end', {
        connectionId,
        requestId: request.id,
        requestType: request.type,
        durationMs: Date.now() - requestStartedAt,
      });
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
      hostLog('listening', {
        rootDir,
        socketPath,
        sourceFingerprint: MCP_HOST_SOURCE_FINGERPRINT,
        requestTimeoutMs,
        socketIdleTimeoutMs,
        services: router.serviceNames(),
      });
      resolve();
    });
  });
}
