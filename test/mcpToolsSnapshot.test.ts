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
      agentic_search: '1e0239515175b5776e895a6a6da6699b104e8481cbc04782e99b81416f489fb7',
      search_knowledge: '35792c61001cf98ee29ab4c34dcd491c6c1943b22b231f11a21a9c8626fafd9c',
      record_task_note: '9fe092606a6c15b455fd2eaf0aa83ff978a7088ad578159bb11cdc45bc84d1fd',
      review_task: '925194479c1be2a6c38edf47fa80c92f04e62b901317fe8bacff75018bfff032',
      doctor: '88e8588dd15d3a3a37e74a5f773ba67070df971090caa47384250ca512efc8e3',
    });
  });
});
