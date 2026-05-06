import type {
  ChatMessage,
  LLMGenerateResult,
  LLMToolDefinition,
} from '../services/review/llm/types.js';

export type ConversationLLM = {
  generate(prompt: string, options?: { format?: 'json' | 'text' }): Promise<string>;
  generateMessages?: (
    messages: ChatMessage[],
    options?: { format?: 'json' | 'text'; tools?: LLMToolDefinition[] },
  ) => Promise<string>;
  generateMessagesStructured?: (
    messages: ChatMessage[],
    options?: { format?: 'json' | 'text'; tools?: LLMToolDefinition[] },
  ) => Promise<LLMGenerateResult>;
};

export type ConversationToolClient = {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const extractTextContent = (content: unknown): string => {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((item) => {
        if (isPlainRecord(item) && item.type === 'text' && typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
};

export function acceptAssistantResponse(text: string, forceJson = false): string {
  const trimmed = text.trim();
  if (forceJson) {
    JSON.parse(trimmed);
  }
  return trimmed;
}

/** Tool definitions for native cloud API tool calling (Anthropic / OpenAI). */
export const WEB_TOOL_DEFINITIONS: LLMToolDefinition[] = [
  {
    name: 'search_web',
    description:
      'Search the web for current information. Use when the user asks about recent events, weather, news, or anything requiring up-to-date data.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query' } },
      required: ['query'],
    },
  },
  {
    name: 'fetch_content',
    description: 'Fetch and extract text content from a URL.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The URL to fetch' } },
      required: ['url'],
    },
  },
];

export async function runConversationTurn(
  history: ChatMessage[],
  userInput: string,
  llm: ConversationLLM,
  options: {
    maxTokens: number;
    temperature: number;
    allowTools: boolean;
    toolClient?: ConversationToolClient;
    forceJson?: boolean;
    maxToolRounds?: number;
  },
): Promise<string> {
  history.push({ role: 'user', content: userInput });
  const maxToolRounds = options.maxToolRounds ?? 3;
  const useNativeTools =
    options.allowTools && options.toolClient && Boolean(llm.generateMessagesStructured);
  let retriedPlainAnswer = false;

  for (let round = 0; round <= maxToolRounds; round += 1) {
    // --- Native tool calling path (cloud LLMs) ---
    if (useNativeTools && llm.generateMessagesStructured && options.toolClient) {
      const result = await llm.generateMessagesStructured(history, {
        format: options.forceJson ? 'json' : 'text',
        tools: WEB_TOOL_DEFINITIONS,
      });

      if (result.toolCalls && result.toolCalls.length > 0) {
        history.push({
          role: 'assistant',
          content: result.text.trim(),
          rawAssistantContent: result.rawAssistantContent,
        });
        for (const tc of result.toolCalls) {
          const toolResult = await options.toolClient.callTool(tc.name, tc.arguments);
          history.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: toolResult,
          });
        }
        history.push({
          role: 'system',
          content:
            'ツール結果に具体的な数値や詳細が不足している場合は fetch_content でURLの中身を取得してください。十分な情報があれば日本語で回答してください。',
        });
        continue;
      }

      // No tool calls — treat as final answer
      const text = result.text.trim();
      if (text) {
        const accepted = acceptAssistantResponse(text, Boolean(options.forceJson));
        history.push({ role: 'assistant', content: text });
        return accepted;
      }
      // Empty response with no tool calls — fall through to retry logic
    }

    // --- Plain text path (local LLMs or providers without native tools) ---
    if (!useNativeTools) {
      const rawResponse = await generateResponse(llm, history, {
        format: options.forceJson ? 'json' : 'text',
        maxTokens: options.maxTokens,
        temperature: options.temperature,
      });

      const accepted = rawResponse.trim()
        ? acceptAssistantResponse(rawResponse, Boolean(options.forceJson))
        : '';
      if (accepted) {
        history.push({ role: 'assistant', content: rawResponse.trim() });
        return accepted;
      }
    }

    if (!retriedPlainAnswer) {
      retriedPlainAnswer = true;
      history.push({
        role: 'user',
        content: '思考過程やタグを出力せず、最終回答のみを返してください。',
      });
      continue;
    }

    throw new Error('LLM returned an empty response.');
  }

  throw new Error('LLM did not return a final answer within the tool round limit.');
}

async function generateResponse(
  llm: ConversationLLM,
  messages: ChatMessage[],
  options: { format: 'json' | 'text'; maxTokens: number; temperature: number },
): Promise<string> {
  if (llm.generateMessages) {
    return await llm.generateMessages(messages, { format: options.format });
  }

  const latest = messages[messages.length - 1];
  return await llm.generate(latest?.content ?? '', { format: options.format });
}

export function buildPromptMessages(history: ChatMessage[], userInput: string): ChatMessage[] {
  return [...history, { role: 'user', content: userInput }];
}
