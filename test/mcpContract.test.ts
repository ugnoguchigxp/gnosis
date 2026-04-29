import { describe, expect, it } from 'bun:test';
import { server, shouldInjectAlwaysContext } from '../src/mcp/server';

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
    expect(toolNames).not.toContain('store_memory');
    expect(toolNames).not.toContain('search_unified');
    expect(toolNames).not.toContain('register_guidance');
    expect(toolNames).toContain('initial_instructions');
    expect(toolNames).toContain('activate_project');
    expect(toolNames).toContain('start_task');
    expect(toolNames).toContain('search_knowledge');
    expect(toolNames).toContain('record_task_note');
    expect(toolNames).toContain('finish_task');
    expect(toolNames).toContain('review_task');
    expect(toolNames).toContain('doctor');
    expect(toolNames.length).toBe(8);
  });

  it('returns isError=true for unknown tool and invalid arguments', async () => {
    const callHandler = getHandler('tools/call');

    const unknown = (await callHandler({
      method: 'tools/call',
      params: { name: 'unknown_tool_name', arguments: {} },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(unknown.isError).toBe(true);
    expect(unknown.content?.[0]?.text).toContain('Unknown tool');

    const hidden = (await callHandler({
      method: 'tools/call',
      params: { name: 'store_memory', arguments: { content: 'only-content' } },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(hidden.isError).toBe(true);
    expect(hidden.content?.[0]?.text).toContain('Unknown tool');

    const invalid = (await callHandler({
      method: 'tools/call',
      params: { name: 'start_task', arguments: {} },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(invalid.isError).toBe(true);
    expect(invalid.content?.[0]?.text).toContain('title');
  });

  it('does not inject always context into task-specific retrieval tools', () => {
    expect(shouldInjectAlwaysContext('initial_instructions')).toBe(true);
    expect(shouldInjectAlwaysContext('search_knowledge')).toBe(false);
    expect(shouldInjectAlwaysContext('review_task')).toBe(false);
    expect(shouldInjectAlwaysContext('activate_project')).toBe(true);
  });
});
