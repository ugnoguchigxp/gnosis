import { type SpawnSyncOptionsWithStringEncoding, spawn, spawnSync } from 'node:child_process';
import { config } from '../../config.js';
import { withGlobalSemaphore } from '../../utils/lock.js';

export type LlmSpawnResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
  pid?: number;
};

// 実行中の子プロセスを追跡して、親プロセス終了時に確実に道連れにする
const activeProcesses = new Set<number>();

process.on('exit', () => {
  for (const pid of activeProcesses) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
});

/**
 * 集中管理されたLLMプロセス実行エンジン。
 * システム全体の同時実行数制限（GNOSIS_LLM_CONCURRENCY_LIMIT）を厳格に守ります。
 */
export async function runLlmProcess(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    cwd?: string;
    onStart?: (pid: number) => void;
  } = {},
): Promise<LlmSpawnResult> {
  const limit = config.llm.concurrencyLimit;

  return await withGlobalSemaphore('llm-pool', limit, async () => {
    return new Promise((resolve) => {
      console.error(
        `[LlmSpawn] Starting LLM process (limit=${limit}): ${command} ${args
          .slice(0, 3)
          .join(' ')}...`,
      );

      const child = spawn(command, args, {
        env: { ...process.env, ...options.env },
        timeout: options.timeout,
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (child.pid) {
        activeProcesses.add(child.pid);
        options.onStart?.(child.pid);
      }

      let stdout = '';
      let stderr = '';
      let error: Error | undefined;

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (err) => {
        error = err;
      });

      const timeoutMs = options.timeout ?? config.llm.defaultTimeoutMs;
      const timeoutTrigger = setTimeout(() => {
        child.kill('SIGKILL');
        error = new Error(`LLM Process timed out after ${timeoutMs}ms (PID: ${child.pid})`);
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timeoutTrigger);
        if (child.pid) activeProcesses.delete(child.pid);

        console.error(`[LlmSpawn] Process finished (PID: ${child.pid}, Status: ${code})`);
        resolve({
          stdout,
          stderr,
          status: code,
          error,
          pid: child.pid,
        });
      });
    });
  });
}

/**
 * 同期版の実行。セマフォスロットを確保してから spawnSync を実行します。
 */
export async function runLlmProcessSync(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
): Promise<LlmSpawnResult> {
  const limit = config.llm.concurrencyLimit;

  return await withGlobalSemaphore('llm-pool', limit, async () => {
    console.error(`[LlmSpawnSync] Starting LLM process (limit=${limit}): ${command}...`);
    try {
      const result = spawnSync(command, args, options);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
        error: result.error,
        pid: result.pid,
      };
    } catch (err) {
      return {
        stdout: '',
        stderr: '',
        status: 1,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  });
}
