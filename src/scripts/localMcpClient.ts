import type { ConversationToolClient } from './llmConversation.js';
/**
 * Direct tool client — calls searchWeb / fetchContent as plain async functions,
 * matching the gemma4 / bonsai Python implementation (no MCP stdio overhead).
 */
import { fetchContent, searchWeb } from './webTools.js';

const normalizeToolName = (name: string): string => {
  switch (name) {
    case 'web_search':
    case 'search_web':
      return 'search_web';
    case 'scrape_content':
    case 'fetch_url':
    case 'fetch_content':
      return 'fetch_content';
    default:
      return name;
  }
};

export class DirectToolClient implements ConversationToolClient {
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const normalized = normalizeToolName(name);
    switch (normalized) {
      case 'search_web':
        return searchWeb(String(args.query ?? ''));
      case 'fetch_content':
        return fetchContent(String(args.url ?? ''));
      default:
        return `Error: Unknown tool '${name}'`;
    }
  }

  async disconnect(): Promise<void> {
    // No-op — no subprocess to clean up
  }
}

export const createLocalMcpToolClient = (): DirectToolClient => new DirectToolClient();
