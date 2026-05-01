import { getReviewLLMService } from '../review/llm/reviewer.js';
import type { ChatMessage, LLMUsage, NativeToolCall, ReviewLLMService } from '../review/llm/types.js';
import type { AgenticSearchMessage, AgenticToolCall } from './types.js';
import { listAgenticSearchToolSpecs } from './toolRegistry.js';

export type AgenticSearchLlmResult = {
  text: string;
  toolCalls: AgenticToolCall[];
  usage?: LLMUsage;
  raw?: unknown;
};

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
      converted.push({
        role: 'assistant',
        content: message.content,
        rawAssistantContent: message.raw,
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

export class AgenticSearchLlmAdapter {
  private llmServicePromise: Promise<ReviewLLMService> | null = null;

  private async getLlmService(): Promise<ReviewLLMService> {
    if (!this.llmServicePromise) {
      this.llmServicePromise = getReviewLLMService(undefined, { invoker: 'service' });
    }
    return this.llmServicePromise;
  }

  async generate(messages: AgenticSearchMessage[]): Promise<AgenticSearchLlmResult> {
    const llm = await this.getLlmService();
    if (llm.provider !== 'cloud' || !llm.generateMessagesStructured) {
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
