import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { isGnosisError } from '../domain/errors.js';
import { toolEntries } from './tools/index.js';

export const server = new Server(
  {
    name: 'gnosis-memory-kg',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolEntries.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const entry = toolEntries.find((t) => t.name === name);
  if (!entry) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    return await entry.handler(args);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const code = isGnosisError(error) ? error.code : 'INTERNAL';
    return {
      content: [{ type: 'text', text: `[${code}] ${message}` }],
      isError: true,
    };
  }
});
