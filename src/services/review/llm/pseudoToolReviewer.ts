import { ReviewError } from '../errors.js';
import { createDefaultReviewerToolRegistry } from '../tools/index.js';
import type { ReviewerToolContext } from '../tools/types.js';
import type { ChatMessage, ReviewLLMService } from './types.js';

export async function reviewWithPseudoTools(
  llm: ReviewLLMService,
  messages: ChatMessage[],
  ctx: ReviewerToolContext,
): Promise<string> {
  const registry = createDefaultReviewerToolRegistry();
  const toolSpecs = registry.toToolSpecList().join('\n');
  const maxRounds = ctx.maxToolRounds ?? 5;
  const history = [...messages];

  // Inject pseudo tool instructions if not present
  const pseudoSystemPrompt = `
あなたは強力なエンジニアリングツールを利用できるコードレビュアーです。
必要に応じて、以下のツールを呼び出して情報を収集できます。

ツール一覧:
${toolSpecs}

ツールの呼び出し方法:
<tool_call name="ツール名" args='{"arg1": "value"}' />
という形式で一行で記述してください。一度の返信で一つのツールのみ呼び出せます。

ツールが呼び出された場合、システムからその実行結果が提供されます。
すべての情報を収集し終えたら、最終的なレビュー結果を返してください。
`;

  // Find or insert system prompt
  const systemIdx = history.findIndex((m) => m.role === 'system');
  if (systemIdx >= 0) {
    history[systemIdx].content += `\n\n${pseudoSystemPrompt}`;
  } else {
    history.unshift({ role: 'system', content: pseudoSystemPrompt });
  }

  for (let round = 0; round < maxRounds; round++) {
    // Generate text (local LLM)
    const prompt = history.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    const response = await llm.generate(prompt);
    history.push({ role: 'assistant', content: response });

    // Look for <tool_call ... /> - more robust regex
    const toolCallMatch = response.match(
      /<tool_call\s+name=["'](?<name>[^"']+)["']\s+args=(?:'(?<args_s>[^']+)'|"(?<args_d>[^"]+)"|(?<argsjson>\{[\s\S]*?\}))\s*\/?>/i,
    );
    if (!toolCallMatch) {
      // No more tool calls, assume final answer
      return response;
    }

    const name = toolCallMatch.groups?.name || '';
    const argsStr =
      toolCallMatch.groups?.args_s ||
      toolCallMatch.groups?.args_d ||
      toolCallMatch.groups?.argsjson ||
      '';

    try {
      const args = JSON.parse(argsStr);
      const output = await registry.execute(name, args, ctx);

      history.push({
        role: 'user',
        content: `<tool_result name="${name}">\n${output}\n</tool_result>`,
      });
    } catch (error) {
      history.push({
        role: 'user',
        content: `<tool_result name="${name}">\n[Error]: ${
          error instanceof Error ? error.message : String(error)
        }\n</tool_result>`,
      });
    }
  }

  throw new ReviewError(
    'E012',
    `Reached maximum agentic rounds (${maxRounds}) without final answer.`,
  );
}
