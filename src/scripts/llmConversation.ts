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

const TOOL_CALL_RE =
  /(?:<\|tool_call\|>|<tool_call>)\s*call:(\w+)\s*\{(.*?)\}\s*(?:<tool_call\|>|<\|tool_call\|>|<\/tool_call>)/gs;
const JSON_TOOL_CALL_RE =
  /(?:<\|tool_call\|>|<tool_call>)\s*(\{.*?\})\s*(?:<tool_call\|>|<\|tool_call\|>|<\/tool_call>)/s;
const TOOL_ARGS_RE = /(\w+)\s*:\s*<\|"\|>(.*?)<\|"\|>/gs;
const TOOL_ARGS_QUOTED_RE = /(\w+)\s*:\s*"(.*?)"/gs;
const TOOL_ARGS_SINGLE_QUOTED_RE = /(\w+)\s*:\s*'(.*?)'/gs;
const TOOL_ARGS_BARE_RE = /(\w+)\s*:\s*([^,\n}]+)/gs;
const THINK_BLOCK_RE = /<\|channel>thought.*?(?:<channel\|>|$)/gs;
const LEGACY_THINK_BLOCK_RE = /<think>.*?(?:<\/think>|$)/gs;
const INCOMPLETE_TOOL_CALL_RE = /(?:<\|tool_call\|>|<tool_call>).*/s;
const JSON_CODE_BLOCK_RE = /```(?:json)?\s*(.*?)\s*```/is;

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

export type ParsedToolCall = {
  name: string;
  arguments: Record<string, string>;
};

export function parseToolCall(text: string): ParsedToolCall | null {
  const callMatch = text.match(/call:(\w+)\s*\{(.*?)\}/s);
  if (callMatch) {
    const [, funcName, argsStr] = callMatch;
    const args: Record<string, string> = {};

    for (const match of argsStr.matchAll(TOOL_ARGS_RE)) {
      args[match[1]] = match[2];
    }
    if (Object.keys(args).length === 0) {
      for (const match of argsStr.matchAll(TOOL_ARGS_QUOTED_RE)) {
        args[match[1]] = match[2];
      }
    }
    if (Object.keys(args).length === 0) {
      for (const match of argsStr.matchAll(TOOL_ARGS_SINGLE_QUOTED_RE)) {
        args[match[1]] = match[2];
      }
    }
    if (Object.keys(args).length === 0) {
      for (const match of argsStr.matchAll(TOOL_ARGS_BARE_RE)) {
        args[match[1]] = match[2].trim();
      }
    }
    if (Object.keys(args).length === 0 && argsStr.trim()) {
      try {
        const parsed = JSON.parse(`{${argsStr}}`) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          args[key] = typeof value === 'string' ? value : JSON.stringify(value);
        }
      } catch {
        // ignore parse failure
      }
    }

    return { name: funcName, arguments: args };
  }

  const jsonTagMatch = text.match(JSON_TOOL_CALL_RE);
  if (jsonTagMatch?.[1]) {
    try {
      const payload = JSON.parse(jsonTagMatch[1]) as Record<string, unknown>;
      const parsed = parseToolPayload(payload);
      if (parsed) return parsed;
    } catch {
      // ignore parse failure
    }
  }

  const payload = extractJsonPayload(text);
  if (payload) {
    try {
      const parsed = parseToolPayload(JSON.parse(payload) as Record<string, unknown>);
      if (parsed) return parsed;
    } catch {
      // ignore parse failure
    }
  }

  return null;
}

function parseToolPayload(payload: unknown): ParsedToolCall | null {
  if (!isPlainRecord(payload)) return null;

  let funcName = payload.name;
  let argumentsValue: unknown = payload.arguments ?? {};

  if (!funcName && isPlainRecord(payload.function)) {
    funcName = payload.function.name;
    argumentsValue = payload.function.arguments ?? argumentsValue;
  }

  if (!funcName && isPlainRecord(payload.tool)) {
    funcName = payload.tool.name;
    argumentsValue = payload.tool.arguments ?? argumentsValue;
  }

  if (typeof funcName !== 'string' || !funcName) return null;

  if (typeof argumentsValue === 'string') {
    try {
      argumentsValue = JSON.parse(argumentsValue);
    } catch {
      argumentsValue = {};
    }
  }

  if (!isPlainRecord(argumentsValue)) {
    argumentsValue = {};
  }

  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(argumentsValue as Record<string, unknown>)) {
    args[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }

  return { name: normalizeToolName(funcName), arguments: args };
}

function extractJsonPayload(text: string): string | null {
  const codeBlockMatch = text.match(JSON_CODE_BLOCK_RE);
  if (codeBlockMatch?.[1]) {
    const candidate = codeBlockMatch[1].trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // ignore parse failure
    }
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = text.slice(start, end + 1).trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // ignore parse failure
    }
  }

  return null;
}

export function sanitizeAssistantResponse(text: string, forceJson = false): string {
  let sanitized = text;
  sanitized = sanitized.replace(THINK_BLOCK_RE, '');
  sanitized = sanitized.replace(LEGACY_THINK_BLOCK_RE, '');
  sanitized = sanitized.replace(TOOL_CALL_RE, '');
  sanitized = sanitized.replace(JSON_TOOL_CALL_RE, '');
  sanitized = sanitized.replace(INCOMPLETE_TOOL_CALL_RE, '');
  sanitized = sanitized.replaceAll('<channel|>', '').replaceAll('<|channel>thought', '');
  sanitized = sanitized.replaceAll('<|tool_call|>', '').replaceAll('<tool_call|>', '');
  sanitized = sanitized.replaceAll('<tool_call>', '').replaceAll('</tool_call>', '');

  if (forceJson) {
    const payload = extractJsonPayload(sanitized);
    if (payload !== null) return payload;
  }

  const trimmed = sanitized.trim();
  const codeBlockMatch = trimmed.match(JSON_CODE_BLOCK_RE);
  if (codeBlockMatch?.[1] && !forceJson) {
    return codeBlockMatch[1].trim();
  }

  return trimmed;
}

export function buildToolInstruction(): string {
  return [
    '必要な場合のみツールを呼び出してください。',
    '形式: <|tool_call|>call:関数名{引数名:<|"|>値<|"|>}<tool_call|>',
    '利用可能ツール: search_web(query) / web_search(query), fetch_content(url)',
  ].join('\n');
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
        // Push assistant content (may include text + tool_use blocks)
        history.push({ role: 'assistant', content: result.text || '(tool call)' });
        for (const tc of result.toolCalls) {
          const toolResult = await options.toolClient.callTool(tc.name, tc.arguments);
          history.push({
            role: 'user',
            content: `（検索結果: ${tc.name}）\n${toolResult}\nこの結果に具体的な数値や詳細が不足している場合は fetch_content でURLの中身を取得してください。十分な情報があれば日本語で回答してください。`,
          });
        }
        continue;
      }

      // No tool calls — treat as final answer
      const text = result.text.trim();
      if (text) {
        history.push({ role: 'assistant', content: text });
        return sanitizeAssistantResponse(text, Boolean(options.forceJson));
      }
      // Empty response with no tool calls — fall through to retry logic
    }

    // --- Text-based tool calling path (local LLMs) ---
    if (!useNativeTools) {
      const rawResponse = await generateResponse(llm, history, {
        format: options.forceJson ? 'json' : 'text',
        maxTokens: options.maxTokens,
        temperature: options.temperature,
      });

      const toolCall = options.allowTools ? parseToolCall(rawResponse) : null;
      if (toolCall && options.toolClient) {
        const toolResult = await options.toolClient.callTool(toolCall.name, toolCall.arguments);
        history.push({ role: 'assistant', content: rawResponse.trim() });
        history.push({
          role: 'user',
          content: `（検索結果）\n${toolResult}\nこの結果をもとに、回答を日本語で生成してください。`,
        });
        continue;
      }

      const sanitized = sanitizeAssistantResponse(rawResponse, Boolean(options.forceJson));
      if (sanitized) {
        history.push({ role: 'assistant', content: rawResponse.trim() });
        return sanitized;
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

    return '回答を生成できませんでした。';
  }

  return '上限に達しました。';
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
