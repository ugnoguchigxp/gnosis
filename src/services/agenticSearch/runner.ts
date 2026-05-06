import { type AgenticLoopMessage, runAgenticToolLoop } from '../agenticCore/toolLoop.js';
import {
  lookupFailureFirewallContext,
  renderFailureFirewallContextForPrompt,
} from '../failureFirewall/context.js';
import { AgenticSearchLlmAdapter } from './llmAdapter.js';
import { saveAgenticAnswer } from './saveAnswer.js';
import { buildInitialSystemContext } from './systemContext.js';
import { buildToolFollowupContext } from './toolContext.js';
import {
  type AgenticSearchToolExecutorRegistry,
  createDefaultAgenticSearchExecutors,
  executeToolCall,
  listAgenticSearchToolSpecs,
} from './toolRegistry.js';
import type {
  AgenticSearchMessage,
  AgenticSearchToolName,
  AgenticSearchTrace,
  AgenticToolResult,
} from './types.js';
import { AGENTIC_SEARCH_TOOL_NAMES } from './types.js';

export type AgenticSearchRunnerInput = {
  userRequest: string;
  repoPath?: string;
  files?: string[];
  changeTypes?: string[];
  technologies?: string[];
  intent?: 'plan' | 'edit' | 'debug' | 'review' | 'finish';
};

export type AgenticSearchRunnerOutput = {
  answer: string;
  toolTrace: AgenticSearchTrace;
  degraded?: { code: string; message: string };
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  savedMemoryId?: string;
};

function buildUserTaskMessage(input: AgenticSearchRunnerInput): string {
  return [
    `request: ${input.userRequest}`,
    `intent: ${input.intent ?? 'edit'}`,
    `repoPath: ${input.repoPath ?? ''}`,
    `files: ${(input.files ?? []).join(', ')}`,
    `changeTypes: ${(input.changeTypes ?? []).join(', ')}`,
    `technologies: ${(input.technologies ?? []).join(', ')}`,
  ].join('\n');
}

function agenticSearchRunLog(event: string, fields: Record<string, unknown> = {}): void {
  console.error(
    `[AgenticSearch] ${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    })}`,
  );
}

function buildPrefetchKnowledgeQuery(input: AgenticSearchRunnerInput): string {
  return [
    input.userRequest,
    ...(input.files ?? []),
    ...(input.changeTypes ?? []),
    ...(input.technologies ?? []),
    input.intent ?? 'edit',
  ]
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter((part) => part.length > 0)
    .join(' ')
    .slice(0, 1200);
}

function shouldPrefetchFailureFirewallContext(input: AgenticSearchRunnerInput): boolean {
  const intent = input.intent ?? 'edit';
  if (intent === 'finish') return false;
  if (
    (input.changeTypes ?? []).length > 0 &&
    (input.changeTypes ?? []).every((type) => type === 'docs')
  ) {
    return false;
  }
  return true;
}

type KnowledgeFallbackItem = {
  id?: string;
  type?: string;
  title: string;
  content: string;
  score?: number;
  retrievalSource?: string;
};

const agenticSearchToolNameSet = new Set<string>(AGENTIC_SEARCH_TOOL_NAMES);

function isAgenticSearchToolName(value: unknown): value is AgenticSearchToolName {
  return typeof value === 'string' && agenticSearchToolNameSet.has(value);
}

function toAgenticSearchMessages(messages: AgenticLoopMessage[]): AgenticSearchMessage[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      const toolCalls = (message.toolCalls ?? []).map((call) => {
        if (!isAgenticSearchToolName(call.name)) {
          throw new Error(
            `invalid_agentic_tool_message_sequence: unknown assistant tool call ${call.name}`,
          );
        }
        return {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        };
      });
      return {
        role: 'assistant',
        content: message.content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        raw: message.rawAssistantContent,
      };
    }
    if (message.role === 'tool') {
      if (!isAgenticSearchToolName(message.toolName)) {
        throw new Error(
          `invalid_agentic_tool_message_sequence: unknown tool result ${message.toolName ?? ''}`,
        );
      }
      return {
        role: 'tool',
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content,
      };
    }
    return message;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toKnowledgeFallbackItem(value: unknown): KnowledgeFallbackItem | null {
  if (!isRecord(value)) return null;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const content = typeof value.content === 'string' ? value.content.trim() : '';
  if (title.length === 0 && content.length === 0) return null;
  const idForTitle =
    typeof value.id === 'string' || typeof value.id === 'number' ? String(value.id) : 'untitled';
  return {
    id: typeof value.id === 'string' ? value.id : undefined,
    type: typeof value.type === 'string' ? value.type : undefined,
    title: title || idForTitle,
    content,
    score: typeof value.score === 'number' ? value.score : undefined,
    retrievalSource: typeof value.retrievalSource === 'string' ? value.retrievalSource : undefined,
  };
}

function truncateForFallback(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit - 1)}...`;
}

function extractKnowledgeFallbackItems(results: AgenticToolResult[]): KnowledgeFallbackItem[] {
  return results
    .filter((result) => result.toolName === 'knowledge_search' && result.ok)
    .flatMap((result) => {
      const rawItems = Array.isArray(result.output?.items) ? result.output.items : [];
      return rawItems
        .map(toKnowledgeFallbackItem)
        .filter((item): item is KnowledgeFallbackItem => item !== null);
    });
}

function getToolDegraded(result: AgenticToolResult): {
  toolName: AgenticSearchToolName;
  code: string;
  message: string;
} | null {
  if (!result.ok) {
    return {
      toolName: result.toolName,
      code: result.error?.code ?? 'UNKNOWN',
      message: result.error?.message ?? '',
    };
  }

  const degraded = result.output?.degraded;
  if (!isRecord(degraded)) return null;
  const code = typeof degraded.code === 'string' ? degraded.code : 'DEGRADED';
  const message = typeof degraded.message === 'string' ? degraded.message : '';
  return { toolName: result.toolName, code, message };
}

function buildPrefetchContextMessage(results: AgenticToolResult[]): string {
  const sections: string[] = [];
  const knowledgeItems = extractKnowledgeFallbackItems(results).slice(0, 5);

  if (knowledgeItems.length > 0) {
    sections.push(
      [
        'Prefetched Gnosis knowledge:',
        ...knowledgeItems.map((item, index) => {
          const meta = [
            item.id ? `id=${item.id}` : undefined,
            item.type ? `type=${item.type}` : undefined,
            item.retrievalSource ? `source=${item.retrievalSource}` : undefined,
            typeof item.score === 'number' ? `score=${item.score.toFixed(3)}` : undefined,
          ]
            .filter((part): part is string => Boolean(part))
            .join(', ');
          return `${index + 1}. ${truncateForFallback(item.title, 100)}${
            meta ? ` (${meta})` : ''
          }: ${truncateForFallback(item.content, 260)}`;
        }),
      ].join('\n'),
    );
  }

  const webResults = results
    .filter((result) => result.toolName === 'brave_search' && result.ok)
    .flatMap((result) => (Array.isArray(result.output?.results) ? result.output.results : []))
    .filter(isRecord)
    .slice(0, 5);

  if (webResults.length > 0) {
    sections.push(
      [
        'Prefetched web search results:',
        ...webResults.map((item, index) => {
          const title = typeof item.title === 'string' ? item.title : 'untitled';
          const url = typeof item.url === 'string' ? item.url : '';
          const description = typeof item.description === 'string' ? item.description : '';
          return `${index + 1}. ${truncateForFallback(title, 100)}${
            url ? ` (${url})` : ''
          }: ${truncateForFallback(description, 240)}`;
        }),
      ].join('\n'),
    );
  }

  const degradedResults = results
    .map(getToolDegraded)
    .filter((item): item is NonNullable<ReturnType<typeof getToolDegraded>> => item !== null);
  if (degradedResults.length > 0) {
    sections.push(
      [
        'Prefetch degraded:',
        ...degradedResults.map((result) =>
          `- ${result.toolName}: ${result.code} ${result.message}`.trim(),
        ),
      ].join('\n'),
    );
  }

  if (sections.length === 0) {
    return [
      'Prefetch completed, but no directly usable knowledge or web result was returned.',
      'Answer from the task context if enough information is available; otherwise call tools for more evidence.',
    ].join('\n');
  }

  return [
    'The following context was prefetched before the agentic loop.',
    'Treat it as compact reference material, not as a tool result message.',
    'Use it if sufficient; call tools only when more evidence is needed.',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

function buildKnowledgeFallbackAnswer(
  results: AgenticToolResult[],
  reason: string,
): string | undefined {
  const items = extractKnowledgeFallbackItems(results).slice(0, 5);

  const degradedResults = results
    .map(getToolDegraded)
    .filter((item): item is NonNullable<ReturnType<typeof getToolDegraded>> => item !== null);

  if (items.length === 0 && degradedResults.length === 0) {
    return undefined;
  }

  const renderedItems = items
    .map((item, index) => {
      const meta = [
        item.id ? `id=${item.id}` : undefined,
        item.type ? `type=${item.type}` : undefined,
        item.retrievalSource ? `source=${item.retrievalSource}` : undefined,
        typeof item.score === 'number' ? `score=${item.score.toFixed(3)}` : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join(', ');
      const title = truncateForFallback(item.title, 100);
      const content = truncateForFallback(item.content, 280);
      return `${index + 1}. ${title}${meta ? ` (${meta})` : ''}\n   ${
        content || '(content empty)'
      }`;
    })
    .join('\n');

  const parts = [
    'LLM による最終回答生成は完了しませんでしたが、Gnosis knowledge には関連候補があります。',
    '',
  ];
  if (renderedItems.length > 0) {
    parts.push(renderedItems, '');
  }
  if (degradedResults.length > 0) {
    parts.push(
      'prefetchDegraded:',
      ...degradedResults.map((result) =>
        `- ${result.toolName}: ${result.code} ${result.message}`.trim(),
      ),
      '',
    );
  }
  parts.push(
    `degradedReason: ${reason}`,
    '上記は raw 候補と prefetch 状態に基づく限定回答です。採用判断や実装前には、該当ファイルまたは一次情報で確認してください。',
  );
  return parts.join('\n');
}

function classifyAgenticLoopFailureCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('tool_calling_unsupported')) return 'TOOL_CALLING_UNSUPPORTED';
  if (
    normalized.includes('reached maximum agentic rounds') ||
    normalized.includes('maximum agentic rounds') ||
    normalized.includes('max tool loops') ||
    normalized.includes('reached max loops')
  ) {
    return 'MAX_TOOL_LOOPS_REACHED';
  }
  if (normalized.includes('invalid_agentic_tool_message_sequence')) {
    return 'TOOL_MESSAGE_SEQUENCE_INVALID';
  }
  return 'AGENTIC_LOOP_FAILED';
}

export class AgenticSearchRunner {
  constructor(
    private readonly adapter = new AgenticSearchLlmAdapter(),
    private readonly executors: AgenticSearchToolExecutorRegistry = createDefaultAgenticSearchExecutors(),
    private readonly maxLoops = 6,
    private readonly failureFirewallContextFn = lookupFailureFirewallContext,
  ) {}

  async run(input: AgenticSearchRunnerInput): Promise<AgenticSearchRunnerOutput> {
    const startedAt = Date.now();
    agenticSearchRunLog('start', {
      intent: input.intent ?? 'edit',
      repoPath: input.repoPath ?? null,
      fileCount: input.files?.length ?? 0,
      changeTypes: input.changeTypes ?? [],
      technologies: input.technologies ?? [],
    });
    const messages: AgenticLoopMessage[] = [
      { role: 'system', content: buildInitialSystemContext() },
      { role: 'user', content: buildUserTaskMessage(input) },
    ];
    const trace: AgenticSearchTrace = { toolCalls: [], loopCount: 0 };
    let usage: AgenticSearchRunnerOutput['usage'];
    const prefetchCalls = [
      {
        id: 'prefetch-knowledge',
        name: 'knowledge_search' as const,
        arguments: { query: buildPrefetchKnowledgeQuery(input), type: 'all', limit: 5 },
      },
      {
        id: 'prefetch-web',
        name: 'brave_search' as const,
        arguments: { query: input.userRequest, count: 5 },
      },
    ];

    const prefetchResults = await Promise.all(
      prefetchCalls.map((call) => executeToolCall(this.executors, call)),
    );
    for (const result of prefetchResults) {
      trace.toolCalls.push({
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        arguments: prefetchCalls.find((call) => call.id === result.toolCallId)?.arguments ?? {},
        ok: result.ok,
        errorCode: result.error?.code,
      });
    }
    agenticSearchRunLog('prefetch_complete', {
      durationMs: Date.now() - startedAt,
      toolCount: prefetchResults.length,
      failedTools: prefetchResults.filter((result) => !result.ok).map((result) => result.toolName),
    });
    messages.push({
      role: 'system',
      content: buildPrefetchContextMessage(prefetchResults),
    });
    if (shouldPrefetchFailureFirewallContext(input)) {
      try {
        const context = await this.failureFirewallContextFn({
          taskGoal: input.userRequest,
          files: input.files ?? [],
          changeTypes: input.changeTypes ?? [],
          technologies: input.technologies ?? [],
          maxGoldenPaths: 3,
          maxFailurePatterns: 3,
          maxLessonCandidates: 5,
        });
        if (context.shouldUse) {
          messages.push({
            role: 'system',
            content: [
              renderFailureFirewallContextForPrompt(context),
              'Use this only as task-specific review/reference context. Keep the final answer natural-language and do not expose a separate Firewall schema.',
            ].join('\n\n'),
          });
        }
      } catch {
        // Failure Firewall context is best-effort; normal search results remain usable.
      }
    }
    messages.push({
      role: 'system',
      content: [
        '第一ラウンドの knowledge_search と brave_search の結果を両方受け取った。',
        'この2つを比較して、回答に十分かを判断する。',
        '不足なら fetch を使って根拠を補完する。',
        'memory_search / memory_fetch は context 圧縮後の raw memory 補助確認が必要な場合だけ使う。',
      ].join('\n'),
    });

    try {
      const loopResult = await runAgenticToolLoop({
        initialMessages: messages,
        tools: listAgenticSearchToolSpecs().map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
        maxLoops: this.maxLoops,
        generate: async (history) => {
          const generated = await this.adapter.generate(toAgenticSearchMessages(history));
          return {
            text: generated.text,
            toolCalls: generated.toolCalls,
            rawAssistantContent: generated.raw,
            usage: generated.usage,
          };
        },
        executeTool: async (call) => {
          if (!isAgenticSearchToolName(call.name)) {
            throw new Error(
              `invalid_agentic_tool_message_sequence: unknown tool call ${call.name}`,
            );
          }
          const result = await executeToolCall(this.executors, {
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          });
          trace.toolCalls.push({
            toolCallId: call.id,
            toolName: call.name,
            arguments: call.arguments,
            ok: result.ok,
            errorCode: result.error?.code,
          });
          return result;
        },
        onToolBatchComplete: (toolCalls) =>
          toolCalls
            .map((call) => {
              if (!isAgenticSearchToolName(call.name)) {
                throw new Error(
                  `invalid_agentic_tool_message_sequence: unknown tool call ${call.name}`,
                );
              }
              return buildToolFollowupContext(call.name);
            })
            .join('\n\n'),
      });

      usage = loopResult.usage;
      trace.loopCount = loopResult.loopCount;
      const answer = loopResult.finalText.trim();
      if (answer.length > 0) {
        let savedMemoryId: string | undefined;
        try {
          savedMemoryId = await saveAgenticAnswer({
            input,
            answer,
            trace,
          });
        } catch {
          savedMemoryId = undefined;
        }
        agenticSearchRunLog('end', {
          status: 'ok',
          durationMs: Date.now() - startedAt,
          loopCount: trace.loopCount,
          toolCallCount: trace.toolCalls.length,
          saved: Boolean(savedMemoryId),
        });
        return { answer, toolTrace: trace, usage, savedMemoryId };
      }
      const fallback = buildKnowledgeFallbackAnswer(prefetchResults, 'EMPTY_ASSISTANT_RESPONSE');
      if (fallback) {
        agenticSearchRunLog('end', {
          status: 'degraded',
          code: 'EMPTY_ASSISTANT_RESPONSE',
          durationMs: Date.now() - startedAt,
          loopCount: trace.loopCount,
          toolCallCount: trace.toolCalls.length,
        });
        return {
          answer: fallback,
          toolTrace: trace,
          degraded: { code: 'EMPTY_ASSISTANT_RESPONSE', message: 'No text and no tool calls' },
          usage,
        };
      }
      agenticSearchRunLog('end', {
        status: 'degraded',
        code: 'EMPTY_ASSISTANT_RESPONSE',
        durationMs: Date.now() - startedAt,
        loopCount: trace.loopCount,
        toolCallCount: trace.toolCalls.length,
      });
      return {
        answer: '結果が見つかりませんでした。',
        toolTrace: trace,
        degraded: { code: 'EMPTY_ASSISTANT_RESPONSE', message: 'No text and no tool calls' },
        usage,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Reached max loops (${this.maxLoops})`;
      const code = classifyAgenticLoopFailureCode(message);
      const fallback = buildKnowledgeFallbackAnswer(prefetchResults, message);
      if (fallback) {
        agenticSearchRunLog('end', {
          status: 'degraded',
          code,
          durationMs: Date.now() - startedAt,
          loopCount: trace.loopCount,
          toolCallCount: trace.toolCalls.length,
          message,
        });
        return {
          answer: fallback,
          toolTrace: trace,
          degraded: {
            code,
            message,
          },
          usage,
        };
      }
      agenticSearchRunLog('end', {
        status: 'degraded',
        code,
        durationMs: Date.now() - startedAt,
        loopCount: trace.loopCount,
        toolCallCount: trace.toolCalls.length,
        message,
      });
      return {
        answer: '結果が見つかりませんでした。',
        toolTrace: trace,
        degraded: {
          code,
          message,
        },
        usage,
      };
    }
  }
}
