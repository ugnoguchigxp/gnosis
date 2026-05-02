import type { KnowledgeCandidate, SessionTurnBlock } from './types.js';

export const SESSION_DISTILLATION_PROMPT_VERSION = 'session-distill-v1';

function safeJson<T>(value: T): string {
  return JSON.stringify(value, null, 2);
}

export function buildTurnCandidatePrompt(
  turn: SessionTurnBlock,
  candidates: KnowledgeCandidate[],
): string {
  const payload = {
    userIntent: turn.deterministicIntent,
    userContent: turn.userContent,
    messages: turn.messages.map((message) => ({
      role: message.role,
      content: message.content.slice(0, 280),
    })),
    deterministicActions: turn.deterministicActions,
    deterministicEvidence: turn.deterministicEvidence,
    deterministicCandidates: candidates.map((candidate) => ({
      kind: candidate.kind,
      title: candidate.title,
      statement: candidate.statement,
      keep: candidate.keep,
      keepReason: candidate.keepReason,
      confidence: candidate.confidence,
    })),
  };

  return [
    '以下の turn 情報から知識候補を圧縮してください。',
    '出力は JSON のみ。日本語。推測禁止。',
    '候補は最大8件。keep=false も理由を付与する。',
    'schema:',
    safeJson({
      candidates: [
        {
          kind: 'lesson|rule|procedure|candidate',
          title: 'string',
          statement: 'string',
          keep: true,
          keepReason: 'string',
          confidence: 0.0,
          evidence: [{ kind: 'result', text: 'string' }],
        },
      ],
    }),
    'input:',
    safeJson(payload),
  ].join('\n');
}
