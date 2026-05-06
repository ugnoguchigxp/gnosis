import { mkdirSync } from 'node:fs';
import { Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { GNOSIS_CONSTANTS } from '../constants.js';
import type {
  FailureFirewallContext,
  FailureFirewallLearningCandidatesOutput,
  FailureFirewallOutput,
  FailureKnowledgeSourceMode,
} from '../services/failureFirewall/types.js';

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

export type McpHostCallOptions = {
  signal?: AbortSignal;
};

export type McpHostService = {
  name: string;
  version: string;
  listTools: () => McpHostTool[];
  callTool: (
    name: string,
    args: unknown,
    options?: McpHostCallOptions,
  ) => Promise<McpHostToolResult>;
};

export type McpHostServiceInfo = {
  name: string;
  version: string;
};

export type FailureFirewallRunHostInput = {
  repoPath?: string;
  rawDiff?: string;
  mode?: 'fast' | 'with_llm';
  diffMode?: 'git_diff' | 'worktree';
  knowledgeSource?: FailureKnowledgeSourceMode;
};

export type LookupFailureFirewallContextHostInput = {
  repoPath?: string;
  rawDiff?: string;
  taskGoal?: string;
  files?: string[];
  changeTypes?: string[];
  technologies?: string[];
  maxGoldenPaths?: number;
  maxFailurePatterns?: number;
  maxLessonCandidates?: number;
  knowledgeSource?: FailureKnowledgeSourceMode;
};

export type SuggestFailureFirewallLearningCandidatesHostInput = {
  repoPath?: string;
  rawDiff: string;
  verifyCommand: string;
  verifyPassed: boolean;
  commitApprovedByUser: boolean;
  reviewFindings?: Array<{
    title: string;
    severity: string;
    accepted?: boolean;
    filePath?: string;
    evidence?: string;
  }>;
  knowledgeSource?: FailureKnowledgeSourceMode;
};

export type FailureFirewallHostRequestInput =
  | { type: 'failure_firewall/context'; input: LookupFailureFirewallContextHostInput }
  | { type: 'failure_firewall/run'; input: FailureFirewallRunHostInput }
  | {
      type: 'failure_firewall/suggest_learning_candidates';
      input: SuggestFailureFirewallLearningCandidatesHostInput;
    };

export type FailureFirewallHostResponse =
  | FailureFirewallContext
  | FailureFirewallOutput
  | FailureFirewallLearningCandidatesOutput;

export type McpHostRequest =
  | { id: string; type: 'listTools' }
  | { id: string; type: 'callTool'; name: string; arguments: unknown }
  | { id: string; type: 'health' }
  | { id: string; type: 'shutdown' }
  | ({ id: string } & FailureFirewallHostRequestInput);

export type McpHostRequestInput =
  | { type: 'listTools' }
  | { type: 'callTool'; name: string; arguments: unknown }
  | { type: 'health' }
  | { type: 'shutdown' }
  | FailureFirewallHostRequestInput;

export type McpHostHealth = {
  pid: number;
  uptimeMs: number;
  socketPath: string;
  services: string[];
  serviceVersions?: McpHostServiceInfo[];
  sourceFingerprint?: string;
  cwd?: string;
  argv?: string[];
  backgroundWorkers: 'enabled' | 'disabled';
  activeConnections?: number;
  totalConnections?: number;
  maxConnections?: number;
  activeRequests?: number;
  timedOutRequests?: number;
  socketIdleTimeoutMs?: number;
  requestTimeoutMs?: number;
};

export type McpHostResponse =
  | {
      id: string;
      ok: true;
      result:
        | { tools: McpHostTool[] }
        | McpHostToolResult
        | McpHostHealth
        | FailureFirewallHostResponse
        | null;
    }
  | { id: string; ok: false; error: string };

export function getMcpHostSocketPath(rootDir = process.cwd()): string {
  if (process.env.GNOSIS_MCP_HOST_SOCKET_PATH) return process.env.GNOSIS_MCP_HOST_SOCKET_PATH;
  return join(resolve(rootDir), '.gnosis', 'mcp-host.sock');
}

export function getMcpHostLockPath(rootDir = process.cwd()): string {
  if (process.env.GNOSIS_MCP_HOST_LOCK_PATH) return process.env.GNOSIS_MCP_HOST_LOCK_PATH;
  if (process.env.GNOSIS_MCP_HOST_SOCKET_PATH) {
    return `${process.env.GNOSIS_MCP_HOST_SOCKET_PATH}.lock`;
  }
  return join(resolve(rootDir), '.gnosis', 'mcp-host.lock');
}

export function ensureMcpHostSocketDir(rootDir = process.cwd()): void {
  mkdirSync(join(resolve(rootDir), '.gnosis'), { recursive: true });
  if (process.env.GNOSIS_MCP_HOST_SOCKET_PATH) {
    mkdirSync(resolve(process.env.GNOSIS_MCP_HOST_SOCKET_PATH, '..'), { recursive: true });
  }
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
  const timeoutMs = options.timeoutMs ?? GNOSIS_CONSTANTS.MCP_HOST_REQUEST_TIMEOUT_MS_DEFAULT;
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

    socket.on('close', () => {
      settle(() => rejectPromise(new Error('MCP host connection closed before response')));
    });

    socket.setTimeout(timeoutMs, () => {
      settle(() => rejectPromise(new Error(`MCP host request timed out after ${timeoutMs}ms`)));
    });

    socket.connect(socketPath);
  });
}
