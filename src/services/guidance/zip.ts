import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

const runCommand = async (
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr });
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      settleReject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        settleReject(new Error(`${command} failed: ${detail}`));
        return;
      }
      settleResolve();
    });
  });

const toNormalizedZipEntryPath = (entry: string): string => entry.trim().replaceAll('\\', '/');

export const isSafeZipEntryPath = (entry: string): boolean => {
  if (!entry || entry.includes('\u0000')) return false;
  const normalized = path.posix.normalize(toNormalizedZipEntryPath(entry));
  if (normalized.startsWith('../')) return false;
  if (path.posix.isAbsolute(normalized)) return false;
  return normalized.length > 0;
};

export const listZipEntries = async (zipPath: string): Promise<string[]> => {
  const { stdout } = await runCommand('unzip', ['-Z1', zipPath]);
  return stdout
    .split(/\r?\n/)
    .map((entry) => toNormalizedZipEntryPath(entry))
    .filter((entry) => entry.length > 0 && !entry.endsWith('/'));
};

export const readZipEntryText = async (zipPath: string, entry: string): Promise<string> => {
  const { stdout } = await runCommand('unzip', ['-p', zipPath, entry]);
  return stdout.toString().replaceAll('\r\n', '\n');
};

export const computeFileHash = async (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);

    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('error', (error) => reject(error));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
