import { z } from 'zod';
import { config } from '../../config.js';
import { runPromptWithMemoryLoopRouter } from '../memoryLoopLlmRouter.js';
import { buildTurnCandidatePrompt } from './prompt.js';
import type { KnowledgeCandidate, SessionTurnBlock } from './types.js';

const CandidateSchema = z.object({
  kind: z.enum(['lesson', 'rule', 'procedure', 'candidate']),
  title: z.string().min(1),
  statement: z.string().min(1),
  keep: z.boolean(),
  keepReason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.object({ kind: z.string(), text: z.string() })).default([]),
});

const CandidateResponseSchema = z.object({
  candidates: z.array(CandidateSchema).max(8),
});

function parseJsonObject(raw: string): unknown {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON object found in LLM output');
    return JSON.parse(match[0]);
  }
}

export function isLocalLlmAvailable(): boolean {
  return typeof config.llmScript === 'string' && config.llmScript.trim().length > 0;
}

export async function refineCandidatesWithLlm(
  turn: SessionTurnBlock,
  deterministicCandidates: KnowledgeCandidate[],
): Promise<{ status: 'llm_succeeded' | 'llm_failed'; candidates: KnowledgeCandidate[] }> {
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
    const parsed = CandidateResponseSchema.parse(parseJsonObject(routed.output));
    const candidates: KnowledgeCandidate[] = parsed.candidates.map((candidate) => ({
      turnIndex: turn.turnIndex,
      kind: candidate.kind,
      title: candidate.title,
      statement: candidate.statement,
      keep: candidate.keep,
      keepReason: candidate.keepReason,
      confidence: candidate.confidence,
      evidence: deterministicCandidates[0]?.evidence ?? [],
      actions: deterministicCandidates[0]?.actions ?? [],
      status: 'llm_succeeded',
    }));
    return { status: 'llm_succeeded', candidates };
  } catch {
    return { status: 'llm_failed', candidates: deterministicCandidates };
  }
}
