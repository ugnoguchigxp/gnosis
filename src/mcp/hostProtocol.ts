import { mkdirSync } from 'node:fs';
import { Socket } from 'node:net';
import { join, resolve } from 'node:path';

export const MCP_HOST_MESSAGE_DELIMITER = '\n';

export type McpHostTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type McpHostToolResult = {
  [key: string]: unknown;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type McpHostService = {
  name: string;
  version: string;
  listTools: () => McpHostTool[];
  callTool: (name: string, args: unknown) => Promise<McpHostToolResult>;
};

export type McpHostRequest =
  | { id: string; type: 'listTools' }
  | { id: string; type: 'callTool'; name: string; arguments: unknown }
  | { id: string; type: 'health' }
  | { id: string; type: 'shutdown' };

export type McpHostRequestInput =
  | { type: 'listTools' }
  | { type: 'callTool'; name: string; arguments: unknown }
  | { type: 'health' }
  | { type: 'shutdown' };

export type McpHostHealth = {
  pid: number;
  uptimeMs: number;
  socketPath: string;
  services: string[];
  backgroundWorkers: 'enabled' | 'disabled';
};

export type McpHostResponse =
  | {
      id: string;
      ok: true;
      result: { tools: McpHostTool[] } | McpHostToolResult | McpHostHealth | null;
    }
  | { id: string; ok: false; error: string };

export function getMcpHostSocketPath(rootDir = process.cwd()): string {
  return join(resolve(rootDir), '.gnosis', 'mcp-host.sock');
}

export function ensureMcpHostSocketDir(rootDir = process.cwd()): void {
  mkdirSync(join(resolve(rootDir), '.gnosis'), { recursive: true });
}

let requestSeq = 0;

export function nextMcpHostRequestId(): string {
  requestSeq += 1;
  return `${process.pid}-${Date.now()}-${requestSeq}`;
}

export function sendMcpHostRequest<T>(
  request: McpHostRequestInput,
  options: {
    rootDir?: string;
    socketPath?: string;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const socketPath = options.socketPath ?? getMcpHostSocketPath(options.rootDir);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const id = nextMcpHostRequestId();
  const payload = { ...request, id } as McpHostRequest;

  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new Socket();
    let buffer = '';
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}${MCP_HOST_MESSAGE_DELIMITER}`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split(MCP_HOST_MESSAGE_DELIMITER);
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        if (!part.trim()) continue;
        let response: McpHostResponse;
        try {
          response = JSON.parse(part) as McpHostResponse;
        } catch (error) {
          settle(() => rejectPromise(error));
          return;
        }
        if (response.id !== id) continue;
        if (response.ok) {
          settle(() => resolvePromise(response.result as T));
        } else {
          settle(() => rejectPromise(new Error(response.error)));
        }
        return;
      }
    });

    socket.on('error', (error) => {
      settle(() => rejectPromise(error));
    });

    socket.setTimeout(timeoutMs, () => {
      settle(() => rejectPromise(new Error(`MCP host request timed out after ${timeoutMs}ms`)));
    });

    socket.connect(socketPath);
  });
}
