import { existsSync, unlinkSync } from 'node:fs';
import { type Socket, createServer } from 'node:net';
import { MESSAGE_DELIMITER, SOCKET_PATH, type TaskMessage } from './protocol.js';
import { TaskManager } from './taskManager.js';

const taskManager = new TaskManager();

const server = createServer((socket: Socket) => {
  let buffer = '';

  socket.on('data', async (data) => {
    buffer += data.toString();
    const parts = buffer.split(MESSAGE_DELIMITER);
    buffer = parts.pop() || ''; // 最後の未完成な部分はバッファに残す

    for (const part of parts) {
      if (!part.trim()) continue;
      try {
        const message = JSON.parse(part) as TaskMessage;

        switch (message.type) {
          case 'TASK_START':
            taskManager.register(message.pid, message.ppid, message.task);
            socket.write(JSON.stringify({ ok: true }) + MESSAGE_DELIMITER);
            break;
          case 'TASK_END':
            await taskManager.unregister(message.pid);
            socket.write(JSON.stringify({ ok: true }) + MESSAGE_DELIMITER);
            break;
          case 'HEARTBEAT':
            socket.write(JSON.stringify({ ok: true }) + MESSAGE_DELIMITER);
            break;
          case 'GET_STATS':
            socket.write(
              JSON.stringify({ ok: true, stats: taskManager.getStats() }) + MESSAGE_DELIMITER,
            );
            break;
        }
      } catch (error) {
        console.error('[Supervisor] Protocol Error:', error, 'Raw:', part);
        socket.write(JSON.stringify({ ok: false, error: 'Invalid protocol' }) + MESSAGE_DELIMITER);
      }
    }
  });

  socket.on('error', (_err) => {
    // クライアント切断などは通常ここに来る
  });
});

// 前回のソケットファイルが残っていれば削除
if (existsSync(SOCKET_PATH)) {
  try {
    unlinkSync(SOCKET_PATH);
  } catch (e) {
    console.error(`[Supervisor] Could not remove stale socket: ${SOCKET_PATH}`);
    process.exit(1);
  }
}

server.listen(SOCKET_PATH, () => {
  console.log('--- Gnosis Supervisor Daemon Started ---');
  console.log(`Socket: ${SOCKET_PATH}`);
  console.log(`PID: ${process.pid}`);

  // 定期的な孤児プロセスの回収
  setInterval(() => {
    taskManager.reapOrphans();
  }, 5000).unref();
});

// プロセス終了時の後処理
const shutdown = () => {
  console.log('[Supervisor] Shutting down...');
  if (existsSync(SOCKET_PATH)) {
    unlinkSync(SOCKET_PATH);
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 自身が二重起動しないよう、あるいは異常終了を検知できるよう、タイトルの設定
process.title = 'gnosis-supervisor';
