import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeDbPool } from './db/index.js';
import { server } from './mcp/server.js';
import { startBackgroundWorkers, stopBackgroundWorkers } from './services/background/manager.js';

// Set process title for easier identification
process.title = 'gnosis-mcp-server';

// Add diagnostic info to environment
process.env.GNOSIS_PROCESS_INFO = `Started:${new Date().toISOString()} | PPID:${
  process.ppid
} | CMD:${process.argv.join(' ')}`;

// --- ロギング設定 ---
// MCPプロトコル(STDIO)を破壊しないよう、すべての標準出力を標準エラーに強制リダイレクト
const redirectLogs = () => {
  const originalError = console.error;
  console.log = (...args: unknown[]) => originalError(...args);
  console.info = (...args: unknown[]) => originalError(...args);
  console.warn = (...args: unknown[]) => originalError(...args);
};
redirectLogs();

// --- PIDファイル管理 ---
const PID_FILE = join(process.cwd(), '.gnosis.pid');

const acquireLock = () => {
  if (existsSync(PID_FILE)) {
    try {
      const pid = Number.parseInt(readFileSync(PID_FILE, 'utf8'), 10);
      if (!Number.isNaN(pid)) {
        // プロセスが実際に存在するかチェック (kill 0 はシグナルを送らず存在確認のみ行う)
        process.kill(pid, 0);
        console.error(`[Main] Error: Another instance (PID: ${pid}) is already running.`);
        process.exit(1);
      }
    } catch (e) {
      // kill 0 が失敗した場合はプロセスが存在しないため、古いPIDファイルを無視して続行
      console.error('[Main] Warning: Found stale PID file. Overwriting...');
    }
  }
  writeFileSync(PID_FILE, process.pid.toString(), 'utf8');
};

const releaseLock = () => {
  try {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
  } catch (e) {
    // 終了処理中のエラーはstderrに流すのみ
  }
};

// --- クリーンアップ集約関数 ---
let isShuttingDown = false;
const cleanup = async (reason: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.error(`[Main] Shutdown initiated (Reason: ${reason}, PID: ${process.pid})...`);

  // Watchdog: Force exit if cleanup takes too long (10s)
  setTimeout(() => {
    console.error(`[Main] Shutdown timed out! Forcing exit. (PID: ${process.pid})`);
    process.exit(1);
  }, 10000).unref();

  stopBackgroundWorkers();
  await closeDbPool().catch((e) => console.error(`[Main] Error closing DB pool: ${e}`));
  releaseLock();
  console.error(`[Main] Shutdown complete (PID: ${process.pid}).`);
  process.exit(0);
};

// --- メイン処理 ---
async function main() {
  // 標準出力を標準エラーにリダイレクト
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };

  acquireLock();

  // シグナル・例外ハンドリングの登録
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));

  process.on('uncaughtException', (err) => {
    console.error('[Main] Uncaught Exception:', err);
    cleanup('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[Main] Unhandled Rejection:', reason);
    cleanup('unhandledRejection');
  });

  const transport = new StdioServerTransport();

  // MCPモードではバックグラウンドワーカーを無効化（リソース競合とログ汚染の防止）
  if (process.env.GNOSIS_NO_WORKERS !== 'true') {
    startBackgroundWorkers();
  }

  try {
    await server.connect(transport);
    await cleanup('Connection closed');
  } catch (error) {
    console.error('[Main] Server connection error:', error);
    await cleanup('Error');
  }
}

main().catch(async (error) => {
  console.error('[Main] Fatal start error:', error);
  await cleanup('Fatal');
});
