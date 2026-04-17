import type { ReviewMcpToolCaller } from '../mcp/caller.js';

export interface ReviewerToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for input parameters */
  inputSchema: Record<string, unknown>;
}

export interface ReviewerToolContext {
  repoPath: string; // validated repository root
  mcpCaller?: ReviewMcpToolCaller; // For Astmend/DiffGuard integration
  /** Gnosis knowledge session ID */
  gnosisSessionId: string;
  /** Optional web search function */
  webSearchFn?: (query: string, limit: number) => Promise<string[]>;
  /** Max agentic rounds */
  maxToolRounds?: number;
}

export type ReviewerToolHandler = (
  args: Record<string, unknown>,
  ctx: ReviewerToolContext,
) => Promise<string>;

export interface ReviewerToolEntry {
  definition: ReviewerToolDefinition;
  handler: ReviewerToolHandler;
}
