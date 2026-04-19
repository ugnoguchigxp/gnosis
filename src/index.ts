import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { server } from './mcp/server.js';
import { startBackgroundWorkers } from './services/background/manager.js';

// MCPプロトコル(STDIO)を破壊しないよう、すべての標準出力を標準エラーに強制リダイレクト
const redirectLogs = () => {
  const originalError = console.error;
  console.log = (...args: unknown[]) => originalError(...args);
  console.info = (...args: unknown[]) => originalError(...args);
  console.warn = (...args: unknown[]) => originalError(...args);
};

redirectLogs();

async function main() {
  // MCPプロトコル(STDIO)を破壊しないよう、console.log を console.error にリダイレクト
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };

  const transport = new StdioServerTransport();

  // MCPモードではバックグラウンドワーカーを無効化（リソース競合とログ汚染の防止）
  if (process.env.GNOSIS_NO_WORKERS !== 'true') {
    startBackgroundWorkers();
  }

  await server.connect(transport);
}

main().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
