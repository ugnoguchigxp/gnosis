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
  const history = [...messages];

  if (!llm.generateMessagesStructured) {
    throw new ReviewError('E007', 'LLM service does not support structured tool calls');
  }

  for (let round = 0; round < maxRounds; round++) {
    const result = await llm.generateMessagesStructured(history, { tools });
    const content = result.text.trim();

    if (content) {
      history.push({ role: 'assistant', content });
    }

    if (!result.toolCalls || result.toolCalls.length === 0) {
      // Final answer
      return content;
    }

    // Execute tool calls
    const toolResults: ChatMessage[] = [];
    for (const tc of result.toolCalls) {
      const output = await registry.execute(tc.name, tc.arguments, ctx);
      // For some providers, we might need to include tool_call_id
      // For now we just feed it back as content in a user message or specific role if supported
      // Gnosis cloudProvider expects tool results in a specific way if we were to support it natively
      // For simplicity in Stage E, we append as 'user' role with a clear marker if role='tool' is not handled
      history.push({
        role: 'user',
        content: `[Tool Result for ${tc.name}]:\n${output}`,
      });
    }
  }

  throw new ReviewError(
    'E012',
    `Reached maximum agentic rounds (${maxRounds}) without final answer.`,
  );
}
