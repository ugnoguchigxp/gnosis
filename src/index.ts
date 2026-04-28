import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeDbPool } from './db/index.js';
import { server } from './mcp/server.js';
import { RuntimeLifecycle } from './runtime/lifecycle.js';
import { registerProcess } from './runtime/processRegistry.js';
import { startBackgroundWorkers, stopBackgroundWorkers } from './services/background/manager.js';
import { notifyTaskEnd, notifyTaskStart } from './supervisor/client.js';

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
        console.error(
          `[Main] Info: Another instance (PID: ${pid}) is already running. Multiple instances allowed.`,
        );
        // 複数IDE等での同時利用を許容するため、終了せず続行する
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
      const pidInFile = Number.parseInt(readFileSync(PID_FILE, 'utf8'), 10);
      if (pidInFile === process.pid) {
        unlinkSync(PID_FILE);
      }
    }
  } catch (e) {
    // 終了処理中のエラーはstderrに流すのみ
  }
};

// --- メイン処理 ---
async function main() {
  // 標準出力を標準エラーにリダイレクト
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };

  acquireLock();

  const registration = registerProcess({ role: 'mcp-server', title: process.title });
  const lifecycle = new RuntimeLifecycle({
    name: 'Main',
    registration,
  });
  lifecycle.addCleanupStep(async () => {
    await notifyTaskEnd().catch(() => {});
    stopBackgroundWorkers();
  });
  lifecycle.addCleanupStep(async () => {
    await closeDbPool().catch((e) => console.error(`[Main] Error closing DB pool: ${e}`));
  });
  lifecycle.addCleanupStep(() => {
    registration.unregister();
    releaseLock();
  });
  lifecycle.bindProcessEvents();
  lifecycle.startParentWatch();

  const transport = new StdioServerTransport();

  // 実装中の暴発を避けるため、明示的に有効化した場合のみ起動する。
  const automationEnabled = process.env.GNOSIS_ENABLE_AUTOMATION === 'true';
  if (automationEnabled && process.env.GNOSIS_NO_WORKERS !== 'true') {
    startBackgroundWorkers();
  } else {
    console.error(
      '[Main] Background workers are OFF (set GNOSIS_ENABLE_AUTOMATION=true to enable).',
    );
  }

  // Supervisor にタスク開始を通知
  await notifyTaskStart(process.title).catch(() => {});

  try {
    lifecycle.markRunning();
    lifecycle.startHeartbeat();
    (transport as unknown as { onclose?: () => void }).onclose = () => {
      void lifecycle.requestShutdown('transport_close');
    };
    await server.connect(transport);
  } catch (error) {
    console.error('[Main] Server connection error:', error);
    await lifecycle.requestShutdown('server_connect_error');
  }
}

main().catch(async (error) => {
  console.error('[Main] Fatal start error:', error);
  const lifecycle = new RuntimeLifecycle({ name: 'MainFatal' });
  await lifecycle.requestShutdown('fatal_start_error');
});
