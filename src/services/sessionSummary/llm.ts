import { config } from '../../config.js';
import { runPromptWithMemoryLoopRouter } from '../memoryLoopLlmRouter.js';
import { buildTurnCandidatePrompt } from './prompt.js';
import type { KnowledgeCandidate, SessionTurnBlock } from './types.js';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function parseConfidenceByIndex(raw: string, expectedCount: number): Map<number, number> {
  const parsed = new Map<number, number>();
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== expectedCount) return parsed;
  for (const [lineIndex, line] of lines.entries()) {
    const confidence = Number(line);
    if (!Number.isFinite(confidence)) return new Map();
    parsed.set(lineIndex + 1, clamp01(confidence));
  }
  return parsed;
}

export function isLocalLlmAvailable(): boolean {
  return typeof config.llmScript === 'string' && config.llmScript.trim().length > 0;
}

export async function refineCandidatesWithLlm(
  turn: SessionTurnBlock,
  deterministicCandidates: KnowledgeCandidate[],
): Promise<{
  status: 'llm_succeeded' | 'llm_failed';
  candidates: KnowledgeCandidate[];
  diagnostics?: { parsedConfidenceCount: number; rawOutputPreview: string };
}> {
  if (!isLocalLlmAvailable()) {
    return { status: 'llm_failed', candidates: deterministicCandidates };
  }

  try {
    const prompt = buildTurnCandidatePrompt(turn, deterministicCandidates);
    const routed = await runPromptWithMemoryLoopRouter({
      prompt,
      taskKind: 'distillation',
      llmTimeoutMs: 180_000,
      maxTokens: 900,
      allowCloudFallback: false,
    });
    const byIndex = parseConfidenceByIndex(routed.output, deterministicCandidates.length);
    if (byIndex.size === 0) throw new Error('No confidence lines found in LLM output');
    const candidates: KnowledgeCandidate[] = deterministicCandidates.map((candidate, idx) => {
      const assigned = byIndex.get(idx + 1);
      return {
        ...candidate,
        confidence: typeof assigned === 'number' ? assigned : candidate.confidence,
        status: 'llm_succeeded',
      };
    });
    return {
      status: 'llm_succeeded',
      candidates,
      diagnostics: {
        parsedConfidenceCount: byIndex.size,
        rawOutputPreview: routed.output.slice(0, 400),
      },
    };
  } catch {
    return { status: 'llm_failed', candidates: deterministicCandidates };
  }
}
