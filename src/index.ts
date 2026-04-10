import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { server } from './mcp/server.js';

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Gnosis VibeMemory & Knowledge Graph MCP Server is running over STDIO');
}

main().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
