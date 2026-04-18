import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { withGlobalLock } from '../src/utils/lock';

// mock 化したい関数を個別に定義
const mockOpenSync = mock();
const mockCloseSync = mock();
const mockUnlinkSync = mock();
const mockExistsSync = mock(() => true);
const mockStatSync = mock(() => ({ mtimeMs: Date.now() }));

// node:fs をモック
mock.module('node:fs', () => ({
  openSync: mockOpenSync,
  closeSync: mockCloseSync,
  unlinkSync: mockUnlinkSync,
  existsSync: mockExistsSync,
  statSync: mockStatSync,
}));

// 待機時間をゼロにするために setTimeout だけモック（プロミス版）
mock.module('node:timers/promises', () => ({
  setTimeout: async () => {},
}));

describe('lock utility', () => {
  beforeEach(() => {
    mockOpenSync.mockReset();
    mockCloseSync.mockReset();
    mockUnlinkSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    mockOpenSync.mockReset();
    mockCloseSync.mockReset();
    mockUnlinkSync.mockReset();
    mockExistsSync.mockReset();
  });

  it('acquires and releases a lock successfully', async () => {
    mockOpenSync.mockReturnValue(123); // FD
    mockExistsSync.mockReturnValue(true); // cleanup verify 用

    const result = await withGlobalLock('test', async () => {
      return 'success';
    });

    expect(result).toBe('success');
    expect(mockOpenSync).toHaveBeenCalled();
    expect(mockCloseSync).toHaveBeenCalledWith(123);
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it('retries if lock already exists (EEXIST)', async () => {
    let calls = 0;
    mockOpenSync.mockImplementation(() => {
      if (calls === 0) {
        calls++;
        const err = new Error('EEXIST');
        Object.defineProperty(err, 'code', { value: 'EEXIST' });
        throw err;
      }
      return 124;
    });
    mockExistsSync.mockReturnValue(true);

    const result = await withGlobalLock('retry-test', async () => 'ok');

    expect(result).toBe('ok');
    expect(mockOpenSync).toHaveBeenCalledTimes(2);
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it('throws error if timeout is reached', async () => {
    mockOpenSync.mockImplementation(() => {
      const err = new Error('EEXIST');
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      (err as any).code = 'EEXIST';
      throw err;
    });
    mockExistsSync.mockReturnValue(false); // タイムアウト判定用

    // 非常に短いタイムアウトを設定
    await expect(withGlobalLock('timeout-test', async () => 'bad', 10)).rejects.toThrow(
      /Global lock timeout/,
    );
  });

  it('releases lock even if inner function fails', async () => {
    mockOpenSync.mockReturnValue(125);
    mockExistsSync.mockReturnValue(true);

    try {
      await withGlobalLock('error-test', async () => {
        throw new Error('inner failure');
      });
    } catch (e) {
      // ignore
    }

    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it('rethrows unexpected errors from openSync', async () => {
    mockOpenSync.mockImplementation(() => {
      throw new Error('Unexpected FS error');
    });

    await expect(withGlobalLock('fail-test', async () => 'no')).rejects.toThrow(
      'Unexpected FS error',
    );
  });
});
