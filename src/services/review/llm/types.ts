export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Tool definition passed to cloud LLM APIs for native tool calling. */
export type LLMToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** A native tool call parsed from the LLM response. */
export type NativeToolCall = {
  id: string;
  name: string;
  arguments: Record<string, string>;
};

export type LLMUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

/** Result from generateMessages — text and optional native tool calls. */
export type LLMGenerateResult = {
  text: string;
  toolCalls?: NativeToolCall[];
  /** Raw response for re-injection into history (e.g. Anthropic content blocks). */
  rawAssistantContent?: unknown;
  usage?: LLMUsage;
};

export interface ReviewLLMService {
  generate(prompt: string, options?: { format?: 'json' | 'text' }): Promise<string>;
  generateMessages?(
    messages: ChatMessage[],
    options?: { format?: 'json' | 'text'; tools?: LLMToolDefinition[] },
  ): Promise<string>;
  /** Like generateMessages but returns structured result with native tool calls. */
  generateMessagesStructured?(
    messages: ChatMessage[],
    options?: { format?: 'json' | 'text'; tools?: LLMToolDefinition[] },
  ): Promise<LLMGenerateResult>;
  readonly provider: 'local' | 'cloud';
}

/** Named LLM aliases for code review */
export type ReviewerAlias = 'gemma4' | 'qwen' | 'bonsai' | 'bedrock' | 'openai' | 'azure-openai';

export type ReviewLLMPreference = 'local' | 'cloud' | 'openai' | 'bedrock' | 'azure-openai';
