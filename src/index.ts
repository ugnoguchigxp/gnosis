import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { server } from './mcp/server.js';
import { startBackgroundWorkers } from './services/background/manager.js';

// MCPプロトコル(STDIO)を破壊しないよう、すべての console.log を console.error に強制リダイレクト
console.log = (...args: unknown[]) => {
  console.error(...args);
};

async function main() {
  // MCPプロトコル(STDIO)を破壊しないよう、console.log を console.error にリダイレクト
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };

  const transport = new StdioServerTransport();

  // バックグラウンドワーカーの開始
  startBackgroundWorkers();

  await server.connect(transport);
  console.error('Gnosis VibeMemory & Knowledge Graph MCP Server is running over STDIO');
}

main().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
