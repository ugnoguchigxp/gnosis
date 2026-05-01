import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  AgenticSearchToolName,
  AgenticToolCall,
  AgenticToolResult,
} from './types.js';
import { runBraveSearch } from './tools/braveSearch.js';
import { runFetch } from './tools/fetch.js';
import { runKnowledgeSearch } from './tools/knowledgeSearch.js';

const knowledgeSearchArgsSchema = z.object({
  query: z.string().min(1),
  type: z.enum(['lesson', 'rule', 'procedure']),
  limit: z.number().int().positive().max(20).optional(),
});

const braveSearchArgsSchema = z.object({
  query: z.string().min(1),
  count: z.number().int().positive().max(10).optional(),
});

const fetchArgsSchema = z.object({
  url: z.string().url(),
});

type KnowledgeSearchArgs = z.infer<typeof knowledgeSearchArgsSchema>;
type BraveSearchArgs = z.infer<typeof braveSearchArgsSchema>;
type FetchArgs = z.infer<typeof fetchArgsSchema>;

export type AgenticSearchToolExecutorRegistry = {
  knowledge_search: (args: KnowledgeSearchArgs) => Promise<Record<string, unknown>>;
  brave_search: (args: BraveSearchArgs) => Promise<Record<string, unknown>>;
  fetch: (args: FetchArgs) => Promise<Record<string, unknown>>;
};

type AgenticSearchToolSpec = {
  name: AgenticSearchToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

const TOOL_SPECS: AgenticSearchToolSpec[] = [
  {
    name: 'knowledge_search',
    description: 'Gnosis knowledgeから指定typeの候補を取得する。',
    inputSchema: zodToJsonSchema(knowledgeSearchArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'brave_search',
    description: 'Brave Search API で外部Web検索結果を取得する。',
    inputSchema: zodToJsonSchema(braveSearchArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'fetch',
    description: 'URLの本文テキストを取得する。',
    inputSchema: zodToJsonSchema(fetchArgsSchema) as Record<string, unknown>,
  },
];

export function listAgenticSearchToolSpecs(): AgenticSearchToolSpec[] {
  return TOOL_SPECS;
}

export function createDefaultAgenticSearchExecutors(): AgenticSearchToolExecutorRegistry {
  return {
    knowledge_search: runKnowledgeSearch,
    brave_search: runBraveSearch,
    fetch: runFetch,
  };
}

export async function executeToolCall(
  executors: AgenticSearchToolExecutorRegistry,
  toolCall: AgenticToolCall,
): Promise<AgenticToolResult> {
  try {
    let output: Record<string, unknown>;
    if (toolCall.name === 'knowledge_search') {
      const parsed = knowledgeSearchArgsSchema.safeParse(toolCall.arguments);
      if (!parsed.success) {
        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          ok: false,
          error: { code: 'INVALID_ARGUMENTS', message: parsed.error.message },
        };
      }
      output = await executors.knowledge_search(parsed.data);
    } else if (toolCall.name === 'brave_search') {
      const parsed = braveSearchArgsSchema.safeParse(toolCall.arguments);
      if (!parsed.success) {
        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          ok: false,
          error: { code: 'INVALID_ARGUMENTS', message: parsed.error.message },
        };
      }
      output = await executors.brave_search(parsed.data);
    } else {
      const parsed = fetchArgsSchema.safeParse(toolCall.arguments);
      if (!parsed.success) {
        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          ok: false,
          error: { code: 'INVALID_ARGUMENTS', message: parsed.error.message },
        };
      }
      output = await executors.fetch(parsed.data);
    }
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      ok: true,
      output,
    };
  } catch (error) {
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      ok: false,
      error: {
        code: 'TOOL_EXECUTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
