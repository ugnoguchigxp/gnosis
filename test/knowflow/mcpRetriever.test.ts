import { describe, expect, it } from 'bun:test';
import { McpRetriever } from '../../src/adapters/retriever/mcpRetriever';

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
});
