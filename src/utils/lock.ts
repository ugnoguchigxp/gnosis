import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

const DEFAULT_LOCK_DIR = os.tmpdir();
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * システム全体で共有されるセマフォ（同時実行数制限）。
 */
export async function withGlobalSemaphore<T>(
  semaphoreName: string,
  maxConcurrency: number,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const start = Date.now();
  let acquiredIndex = -1;

  while (Date.now() - start < timeoutMs) {
    for (let i = 0; i < maxConcurrency; i++) {
      const lockFile = path.join(DEFAULT_LOCK_DIR, `gnosis-${semaphoreName}-${i}.lock`);
      try {
        // スタックしている古いロック（30分以上経過）を掃除
        try {
          const stats = statSync(lockFile);
          if (Date.now() - stats.mtimeMs > 30 * 60 * 1000) {
            unlinkSync(lockFile);
          }
        } catch (sErr) {
          // ignore
        }

        const fd = openSync(lockFile, 'wx');
        closeSync(fd);
        acquiredIndex = i;
        console.error(
          `[Semaphore] Acquired slot ${acquiredIndex + 1}/${maxConcurrency} for: ${semaphoreName}`,
        );
        break;
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'EEXIST'
        )
          continue;
        throw error;
      }
    }

    if (acquiredIndex !== -1) break;
    await setTimeout(Math.random() * 50 + 10);
  }

  if (acquiredIndex === -1) {
    throw new Error(`Global lock timeout: ${semaphoreName}`);
  }

  const lockFile = path.join(DEFAULT_LOCK_DIR, `gnosis-${semaphoreName}-${acquiredIndex}.lock`);
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockFile);
      console.error(
        `[Semaphore] Released slot ${acquiredIndex + 1}/${maxConcurrency} for: ${semaphoreName}`,
      );
    } catch (error) {
      console.error(`Failed to release semaphore: ${semaphoreName}.${acquiredIndex}`, error);
    }
  }
}

/**
 * システム全体で共有されるファイルベースのロック。
 * 名前が同じであれば、別々のプロセス間でも排他制御が行われます。
 */
export async function withGlobalLock<T>(
  lockName: string,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return withGlobalSemaphore(lockName, 1, fn, timeoutMs);
}
