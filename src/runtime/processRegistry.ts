import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export type ProcessRole =
  | 'mcp-server'
  | 'mcp-tools'
  | 'semantic-mcp'
  | 'worker'
  | 'child-process'
  | 'watchdog';

export type RegistryStatus = 'enabled' | 'disabled' | 'degraded';

export type ProcessRegistryEntry = {
  schemaVersion: 1;
  pid: number;
  ppid: number;
  originalPpid: number;
  startedAt: string;
  startedAtEpochMs: number;
  heartbeatAt: string;
  cwd: string;
  argv: string[];
  title: string;
  role: ProcessRole;
  registryStatus?: RegistryStatus;
};

export type RegistryReadResult =
  | { kind: 'entry'; path: string; entry: ProcessRegistryEntry }
  | { kind: 'corrupt'; path: string; error: string };

export type ProcessRegistration = {
  entry: ProcessRegistryEntry;
  filePath?: string;
  status: RegistryStatus;
  heartbeat: () => RegistryStatus;
  unregister: () => void;
};

export function getProcessRegistryDir(rootDir = process.cwd()): string {
  return join(resolve(rootDir), '.gnosis', 'processes');
}

function ensureRegistryDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function toFileName(
  entry: Pick<ProcessRegistryEntry, 'role' | 'pid' | 'startedAtEpochMs'>,
): string {
  return `${entry.role}-${entry.pid}-${entry.startedAtEpochMs}.json`;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function buildEntry(options: {
  role: ProcessRole;
  cwd?: string;
  argv?: string[];
  title?: string;
  pid?: number;
  ppid?: number;
}): ProcessRegistryEntry {
  const now = new Date();
  const pid = options.pid ?? process.pid;
  const ppid = options.ppid ?? process.ppid;
  return {
    schemaVersion: 1,
    pid,
    ppid,
    originalPpid: ppid,
    startedAt: now.toISOString(),
    startedAtEpochMs: now.getTime(),
    heartbeatAt: now.toISOString(),
    cwd: resolve(options.cwd ?? process.cwd()),
    argv: options.argv ?? process.argv,
    title: options.title ?? process.title,
    role: options.role,
    registryStatus: 'enabled',
  };
}

export function registerProcess(options: {
  role: ProcessRole;
  cwd?: string;
  argv?: string[];
  title?: string;
  registryDir?: string;
  logger?: Pick<Console, 'error'>;
}): ProcessRegistration {
  const logger = options.logger ?? console;
  const entry = buildEntry(options);
  const registryDir = options.registryDir ?? getProcessRegistryDir(entry.cwd);
  const filePath = join(registryDir, toFileName(entry));
  let status: RegistryStatus = 'enabled';

  try {
    ensureRegistryDir(registryDir);
    writeJsonAtomic(filePath, entry);
  } catch (error) {
    status = 'disabled';
    logger.error(
      `[ProcessRegistry] Warning: registry create failed; continuing without registry (${error})`,
    );
  }

  const registration: ProcessRegistration = {
    entry: { ...entry, registryStatus: status },
    filePath: status === 'enabled' ? filePath : undefined,
    get status() {
      return status;
    },
    heartbeat: () => {
      if (!registration.filePath || status === 'disabled') return status;
      const heartbeatAt = new Date().toISOString();
      registration.entry = {
        ...registration.entry,
        heartbeatAt,
        registryStatus: status,
      };
      try {
        writeJsonAtomic(registration.filePath, registration.entry);
      } catch (error) {
        status = 'degraded';
        registration.entry = {
          ...registration.entry,
          registryStatus: status,
        };
        logger.error(`[ProcessRegistry] Warning: heartbeat failed; registry degraded (${error})`);
      }
      return status;
    },
    unregister: () => {
      if (!registration.filePath || status === 'disabled') return;
      try {
        const current = JSON.parse(
          readFileSync(registration.filePath, 'utf8'),
        ) as Partial<ProcessRegistryEntry>;
        if (
          current.pid === registration.entry.pid &&
          current.startedAtEpochMs === registration.entry.startedAtEpochMs &&
          current.cwd === registration.entry.cwd &&
          current.role === registration.entry.role
        ) {
          rmSync(registration.filePath, { force: true });
        }
      } catch (error) {
        logger.error(`[ProcessRegistry] Warning: unregister failed (${error})`);
      }
    },
  };

  return registration;
}

export function readRegistryEntries(registryDir = getProcessRegistryDir()): RegistryReadResult[] {
  if (!existsSync(registryDir)) return [];
  return readdirSync(registryDir)
    .filter((name) => name.endsWith('.json'))
    .map((name): RegistryReadResult => {
      const path = join(registryDir, name);
      try {
        const entry = JSON.parse(readFileSync(path, 'utf8')) as ProcessRegistryEntry;
        return { kind: 'entry', path, entry };
      } catch (error) {
        return {
          kind: 'corrupt',
          path,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
}

export function removeRegistryFile(path: string): void {
  rmSync(path, { force: true });
}
