import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export type McpRetrieverOptions = {
  pythonPath: string;
  serverScriptPath: string;
  env?: Record<string, string>;
};

type McpTextContent = { type: 'text'; text: string };
type McpContent = McpTextContent | { type: string; [key: string]: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isMcpContent = (value: unknown): value is McpContent => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type !== 'text') {
    return true;
  }
  return typeof value.text === 'string';
};

const extractTextContent = (result: unknown): string => {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error(`Unexpected MCP tool result format: ${JSON.stringify(result)}`);
  }

  const contents = result.content.filter(isMcpContent);
  return contents
    .map((item) => (item.type === 'text' ? item.text : ''))
    .join('\n')
    .trim();
};

export class McpRetriever {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(private options: McpRetrieverOptions) {}

  async connect(): Promise<void> {
    if (this.client) return;

    const env: Record<string, string> = Object.fromEntries(
      Object.entries({
        ...process.env,
        ...this.options.env,
      }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );

    this.transport = new StdioClientTransport({
      command: this.options.pythonPath,
      args: [this.options.serverScriptPath],
      env,
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
    if (!this.client) {
      throw new Error('MCP client is not connected');
    }
    const result = await this.client.callTool({
      name: 'web_search',
      arguments: { query },
    });

    return extractTextContent(result);
  }

  async fetch(url: string): Promise<string> {
    if (!this.client) await this.connect();
    if (!this.client) {
      throw new Error('MCP client is not connected');
    }
    const result = await this.client.callTool({
      name: 'fetch_content',
      arguments: { url },
    });

    return extractTextContent(result);
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
