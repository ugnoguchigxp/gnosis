import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

type Signal = NodeJS.Signals;

type ActiveChild = {
  pid: number;
  command?: string;
  startedAt: number;
};

const activeChildren = new Map<number, ActiveChild>();

export function trackChildProcess(child: Pick<ChildProcess, 'pid'>, command?: string): void {
  if (!child.pid) return;
  activeChildren.set(child.pid, {
    pid: child.pid,
    command,
    startedAt: Date.now(),
  });
}

export function untrackChildProcess(pid: number | undefined): void {
  if (!pid) return;
  activeChildren.delete(pid);
}

export function getActiveChildPids(): number[] {
  return [...activeChildren.keys()];
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function signalProcessTree(pid: number, signal: Signal): boolean {
  let signaled = false;

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      signaled = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        try {
          process.kill(pid, signal);
          signaled = true;
        } catch {
          // ignore
        }
      }
    }
  } else {
    try {
      process.kill(pid, signal);
      signaled = true;
    } catch {
      // ignore
    }
  }

  return signaled;
}

export async function terminateActiveChildProcesses(
  options: {
    graceMs?: number;
    logger?: Pick<Console, 'error'>;
  } = {},
): Promise<void> {
  const graceMs = options.graceMs ?? 3000;
  const logger = options.logger ?? console;
  const pids = getActiveChildPids();
  if (pids.length === 0) return;

  for (const pid of pids) {
    logger.error(`[ChildProcess] Sending SIGTERM to child process tree (PID: ${pid})`);
    signalProcessTree(pid, 'SIGTERM');
  }

  await delay(graceMs);

  for (const pid of pids) {
    if (!isProcessAlive(pid)) {
      activeChildren.delete(pid);
      continue;
    }
    logger.error(`[ChildProcess] Sending SIGKILL to child process tree (PID: ${pid})`);
    signalProcessTree(pid, 'SIGKILL');
    activeChildren.delete(pid);
  }
}

process.on('exit', () => {
  for (const pid of getActiveChildPids()) {
    signalProcessTree(pid, 'SIGTERM');
  }
});
