import { describe, expect, it } from 'bun:test';
import { server } from '../src/mcp/server';

type RequestHandler = (request: Record<string, unknown>) => Promise<Record<string, unknown>>;

const getHandler = (method: string): RequestHandler => {
  const handlers = (server as unknown as { _requestHandlers: Map<string, RequestHandler> })
    ._requestHandlers;
  const handler = handlers.get(method);
  if (!handler) {
    throw new Error(`MCP handler not found: ${method}`);
  }
  return handler;
};

describe('mcp contract', () => {
  it('exposes expected tool contracts via tools/list', async () => {
    const listHandler = getHandler('tools/list');
    const result = (await listHandler({
      method: 'tools/list',
      params: {},
    })) as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    };

    const toolNames = result.tools.map((tool) => tool.name);
    expect(toolNames).toContain('store_memory');
    expect(toolNames).toContain('search_unified');
    expect(toolNames).toContain('register_guidance');

    const searchUnified = result.tools.find((tool) => tool.name === 'search_unified');
    expect(searchUnified).toBeDefined();
    const modeEnum = (searchUnified?.inputSchema as { properties?: Record<string, unknown> })
      .properties as Record<string, { enum?: unknown[] }> | undefined;
    expect(modeEnum?.mode?.enum).toEqual(['fts', 'kg', 'semantic']);

    const storeMemory = result.tools.find((tool) => tool.name === 'store_memory');
    expect(storeMemory).toBeDefined();
    const required = (storeMemory?.inputSchema as { required?: string[] }).required ?? [];
    expect(required).toContain('sessionId');
    expect(required).toContain('content');
  });

  it('returns isError=true for unknown tool and invalid arguments', async () => {
    const callHandler = getHandler('tools/call');

    const unknown = (await callHandler({
      method: 'tools/call',
      params: { name: 'unknown_tool_name', arguments: {} },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(unknown.isError).toBe(true);
    expect(unknown.content?.[0]?.text).toContain('Unknown tool');

    const invalid = (await callHandler({
      method: 'tools/call',
      params: { name: 'store_memory', arguments: { content: 'only-content' } },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(invalid.isError).toBe(true);
    expect(invalid.content?.[0]?.text).toContain('sessionId');
  });
});
