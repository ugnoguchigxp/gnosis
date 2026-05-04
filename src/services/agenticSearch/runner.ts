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
import type { AgenticSearchMessage, AgenticSearchTrace } from './types.js';

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

export class AgenticSearchRunner {
  constructor(
    private readonly adapter = new AgenticSearchLlmAdapter(),
    private readonly executors: AgenticSearchToolExecutorRegistry = createDefaultAgenticSearchExecutors(),
    private readonly maxLoops = 6,
    private readonly failureFirewallContextFn = lookupFailureFirewallContext,
  ) {}

  async run(input: AgenticSearchRunnerInput): Promise<AgenticSearchRunnerOutput> {
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
        arguments: { query: input.userRequest, type: 'all', limit: 5 },
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
      messages.push({
        role: 'tool',
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        content: JSON.stringify(result.ok ? result.output : { error: result.error }),
      });
    }
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
          const generated = await this.adapter.generate(history as AgenticSearchMessage[]);
          return {
            text: generated.text,
            toolCalls: generated.toolCalls,
            rawAssistantContent: generated.raw,
            usage: generated.usage,
          };
        },
        executeTool: async (call) => {
          const result = await executeToolCall(this.executors, {
            id: call.id,
            name: call.name as 'knowledge_search' | 'brave_search' | 'fetch',
            arguments: call.arguments,
          });
          trace.toolCalls.push({
            toolCallId: call.id,
            toolName: call.name as 'knowledge_search' | 'brave_search' | 'fetch',
            arguments: call.arguments,
            ok: result.ok,
            errorCode: result.error?.code,
          });
          return result;
        },
        onToolBatchComplete: (toolCalls) =>
          toolCalls
            .map((call) =>
              buildToolFollowupContext(call.name as 'knowledge_search' | 'brave_search' | 'fetch'),
            )
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
        return { answer, toolTrace: trace, usage, savedMemoryId };
      }
      return {
        answer: '結果が見つかりませんでした。',
        toolTrace: trace,
        degraded: { code: 'EMPTY_ASSISTANT_RESPONSE', message: 'No text and no tool calls' },
        usage,
      };
    } catch (error) {
      return {
        answer: '結果が見つかりませんでした。',
        toolTrace: trace,
        degraded: {
          code: 'MAX_TOOL_LOOPS_REACHED',
          message: error instanceof Error ? error.message : `Reached max loops (${this.maxLoops})`,
        },
        usage,
      };
    }
  }
}
