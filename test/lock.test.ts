import { describe, expect, it, mock } from 'bun:test';
import type { LockFs } from '../src/utils/lock';
import { withGlobalLock } from '../src/utils/lock';

// 待機時間をゼロにするために setTimeout だけモック（プロミス版）
mock.module('node:timers/promises', () => ({
  setTimeout: async () => {},
}));

/**
 * テスト用の LockFs モック。
 * writeFileSync の flag:'wx' でEEXISTをスローする振る舞いを制御する。
 */
const makeLockFs = (overrides: Partial<LockFs> = {}): LockFs => ({
  existsSync: mock(() => false),
  statSync: mock(() => ({ mtimeMs: Date.now() })),
  readFileSync: mock(() => String(process.pid)),
  unlinkSync: mock(() => {}),
  writeFileSync: mock(() => {}),
  ...overrides,
});

describe('lock utility', () => {
  it('acquires and releases a lock successfully', async () => {
    const fs = makeLockFs({
      existsSync: mock(() => false), // no stale lock
    });

    const result = await withGlobalLock('test', async () => 'success', 5000, fs);

    expect(result).toBe('success');
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  it('retries if lock already exists (EEXIST)', async () => {
    let calls = 0;
    const writeFileSync = mock(() => {
      if (calls === 0) {
        calls++;
        const err = new Error('EEXIST');
        Object.defineProperty(err, 'code', { value: 'EEXIST' });
        throw err;
      }
    });
    const fs = makeLockFs({
      existsSync: mock(() => false),
      writeFileSync,
    });

    const result = await withGlobalLock('retry-test', async () => 'ok', 5000, fs);

    expect(result).toBe('ok');
    expect(writeFileSync).toHaveBeenCalledTimes(2);
    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  it('throws error if timeout is reached', async () => {
    const writeFileSync = mock(() => {
      const err = new Error('EEXIST');
      Object.defineProperty(err, 'code', { value: 'EEXIST' });
      throw err;
    });
    const fs = makeLockFs({
      existsSync: mock(() => false),
      writeFileSync,
    });

    await expect(withGlobalLock('timeout-test', async () => 'bad', 10, fs)).rejects.toThrow(
      /Global lock timeout/,
    );
  });

  it('releases lock even if inner function fails', async () => {
    const fs = makeLockFs({
      existsSync: mock(() => false),
    });

    try {
      await withGlobalLock(
        'error-test',
        async () => {
          throw new Error('inner failure');
        },
        5000,
        fs,
      );
    } catch (_e) {
      // ignore
    }

    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  it('rethrows unexpected errors from writeFileSync', async () => {
    const writeFileSync = mock(() => {
      throw new Error('Unexpected FS error');
    });
    const fs = makeLockFs({
      existsSync: mock(() => false),
      writeFileSync,
    });

    await expect(withGlobalLock('fail-test', async () => 'no', 5000, fs)).rejects.toThrow(
      'Unexpected FS error',
    );
  });

  it('cleans up stale lock before acquiring', async () => {
    // 既存のロックが存在するが、プロセスは死んでいる（kill throws）→ cleanup
    const pid = 99999999; // 存在しないPID
    const fs = makeLockFs({
      existsSync: mock(() => true),
      readFileSync: mock(() => String(pid)),
      statSync: mock(() => ({ mtimeMs: Date.now() })),
    });

    const result = await withGlobalLock('stale-lock-test', async () => 'cleaned', 5000, fs);

    expect(result).toBe('cleaned');
    // cleanup で一度、release で一度 unlinkSync が呼ばれる
    expect(fs.unlinkSync).toHaveBeenCalled();
  });
});
