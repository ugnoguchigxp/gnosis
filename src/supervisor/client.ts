import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import {
  MESSAGE_DELIMITER,
  SOCKET_PATH,
  type SupervisorResponse,
  type TaskMessage,
} from './protocol.js';

/**
 * Supervisor デーモンへメッセージを送信する軽量クライアント。
 * デーモンが動いていない場合は自動的にバックグラウンドで起動を試みます。
 */
async function sendMessage(message: TaskMessage, retry = true): Promise<SupervisorResponse> {
  return new Promise((resolve) => {
    const socket = connect(SOCKET_PATH);
    let buffer = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify(message) + MESSAGE_DELIMITER);
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const parts = buffer.split(MESSAGE_DELIMITER);
      if (parts.length > 1) {
        try {
          const response = JSON.parse(parts[0]) as SupervisorResponse;
          resolve(response);
        } catch {
          resolve({ ok: false, message: 'Invalid response' });
        }
        socket.destroy();
      }
    });

    socket.on('error', async (err) => {
      socket.destroy();
      const errorCode = (err as Error & { code?: string }).code;

      if (retry && errorCode === 'ENOENT') {
        // デーモンがいない場合は起動を試みる
        console.error('[SupervisorClient] Daemon not found. Attempting to auto-start...');
        try {
          const daemonPath = join(process.cwd(), 'src/supervisor/daemon.ts');

          // バックグラウンドで切り離して起動
          const child = spawn('bun', ['run', daemonPath], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, GNOSIS_SUPERVISOR_AUTO_KILL: 'true' },
          });
          child.unref();

          // 起動待ち (少し待ってから再試行)
          await new Promise((r) => setTimeout(r, 1000));
          resolve(await sendMessage(message, false));
        } catch (spawnErr) {
          resolve({ ok: false, message: `Auto-start failed: ${spawnErr}` });
        }
      } else {
        resolve({ ok: false, message: err.message });
      }
    });

    // タイムアウト設定 (デーモン応答待ちでプロセスを止めない)
    socket.setTimeout(500, () => {
      resolve({ ok: false, message: 'Timeout' });
      socket.destroy();
    });
  });
}

export async function notifyTaskStart(taskName: string): Promise<void> {
  const res = await sendMessage({
    type: 'TASK_START',
    pid: process.pid,
    ppid: process.ppid,
    task: taskName,
  });
  if (!res.ok) {
    console.error(`[SupervisorClient] Warning: Could not register task: ${res.message}`);
  }
}

export async function notifyTaskEnd(): Promise<void> {
  const res = await sendMessage({
    type: 'TASK_END',
    pid: process.pid,
  });
  if (!res.ok) {
    console.error(`[SupervisorClient] Warning: Could not unregister task: ${res.message}`);
  }
}

export async function sendHeartbeat(): Promise<void> {
  await sendMessage({
    type: 'HEARTBEAT',
    pid: process.pid,
  });
}
