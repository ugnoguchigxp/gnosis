import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

const DEFAULT_LOCK_DIR = os.tmpdir();
const RETRY_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * システム全体で共有されるファイルベースのロック。
 * 名前が同じであれば、別々のプロセス間でも排他制御が行われます。
 */
export async function withGlobalLock<T>(
  lockName: string,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const lockFile = path.join(DEFAULT_LOCK_DIR, `gnosis-${lockName}.lock`);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      // wxフラグ: ファイルが存在しない時のみ作成。存在すればエラーを投げる（排他制御）
      const fd = openSync(lockFile, 'wx');
      closeSync(fd);
      break;
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        // すでにロックされている場合は待機
        await setTimeout(RETRY_INTERVAL_MS);
        continue;
      }
      throw error;
    }
  }

  if (!existsSync(lockFile)) {
    // タイムアウト
    throw new Error(`Global lock timeout after ${timeoutMs}ms: ${lockName}`);
  }

  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockFile);
    } catch (error) {
      console.warn(`Failed to release global lock: ${lockFile}`, error);
    }
  }
}
