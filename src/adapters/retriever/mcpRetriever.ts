import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from '../../config.js';

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

type McpToolResult = {
  content: McpContent[];
  isError?: boolean;
};

const toText = (contents: McpContent[]): string =>
  contents
    .map((item) => (item.type === 'text' ? item.text : ''))
    .join('\n')
    .trim();

const extractTextContent = (result: unknown): string => {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error(`Unexpected MCP tool result format: ${JSON.stringify(result)}`);
  }

  const toolResult = result as McpToolResult;
  const contents = toolResult.content.filter(isMcpContent);
  const text = toText(contents);

  if (toolResult.isError) {
    if (text) {
      throw new Error(`MCP tool returned an error: ${text}`);
    }
    throw new Error('MCP tool returned an error');
  }

  return text;
};

export interface Retriever {
  search(query: string, signal?: AbortSignal): Promise<string>;
  fetch(url: string, signal?: AbortSignal): Promise<string>;
}

export class MockRetriever implements Retriever {
  async search(query: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('Aborted');
    return `Mock search result for: ${query}. (Mock mode active)`;
  }
  async fetch(url: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('Aborted');
    return `Mock content for URL: ${url}. (Mock mode active)`;
  }
}

export class McpRetriever implements Retriever {
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

    const logPath = resolve(process.cwd(), 'services/local-llm/mcp_tools.log');
    this.transport = new StdioClientTransport({
      command: 'bash',
      args: [
        '-c',
        `"${this.options.pythonPath}" "${this.options.serverScriptPath}" 2>> "${logPath}"`,
      ],
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

  async search(query: string, signal?: AbortSignal): Promise<string> {
    if (!this.client) await this.connect();
    if (!this.client) {
      throw new Error('MCP client is not connected');
    }
    const result = await this.client.callTool(
      {
        name: 'web_search',
        arguments: { query },
      },
      undefined,
      { signal },
    );

    return extractTextContent(result);
  }

  async fetch(url: string, signal?: AbortSignal): Promise<string> {
    if (!this.client) await this.connect();
    if (!this.client) {
      throw new Error('MCP client is not connected');
    }
    const result = await this.client.callTool(
      {
        name: 'fetch_content',
        arguments: { url },
      },
      undefined,
      { signal },
    );

    return extractTextContent(result);
  }
}

/**
 * 本プロジェクトの Bun 版 MCP サーバーを起動するためのヘルパー
 */
export const createLocalLlmRetriever = (baseDir: string): Retriever => {
  if (config.mockRetriever) {
    return new MockRetriever();
  }

  // NOTE: Python 版 (services/local-llm/mcp/tools_server.py) は廃止されました。
  // 新しい Bun 版 (src/scripts/mcpToolsServer.ts) を使用します。
  const command = process.execPath;
  const serverScriptPath = resolve(process.cwd(), 'src/scripts/mcpToolsServer.ts');

  return new McpRetriever({
    pythonPath: command, // フィールド名は便宜上 pythonPath のまま
    serverScriptPath,
  });
};
