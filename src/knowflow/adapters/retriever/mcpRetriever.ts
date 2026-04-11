import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export type McpRetrieverOptions = {
  pythonPath: string;
  serverScriptPath: string;
  env?: Record<string, string>;
};

interface McpContent {
  type: string;
  text: string;
}

interface McpToolResult {
  content: McpContent[];
}

export class McpRetriever {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(private options: McpRetrieverOptions) {}

  async connect(): Promise<void> {
    if (this.client) return;

    this.transport = new StdioClientTransport({
      command: this.options.pythonPath,
      args: [this.options.serverScriptPath],
      env: {
        ...process.env,
        ...this.options.env,
      } as Record<string, string>,
    });

    this.client = new Client(
      { name: 'knowflow-retriever', version: '1.0.0' },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
      this.client = null;
    }
  }

  async search(query: string): Promise<string> {
    if (!this.client) await this.connect();
    // biome-ignore lint/suspicious/noExplicitAny: callTool returns generic result that needs casting for access
    const result = (await this.client?.callTool({
      name: 'web_search',
      arguments: { query },
    })) as unknown as McpToolResult;

    if (!result.content || !Array.isArray(result.content)) {
      throw new Error(`Unexpected search result format: ${JSON.stringify(result)}`);
    }

    return result.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n')
      .trim();
  }

  async fetch(url: string): Promise<string> {
    if (!this.client) await this.connect();
    // biome-ignore lint/suspicious/noExplicitAny: callTool returns generic result that needs casting for access
    const result = (await this.client?.callTool({
      name: 'fetch_content',
      arguments: { url },
    })) as unknown as McpToolResult;

    if (!result.content || !Array.isArray(result.content)) {
      throw new Error(`Unexpected fetch result format: ${JSON.stringify(result)}`);
    }

    return result.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n')
      .trim();
  }
}

/**
 * localLlmのMCPサーバーを起動するためのヘルパー
 */
export const createLocalLlmRetriever = (baseDir: string): McpRetriever => {
  const pythonPath = resolve(baseDir, '.venv/bin/python');
  const serverScriptPath = resolve(baseDir, 'mcp/tools_server.py');
  return new McpRetriever({
    pythonPath,
    serverScriptPath,
  });
};
