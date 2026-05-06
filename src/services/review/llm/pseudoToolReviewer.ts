import type { ReviewerToolContext } from '../tools/types.js';
import type { ChatMessage, ReviewLLMService } from './types.js';

export async function reviewWithPseudoTools(
  llm: ReviewLLMService,
  messages: ChatMessage[],
  ctx: ReviewerToolContext,
): Promise<string> {
  const history = [...messages];
  void ctx;

  const systemIdx = history.findIndex((m) => m.role === 'system');
  const localSystemPrompt =
    'ローカルLLMでは疑似ツール呼び出し構文を使わず、与えられた文脈だけから最終レビュー本文を返してください。';
  if (systemIdx >= 0) {
    history[systemIdx].content += `\n\n${localSystemPrompt}`;
  } else {
    history.unshift({ role: 'system', content: localSystemPrompt });
  }

  const prompt = history.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
  return llm.generate(prompt);
}
