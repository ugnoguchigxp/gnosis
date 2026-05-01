export type AgenticSearchToolName = 'knowledge_search' | 'brave_search' | 'fetch';

export type AgenticToolCall = {
  id: string;
  name: AgenticSearchToolName;
  arguments: Record<string, unknown>;
};

export type AgenticToolResult = {
  toolCallId: string;
  toolName: AgenticSearchToolName;
  ok: boolean;
  output?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
};

export type AgenticSearchMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AgenticToolCall[]; raw?: unknown }
  | { role: 'tool'; toolCallId: string; toolName: AgenticSearchToolName; content: string };

export type AgenticSearchTrace = {
  toolCalls: Array<{
    toolCallId: string;
    toolName: AgenticSearchToolName;
    arguments: Record<string, unknown>;
    ok: boolean;
    errorCode?: string;
  }>;
  loopCount: number;
};
