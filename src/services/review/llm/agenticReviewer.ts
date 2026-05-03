import { runAgenticToolLoop } from '../../agenticCore/toolLoop.js';
import { ReviewError } from '../errors.js';
import { createDefaultReviewerToolRegistry } from '../tools/index.js';
import type { ReviewerToolContext } from '../tools/types.js';
import { reviewWithPseudoTools } from './pseudoToolReviewer.js';
import type { ChatMessage, ReviewLLMService } from './types.js';

export async function reviewWithTools(
  llm: ReviewLLMService,
  messages: ChatMessage[],
  ctx: ReviewerToolContext,
): Promise<string> {
  if (llm.provider === 'local') {
    return reviewWithPseudoTools(llm, messages, ctx);
  }

  return reviewWithNativeTools(llm, messages, ctx);
}

async function reviewWithNativeTools(
  llm: ReviewLLMService,
  messages: ChatMessage[],
  ctx: ReviewerToolContext,
): Promise<string> {
  const registry = createDefaultReviewerToolRegistry();
  const tools = registry.toLLMToolDefinitions();
  const maxRounds = ctx.maxToolRounds ?? 5;

  if (!llm.generateMessagesStructured) {
    throw new ReviewError('E007', 'LLM service does not support structured tool calls');
  }
  const generateMessagesStructured = llm.generateMessagesStructured;

  try {
    const result = await runAgenticToolLoop({
      initialMessages: messages,
      tools,
      maxLoops: maxRounds,
      generate: async (history) => {
        const generated = await generateMessagesStructured(history as ChatMessage[], { tools });
        return {
          text: generated.text,
          toolCalls: (generated.toolCalls ?? []).map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments as Record<string, unknown>,
          })),
          rawAssistantContent: generated.rawAssistantContent,
          usage: generated.usage,
        };
      },
      executeTool: async (toolCall) => {
        const output = await registry.execute(toolCall.name, toolCall.arguments, ctx);
        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          ok: true,
          output: { text: output },
        };
      },
    });
    return result.finalText.trim();
  } catch (error) {
    throw new ReviewError(
      'E012',
      error instanceof Error
        ? error.message
        : `Reached maximum agentic rounds (${maxRounds}) without final answer.`,
    );
  }
}
