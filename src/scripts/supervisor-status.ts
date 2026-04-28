import { connect } from 'node:net';
import { MESSAGE_DELIMITER, SOCKET_PATH, type SupervisorResponse } from '../supervisor/protocol.js';

type SupervisorTaskStats = {
  activeCount: number;
  tasks: Array<{
    pid: number;
    task: string;
    status: string;
    startedAt: number;
  }>;
};

const socket = connect(SOCKET_PATH);
let buffer = '';

socket.on('connect', () => {
  socket.write(JSON.stringify({ type: 'GET_STATS' }) + MESSAGE_DELIMITER);
});

socket.on('data', (data) => {
  buffer += data.toString();
  const parts = buffer.split(MESSAGE_DELIMITER);
  if (parts.length > 1) {
    try {
      const response = JSON.parse(parts[0]) as SupervisorResponse & { stats?: SupervisorTaskStats };
      if (response.ok && response.stats) {
        console.log('\n--- Gnosis Supervisor Status ---');
        console.log(`Active Tasks: ${response.stats.activeCount}`);
        console.table(
          response.stats.tasks.map((t) => ({
            PID: t.pid,
            Task: t.task,
            Status: t.status,
            Age: `${Math.floor((Date.now() - t.startedAt) / 1000)}s`,
          })),
        );
      } else {
        console.error('Failed to get stats from Supervisor.');
      }
    } catch (e) {
      console.error('Parse error:', e);
    }
    socket.destroy();
  }
});

socket.on('error', (_err) => {
  console.error('Supervisor is NOT running.');
  process.exit(1);
});
