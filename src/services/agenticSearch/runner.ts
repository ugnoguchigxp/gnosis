import { AgenticSearchLlmAdapter } from './llmAdapter.js';
import { saveAgenticAnswer } from './saveAnswer.js';
import { buildInitialSystemContext } from './systemContext.js';
import { buildToolFollowupContext } from './toolContext.js';
import {
  type AgenticSearchToolExecutorRegistry,
  createDefaultAgenticSearchExecutors,
  executeToolCall,
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

export class AgenticSearchRunner {
  constructor(
    private readonly adapter = new AgenticSearchLlmAdapter(),
    private readonly executors: AgenticSearchToolExecutorRegistry = createDefaultAgenticSearchExecutors(),
    private readonly maxLoops = 6,
  ) {}

  async run(input: AgenticSearchRunnerInput): Promise<AgenticSearchRunnerOutput> {
    const messages: AgenticSearchMessage[] = [
      { role: 'system', content: buildInitialSystemContext() },
      { role: 'user', content: buildUserTaskMessage(input) },
    ];
    const trace: AgenticSearchTrace = { toolCalls: [], loopCount: 0 };
    let usage: AgenticSearchRunnerOutput['usage'];
    const prefetchCalls = [
      {
        id: 'prefetch-knowledge',
        name: 'knowledge_search' as const,
        arguments: { query: input.userRequest, type: 'lesson', limit: 5 },
      },
      {
        id: 'prefetch-web',
        name: 'brave_search' as const,
        arguments: { query: input.userRequest, count: 5 },
      },
    ];

    // First round: always gather both internal knowledge and web results.
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: prefetchCalls,
      raw: {
        tool_calls: prefetchCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      },
    });

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
    messages.push({
      role: 'system',
      content: [
        '第一ラウンドの knowledge_search と brave_search の結果を両方受け取った。',
        'この2つを比較して、回答に十分かを判断する。',
        '不足なら fetch を使って根拠を補完する。',
      ].join('\n'),
    });

    for (let loop = 0; loop < this.maxLoops; loop++) {
      trace.loopCount = loop + 1;
      const generated = await this.adapter.generate(messages);
      usage = generated.usage;
      messages.push({
        role: 'assistant',
        content: generated.text,
        toolCalls: generated.toolCalls,
        raw: generated.raw,
      });

      if (generated.toolCalls.length === 0) {
        const answer = generated.text.trim();
        if (answer.length > 0) {
          let savedMemoryId: string | undefined;
          try {
            savedMemoryId = await saveAgenticAnswer({
              input,
              answer,
              trace,
            });
          } catch {
            // Do not fail agentic_search when persistence fails.
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
      }

      const followupContexts: string[] = [];
      for (const call of generated.toolCalls) {
        const result = await executeToolCall(this.executors, call);
        trace.toolCalls.push({
          toolCallId: call.id,
          toolName: call.name,
          arguments: call.arguments,
          ok: result.ok,
          errorCode: result.error?.code,
        });
        messages.push({
          role: 'tool',
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          content: JSON.stringify(result.ok ? result.output : { error: result.error }),
        });
        followupContexts.push(buildToolFollowupContext(call.name));
      }
      if (followupContexts.length > 0) {
        messages.push({
          role: 'system',
          content: followupContexts.join('\n\n'),
        });
      }
    }

    return {
      answer: '結果が見つかりませんでした。',
      toolTrace: trace,
      degraded: {
        code: 'MAX_TOOL_LOOPS_REACHED',
        message: `Reached max loops (${this.maxLoops})`,
      },
      usage,
    };
  }
}
