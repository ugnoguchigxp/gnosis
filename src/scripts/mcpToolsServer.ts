#!/usr/bin/env bun
/**
 * MCP Tools Server — stdio interface for external MCP clients.
 * Tool implementations live in webTools.ts.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RuntimeLifecycle } from '../runtime/lifecycle.js';
import { registerProcess } from '../runtime/processRegistry.js';
import { WEB_TOOL_DEFINITIONS } from './llmConversation.js';
import { fetchContent, searchWeb } from './webTools.js';

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

// Build MCP tool list from shared WEB_TOOL_DEFINITIONS, adding compatibility aliases
const TOOLS = [
  ...WEB_TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters as {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    },
  })),
  // Compatibility aliases
  {
    name: 'web_search',
    description: 'search_web の互換エイリアス。',
    inputSchema: {
      type: 'object' as const,
      properties: { query: { type: 'string', description: '検索クエリ' } },
      required: ['query'],
    },
  },
  {
    name: 'scrape_content',
    description: 'fetch_content の互換エイリアス。',
    inputSchema: {
      type: 'object' as const,
      properties: { url: { type: 'string', description: '取得対象のURL' } },
      required: ['url'],
    },
  },
];

const server = new Server(
  { name: 'gnosis-tools', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const record = (args ?? {}) as Record<string, string>;

  let text: string;
  switch (name) {
    case 'web_search':
    case 'search_web':
      text = await searchWeb(record.query ?? '');
      break;
    case 'fetch_content':
    case 'scrape_content':
      text = await fetchContent(record.url ?? '');
      break;
    default:
      text = `Error: Unknown tool '${name}'`;
  }
  return { content: [{ type: 'text', text }] };
});

// Only start the stdio server when run directly (not when imported)
if (import.meta.main) {
  process.title = 'gnosis-tools';
  const registration = registerProcess({ role: 'mcp-tools', title: process.title });
  const lifecycle = new RuntimeLifecycle({ name: 'McpToolsServer', registration });
  lifecycle.addCleanupStep(() => registration.unregister());
  lifecycle.bindProcessEvents();
  lifecycle.startParentWatch();

  const transport = new StdioServerTransport();

  lifecycle.markRunning();
  lifecycle.startHeartbeat();
  (transport as unknown as { onclose?: () => void }).onclose = () => {
    void lifecycle.requestShutdown('transport_close');
  };
  await server.connect(transport);
}
