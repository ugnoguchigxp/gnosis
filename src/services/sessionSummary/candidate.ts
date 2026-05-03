import type { KnowledgeCandidate, KnowledgeKind, SessionTurnBlock } from './types.js';

function summarizeText(value: string, max = 180): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

function detectKindFromText(text: string): KnowledgeKind {
  const lower = text.toLowerCase();
  // Treat raw command-like snippets as non-promotable candidates.
  if (/^\/[a-z0-9._-]+(?:\s|$)/i.test(text.trim())) return 'candidate';
  if (/\b(?:bun run|npm|pnpm|git|rg|drizzle-kit)\b/i.test(lower)) return 'candidate';
  if (/(must|should|always|never|禁止|必須|ルール|原則|方針)/i.test(lower)) return 'rule';
  if (/(手順|手続き|step|migrate|typecheck|verify)/i.test(lower)) return 'procedure';
  if (/(learn|lesson|教訓|原因|再発防止|失敗|成功)/i.test(lower)) return 'lesson';
  return 'candidate';
}

function isReusable(text: string): boolean {
  return /(rule|手順|verify|typecheck|migrate|原因|再発|判断|基準|must|should|always|never)/i.test(
    text,
  );
}

function isPureNoise(text: string): boolean {
  return /(ありがとう|了解|お願いします|進めます|done|ok|noted)/i.test(text);
}

function isCommandLike(text: string): boolean {
  const normalized = text.trim();
  if (/^\/[a-z0-9._-]+(?:\s|$)/i.test(normalized)) return true;
  return /\b(?:bun run|npm|pnpm|git|rg|drizzle-kit)\b/i.test(normalized);
}

export function buildDeterministicCandidates(turn: SessionTurnBlock): KnowledgeCandidate[] {
  const baseTexts = [
    ...turn.deterministicEvidence.map((e) => e.text),
    ...turn.deterministicActions.map((a) => a.label),
  ].filter((text) => text.trim().length > 0);

  if (baseTexts.length === 0) {
    return [
      {
        turnIndex: turn.turnIndex,
        kind: 'candidate',
        title: summarizeText(turn.deterministicIntent, 60) || '候補なし',
        statement: summarizeText(turn.userContent || turn.deterministicIntent, 220),
        keep: false,
        keepReason: 'evidence不足',
        evidence: [],
        actions: [],
        confidence: 0.2,
        status: 'deterministic',
      },
    ];
  }

  const candidates: KnowledgeCandidate[] = [];
  for (const text of baseTexts.slice(0, 8)) {
    const statement = summarizeText(text, 220);
    const kind = detectKindFromText(statement);
    const commandLike = isCommandLike(statement);
    const reusable = isReusable(statement);
    const keep = !isPureNoise(statement) && !commandLike && (reusable || kind !== 'candidate');
    const confidence = commandLike
      ? 0.2
      : keep
        ? 0.78
        : kind === 'candidate' && reusable
          ? 0.72
          : 0.35;
    candidates.push({
      turnIndex: turn.turnIndex,
      kind,
      title: summarizeText(statement, 60),
      statement,
      keep,
      keepReason: keep ? '再利用性あり' : '一過性または文脈依存',
      evidence: turn.deterministicEvidence,
      actions: turn.deterministicActions,
      confidence,
      status: 'deterministic',
    });
  }

  return candidates;
}
