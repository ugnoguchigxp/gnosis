export type AgenticLoopMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      rawAssistantContent?: unknown;
      toolCalls?: AgenticLoopToolCall[];
    }
  | { role: 'tool'; content: string; toolCallId: string; toolName?: string };

export type AgenticLoopTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type AgenticLoopToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type AgenticLoopGenerateResult = {
  text: string;
  toolCalls?: AgenticLoopToolCall[];
  rawAssistantContent?: unknown;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
};

export type AgenticLoopToolExecutionResult = {
  toolCallId: string;
  toolName: string;
  ok: boolean;
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
};

export async function runAgenticToolLoop(input: {
  initialMessages: AgenticLoopMessage[];
  tools: AgenticLoopTool[];
  maxLoops: number;
  generate: (
    messages: AgenticLoopMessage[],
    tools: AgenticLoopTool[],
  ) => Promise<AgenticLoopGenerateResult>;
  executeTool: (toolCall: AgenticLoopToolCall) => Promise<AgenticLoopToolExecutionResult>;
  onToolBatchComplete?: (toolCalls: AgenticLoopToolCall[]) => string | undefined;
}): Promise<{
  finalText: string;
  messages: AgenticLoopMessage[];
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  loopCount: number;
  toolResults: AgenticLoopToolExecutionResult[];
}> {
  const messages: AgenticLoopMessage[] = [...input.initialMessages];
  const toolResults: AgenticLoopToolExecutionResult[] = [];
  let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;

  for (let loop = 0; loop < input.maxLoops; loop += 1) {
    const generated = await input.generate(messages, input.tools);
    usage = generated.usage;
    const content = generated.text?.trim() ?? '';
    messages.push({
      role: 'assistant',
      content,
      rawAssistantContent: generated.rawAssistantContent,
      toolCalls: generated.toolCalls,
    });

    const toolCalls = generated.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return { finalText: content, messages, usage, loopCount: loop + 1, toolResults };
    }

    for (const toolCall of toolCalls) {
      const result = await input.executeTool(toolCall);
      toolResults.push(result);
      messages.push({
        role: 'tool',
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        content: JSON.stringify(result.ok ? result.output : { error: result.error }),
      });
    }

    const followup = input.onToolBatchComplete?.(toolCalls);
    if (followup && followup.trim().length > 0) {
      messages.push({ role: 'system', content: followup });
    }
  }

  throw new Error(`Reached maximum agentic rounds (${input.maxLoops}) without final answer.`);
}
