import { GNOSIS_CONSTANTS } from '../../constants.js';
import { getReviewLLMService } from '../review/llm/reviewer.js';
import type {
  ChatMessage,
  LLMUsage,
  NativeToolCall,
  ReviewLLMService,
} from '../review/llm/types.js';
import { listAgenticSearchToolSpecs } from './toolRegistry.js';
import type { AgenticSearchMessage, AgenticToolCall } from './types.js';

export type AgenticSearchLlmResult = {
  text: string;
  toolCalls: AgenticToolCall[];
  usage?: LLMUsage;
  raw?: unknown;
};

export function resolveAgenticSearchLlmTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GNOSIS_AGENTIC_SEARCH_LLM_TIMEOUT_MS ?? env.GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  return GNOSIS_CONSTANTS.MCP_REVIEW_LLM_TIMEOUT_MS_DEFAULT;
}

function agenticSearchLlmLog(event: string, fields: Record<string, unknown> = {}): void {
  console.error(
    `[AgenticSearchLLM] ${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    })}`,
  );
}

function toChatMessages(messages: AgenticSearchMessage[]): ChatMessage[] {
  const converted: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      converted.push({
        role: 'tool',
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content,
      });
      continue;
    }
    if (message.role === 'assistant') {
      const syntheticRaw =
        message.raw ??
        (message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              })),
            }
          : undefined);
      converted.push({
        role: 'assistant',
        content: message.content,
        rawAssistantContent: syntheticRaw,
      });
      continue;
    }
    converted.push({ role: message.role, content: message.content });
  }
  return converted;
}

function convertToolCalls(calls?: NativeToolCall[]): AgenticToolCall[] {
  if (!calls) return [];
  return calls.map((call) => ({
    id: call.id,
    name: call.name as AgenticToolCall['name'],
    arguments: Object.fromEntries(
      Object.entries(call.arguments).map(([k, v]) => {
        try {
          return [k, JSON.parse(v)];
        } catch {
          return [k, v];
        }
      }),
    ),
  }));
}

function rawAssistantToolCallIds(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
      .filter((item) => item.type === 'tool_use')
      .map((item) => (typeof item.id === 'string' ? item.id : ''))
      .filter((id) => id.length > 0);
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [];
  }

  const toolCalls = (raw as Record<string, unknown>).tool_calls;
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .map((call) => {
      if (typeof call !== 'object' || call === null || Array.isArray(call)) return '';
      const id = (call as Record<string, unknown>).id;
      return typeof id === 'string' ? id : '';
    })
    .filter((id) => id.length > 0);
}

function validateToolMessageSequence(messages: AgenticSearchMessage[]): void {
  const pendingToolCallIds = new Set<string>();

  for (const message of messages) {
    if (pendingToolCallIds.size > 0) {
      if (message.role !== 'tool') {
        throw new Error(
          `invalid_agentic_tool_message_sequence: expected tool result for ${[
            ...pendingToolCallIds,
          ].join(', ')} before ${message.role} message`,
        );
      }
      if (!pendingToolCallIds.has(message.toolCallId)) {
        throw new Error(
          `invalid_agentic_tool_message_sequence: unexpected tool result ${message.toolCallId}`,
        );
      }
      pendingToolCallIds.delete(message.toolCallId);
      continue;
    }

    if (message.role === 'tool') {
      throw new Error(
        `invalid_agentic_tool_message_sequence: orphan tool result ${message.toolCallId}`,
      );
    }

    if (message.role === 'assistant') {
      const toolCallIds =
        message.toolCalls && message.toolCalls.length > 0
          ? message.toolCalls.map((call) => call.id)
          : rawAssistantToolCallIds(message.raw);
      for (const id of toolCallIds) {
        pendingToolCallIds.add(id);
      }
    }
  }

  if (pendingToolCallIds.size > 0) {
    throw new Error(
      `invalid_agentic_tool_message_sequence: missing tool result for ${[
        ...pendingToolCallIds,
      ].join(', ')}`,
    );
  }
}

export class AgenticSearchLlmAdapter {
  private llmServicePromise: Promise<ReviewLLMService> | null = null;

  constructor(private readonly timeoutMs = resolveAgenticSearchLlmTimeoutMs()) {}

  private async getLlmService(): Promise<ReviewLLMService> {
    if (!this.llmServicePromise) {
      this.llmServicePromise = getReviewLLMService(undefined, {
        invoker: 'service',
        timeoutMs: this.timeoutMs,
      }).then((service) => {
        agenticSearchLlmLog('service_resolved', {
          provider: service.provider,
          timeoutMs: this.timeoutMs,
        });
        return service;
      });
    }
    return this.llmServicePromise;
  }

  async generate(messages: AgenticSearchMessage[]): Promise<AgenticSearchLlmResult> {
    validateToolMessageSequence(messages);
    const llm = await this.getLlmService();
    if (!llm.generateMessagesStructured) {
      throw new Error('tool_calling_unsupported');
    }
    const tools = listAgenticSearchToolSpecs().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
    const result = await llm.generateMessagesStructured(toChatMessages(messages), { tools });
    return {
      text: result.text ?? '',
      toolCalls: convertToolCalls(result.toolCalls),
      usage: result.usage,
      raw: result.rawAssistantContent,
    };
  }
}
