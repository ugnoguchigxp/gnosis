import { runStdioAdapter } from './mcp/stdioAdapter.js';

runStdioAdapter().catch((error) => {
  console.error('[McpAdapter] Fatal start error:', error);
  process.exit(1);
});
