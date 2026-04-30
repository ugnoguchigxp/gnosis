import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { server } from '../src/mcp/server';

type RequestHandler = (request: Record<string, unknown>) => Promise<Record<string, unknown>>;

const getHandler = (method: string): RequestHandler => {
  const handlers = (server as unknown as { _requestHandlers: Map<string, RequestHandler> })
    ._requestHandlers;
  const handler = handlers.get(method);
  if (!handler) throw new Error(`MCP handler not found: ${method}`);
  return handler;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('mcp tools snapshot', () => {
  it('keeps stable schema hashes for key tools', async () => {
    const listHandler = getHandler('tools/list');
    const result = (await listHandler({
      method: 'tools/list',
      params: {},
    })) as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    };

    const targetNames = [
      'initial_instructions',
      'agentic_search',
      'search_knowledge',
      'record_task_note',
      'review_task',
      'doctor',
    ];
    const hashes = Object.fromEntries(
      result.tools
        .filter((tool) => targetNames.includes(tool.name))
        .map((tool) => [tool.name, sha256(stableStringify(tool.inputSchema))]),
    );

    expect(hashes).toEqual({
      initial_instructions: 'f973399805c1c233633f5196cf8e2ad40ee100b94996d711dcd030813b671bc5',
      agentic_search: 'f277200b3235d2ed582e50d6134098cbd49de8b9e89a776751b6826d6b71f5f9',
      search_knowledge: 'e65ab099e3ed7f1e5b8bf6a4e966c5865ee99354952755baa33e6981f7a059e6',
      record_task_note: 'e5a78739ce1f82ed63dbc1db90adc0febc856d4c7184bfe4bd501a68db4b4b76',
      review_task: 'e39bbbe4bcabb7b512162f27e9c167e82f211c84b8630b50948796a8420d8d92',
      doctor: '2c0394f3b8ad34fddbe4881a4db02aebcebdb4b3ab7931ca505cbc6c6b9dcc18',
    });
  });
});
