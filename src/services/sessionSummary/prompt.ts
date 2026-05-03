import type { KnowledgeCandidate, SessionTurnBlock } from './types.js';

export const SESSION_DISTILLATION_PROMPT_VERSION = 'session-distill-v2';

function safeJson<T>(value: T): string {
  return JSON.stringify(value, null, 2);
}

export function buildTurnCandidatePrompt(
  turn: SessionTurnBlock,
  candidates: KnowledgeCandidate[],
): string {
  const payload = {
    systemContext: {
      policy: [
        'コマンド実行ログ（例: /shell, bun run, npm, pnpm, git, rg など）を知識候補として推奨しない。',
        '操作ログの言い換えではなく、再利用可能な判断基準・教訓・手順の質を優先する。',
      ],
    },
    userIntent: turn.deterministicIntent,
    userContent: turn.userContent,
    messages: turn.messages.map((message) => ({
      role: message.role,
      content: message.content.slice(0, 280),
    })),
    deterministicActions: turn.deterministicActions,
    deterministicEvidence: turn.deterministicEvidence,
    deterministicCandidates: candidates.map((candidate, index) => ({
      index: index + 1,
      kind: candidate.kind,
      title: candidate.title,
      statement: candidate.statement,
      keep: candidate.keep,
      keepReason: candidate.keepReason,
      confidence: candidate.confidence,
    })),
  };

  return [
    '以下の turn 情報から、既存候補の confidence だけを再評価してください。',
    '候補の kind/title/statement/keep は変更しないでください。',
    '出力はプレーンテキストのみ。JSON禁止。推測禁止。',
    '形式:',
    '1: confidence=0.78 reason=短い理由',
    '2: confidence=0.32 reason=短い理由',
    '...',
    'confidence は 0.00-1.00 の範囲。',
    'input:',
    safeJson(payload),
  ].join('\n');
}
