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
      'search_knowledge',
      'activate_project',
      'start_task',
      'record_task_note',
      'finish_task',
      'review_task',
      'doctor',
    ];
    const hashes = Object.fromEntries(
      result.tools
        .filter((tool) => targetNames.includes(tool.name))
        .map((tool) => [tool.name, sha256(stableStringify(tool.inputSchema))]),
    );

    expect(hashes).toEqual({
      search_knowledge: 'e65ab099e3ed7f1e5b8bf6a4e966c5865ee99354952755baa33e6981f7a059e6',
      activate_project: 'ae3f5f02ed68d564e2aac89f8a542de81ecab9a42d765149a4fd5b07291e4033',
      start_task: '9b919c81d0d7b099ee0db5d4c4be2dbcb74a0ca800507dd0663c68382e4ac1cd',
      record_task_note: 'e5a78739ce1f82ed63dbc1db90adc0febc856d4c7184bfe4bd501a68db4b4b76',
      finish_task: '0237ef56da1e4e04d975522ca1e5d4f42d351bf0ebd1790efad302b3f9be5b86',
      review_task: 'd797c3c09be913d672c38cd9cbb9dee95d43437431696c681234842995ae00e3',
      doctor: '2c0394f3b8ad34fddbe4881a4db02aebcebdb4b3ab7931ca505cbc6c6b9dcc18',
    });
  });
});
