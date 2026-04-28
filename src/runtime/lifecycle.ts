import { terminateActiveChildProcesses } from './childProcesses.js';
import type { ProcessRegistration } from './processRegistry.js';

export type ShutdownState = 'starting' | 'running' | 'stopping' | 'stopped' | 'force_exit';

export type ShutdownReason =
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'server_connect_error'
  | 'SIGTERM'
  | 'SIGINT'
  | 'stdin_close'
  | 'stdin_end'
  | 'stdin_error'
  | 'transport_close'
  | 'parent_lost'
  | 'fatal_start_error'
  | 'manual';

type CleanupStep = () => void | Promise<void>;

type RuntimeLifecycleOptions = {
  name: string;
  originalPpid?: number;
  cleanupTimeoutMs?: number;
  parentPollMs?: number;
  heartbeatMs?: number;
  registration?: ProcessRegistration;
  logger?: Pick<Console, 'error'>;
  exit?: (code: number) => void;
  stdin?: NodeJS.ReadStream;
};

function isFatalReason(reason: ShutdownReason): boolean {
  return (
    reason === 'uncaughtException' ||
    reason === 'unhandledRejection' ||
    reason === 'server_connect_error' ||
    reason === 'fatal_start_error'
  );
}

function parentIsAlive(pid: number): boolean {
  if (pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class RuntimeLifecycle {
  private stateValue: ShutdownState = 'starting';
  private readonly originalPpid: number;
  private readonly cleanupSteps: CleanupStep[] = [];
  private readonly logger: Pick<Console, 'error'>;
  private readonly exitFn: (code: number) => void;
  private readonly cleanupTimeoutMs: number;
  private readonly parentPollMs: number;
  private readonly heartbeatMs: number;
  private readonly registration?: ProcessRegistration;
  private heartbeatTimer: Timer | null = null;
  private parentTimer: Timer | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private winningReason: ShutdownReason | null = null;
  private fatalDuringShutdown = false;

  constructor(private readonly options: RuntimeLifecycleOptions) {
    this.originalPpid = options.originalPpid ?? process.ppid;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10_000;
    this.parentPollMs = options.parentPollMs ?? 2_000;
    this.heartbeatMs = options.heartbeatMs ?? 5_000;
    this.registration = options.registration;
    this.logger = options.logger ?? console;
    this.exitFn = options.exit ?? ((code: number) => process.exit(code));
  }

  get state(): ShutdownState {
    return this.stateValue;
  }

  markRunning(): void {
    if (this.stateValue === 'starting') this.stateValue = 'running';
  }

  addCleanupStep(step: CleanupStep): void {
    this.cleanupSteps.push(step);
  }

  startHeartbeat(): void {
    if (!this.registration || this.registration.status === 'disabled' || this.heartbeatTimer)
      return;
    this.heartbeatTimer = setInterval(() => {
      this.registration?.heartbeat();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  startParentWatch(): void {
    if (this.parentTimer || this.originalPpid <= 1) return;
    this.parentTimer = setInterval(() => {
      if (process.ppid === 1 || !parentIsAlive(this.originalPpid)) {
        void this.requestShutdown('parent_lost');
      }
    }, this.parentPollMs);
    this.parentTimer.unref?.();
  }

  bindProcessEvents(stdin: NodeJS.ReadStream = this.options.stdin ?? process.stdin): void {
    process.on('SIGINT', () => void this.requestShutdown('SIGINT'));
    process.on('SIGTERM', () => void this.requestShutdown('SIGTERM'));
    stdin.on('close', () => void this.requestShutdown('stdin_close'));
    stdin.on('end', () => void this.requestShutdown('stdin_end'));
    stdin.on('error', () => void this.requestShutdown('stdin_error'));
    process.on('uncaughtException', (error) => {
      this.logger.error(`[${this.options.name}] Uncaught Exception:`, error);
      void this.requestShutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
      this.logger.error(`[${this.options.name}] Unhandled Rejection:`, reason);
      void this.requestShutdown('unhandledRejection');
    });
  }

  requestShutdown(reason: ShutdownReason): Promise<void> {
    if (
      this.stateValue === 'stopping' ||
      this.stateValue === 'stopped' ||
      this.stateValue === 'force_exit'
    ) {
      if (isFatalReason(reason)) this.fatalDuringShutdown = true;
      this.logger.error(
        `[${this.options.name}] Shutdown already in progress (suppressedReason=${reason}, winningReason=${this.winningReason}, fatalDuringShutdown=${this.fatalDuringShutdown})`,
      );
      return this.shutdownPromise ?? Promise.resolve();
    }

    this.winningReason = reason;
    this.stateValue = 'stopping';
    this.shutdownPromise = this.runShutdown(reason);
    return this.shutdownPromise;
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.parentTimer) {
      clearInterval(this.parentTimer);
      this.parentTimer = null;
    }
  }

  private async runShutdown(reason: ShutdownReason): Promise<void> {
    this.logger.error(
      `[${this.options.name}] Shutdown initiated (reason=${reason}, pid=${process.pid})`,
    );

    const timeout = setTimeout(() => {
      this.stateValue = 'force_exit';
      this.logger.error(`[${this.options.name}] Shutdown timed out; forcing exit.`);
      this.exitFn(1);
    }, this.cleanupTimeoutMs);
    timeout.unref?.();

    this.clearTimers();

    try {
      await terminateActiveChildProcesses({ logger: this.logger });
      for (const step of this.cleanupSteps) {
        try {
          await step();
        } catch (error) {
          this.logger.error(`[${this.options.name}] Cleanup step failed:`, error);
        }
      }
      this.stateValue = 'stopped';
      clearTimeout(timeout);
      const exitCode = isFatalReason(reason) ? 1 : 0;
      this.logger.error(`[${this.options.name}] Shutdown complete (exitCode=${exitCode}).`);
      this.exitFn(exitCode);
    } catch (error) {
      clearTimeout(timeout);
      this.stateValue = 'stopped';
      this.logger.error(`[${this.options.name}] Shutdown cleanup failed:`, error);
      this.exitFn(1);
    }
  }
}
