import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type TaskMessage =
  | { type: 'TASK_START'; pid: number; task: string; ppid: number }
  | { type: 'TASK_END'; pid: number }
  | { type: 'HEARTBEAT'; pid: number }
  | { type: 'GET_STATS' };

export type SupervisorResponse = {
  ok: boolean;
  message?: string;
};

// macOS/Linux 用のソケットパス。ユーザー権限でアクセス可能な場所に配置
export const SOCKET_PATH = join(
  tmpdir(),
  `gnosis-supervisor-${process.env.USER || 'default'}.sock`,
);
export const MESSAGE_DELIMITER = '\n';
