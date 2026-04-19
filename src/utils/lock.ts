import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

const DEFAULT_LOCK_DIR = os.tmpdir();
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * lock.ts の依存する fs 操作を DI できるインターフェース。
 * テスト時にモックを注入することで、fs をモックせずにテストできる。
 */
export type LockFs = {
  existsSync: (path: string) => boolean;
  statSync: (path: string) => { mtimeMs: number };
  readFileSync: (path: string, encoding: string) => string;
  unlinkSync: (path: string) => void;
  writeFileSync: (path: string, data: string, options: { flag: string }) => void;
};

const defaultLockFs: LockFs = {
  existsSync,
  statSync,
  readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
  unlinkSync,
  writeFileSync,
};

/**
 * システム全体で共有されるセマフォ（同時実行数制限）。
 */
export async function withGlobalSemaphore<T>(
  semaphoreName: string,
  maxConcurrency: number,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  fs: LockFs = defaultLockFs,
): Promise<T> {
  const start = Date.now();
  let acquiredIndex = -1;

  while (Date.now() - start < timeoutMs) {
    for (let i = 0; i < maxConcurrency; i++) {
      const lockFile = path.join(DEFAULT_LOCK_DIR, `gnosis-${semaphoreName}-${i}.lock`);
      try {
        // スタックしている古いロックを掃除
        if (fs.existsSync(lockFile)) {
          try {
            const stats = fs.statSync(lockFile);
            const content = fs.readFileSync(lockFile, 'utf8').trim();
            const pid = Number.parseInt(content, 10);

            let isAlive = false;
            if (!Number.isNaN(pid)) {
              try {
                // プロセスが生きていれば signal 0 は成功する
                process.kill(pid, 0);
                isAlive = true;
              } catch (_e) {
                isAlive = false;
              }
            }

            // プロセスが死んでいるか、または30分以上経過している場合は削除
            if (!isAlive || Date.now() - stats.mtimeMs > 30 * 60 * 1000) {
              fs.unlinkSync(lockFile);
              console.error(
                `[Semaphore] Cleaned up stale lock: ${lockFile} (PID ${pid} alive: ${isAlive})`,
              );
            }
          } catch (_sErr) {
            // ignore
          }
        }

        fs.writeFileSync(lockFile, process.pid.toString(), { flag: 'wx' });

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
      fs.unlinkSync(lockFile);
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
  fs: LockFs = defaultLockFs,
): Promise<T> {
  return withGlobalSemaphore(lockName, 1, fn, timeoutMs, fs);
}
