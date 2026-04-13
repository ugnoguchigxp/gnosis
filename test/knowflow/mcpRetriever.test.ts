import { describe, expect, it, mock } from 'bun:test';
import { McpRetriever, MockRetriever } from '../../src/adapters/retriever/mcpRetriever';

const createRetriever = (): McpRetriever =>
  new McpRetriever({
    pythonPath: 'python3',
    serverScriptPath: 'tools_server.py',
  });

const setMockToolResult = (retriever: McpRetriever, result: unknown) => {
  (retriever as unknown as { client: { callTool: (input: unknown) => Promise<unknown> } }).client =
    {
      callTool: async () => result,
    };
};

describe('mcp retriever', () => {
  it('extracts text content from MCP tool response', async () => {
    const retriever = createRetriever();
    setMockToolResult(retriever, {
      content: [
        { type: 'text', text: 'first line' },
        { type: 'text', text: 'second line' },
      ],
    });

    await expect(retriever.search('test query')).resolves.toBe('first line\nsecond line');
  });

  it('throws when MCP tool marks response as error', async () => {
    const retriever = createRetriever();
    setMockToolResult(retriever, {
      content: [{ type: 'text', text: 'search failed' }],
      isError: true,
    });

    await expect(retriever.search('test query')).rejects.toThrow(
      'MCP tool returned an error: search failed',
    );
  });

  it('throws for unexpected MCP response shape', async () => {
    const retriever = createRetriever();
    setMockToolResult(retriever, {
      invalid: true,
    });

    await expect(retriever.fetch('https://example.com')).rejects.toThrow(
      'Unexpected MCP tool result format',
    );
  });

  it('throws when isError is true with no message', async () => {
    const retriever = createRetriever();
    setMockToolResult(retriever, {
      content: [],
      isError: true,
    });

    await expect(retriever.search('query')).rejects.toThrow('MCP tool returned an error');
  });

  it('disconnect closes transport and resets client', async () => {
    const retriever = createRetriever();
    const mockClose = mock().mockResolvedValue(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: mock
    (retriever as any).transport = { close: mockClose };
    // biome-ignore lint/suspicious/noExplicitAny: mock
    (retriever as any).client = {};

    await retriever.disconnect();

    expect(mockClose).toHaveBeenCalled();
    // biome-ignore lint/suspicious/noExplicitAny: mock
    expect((retriever as any).transport).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: mock
    expect((retriever as any).client).toBeNull();
  });
});

describe('MockRetriever', () => {
  it('search returns mock result', async () => {
    const retriever = new MockRetriever();
    const result = await retriever.search('TypeScript');
    expect(result).toContain('TypeScript');
    expect(result).toContain('Mock');
  });

  it('fetch returns mock content', async () => {
    const retriever = new MockRetriever();
    const result = await retriever.fetch('https://example.com');
    expect(result).toContain('example.com');
    expect(result).toContain('Mock');
  });
});
