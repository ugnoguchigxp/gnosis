import type { SessionMessageInput, SessionTurnBlock } from './types.js';

const CONTEXT_PREFIXES = [
  '# agents.md instructions',
  '<environment_context>',
  '<collaboration_mode>',
  '<turn_',
];

function normalizeTime(value?: string): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripContextNoise(value: string): string {
  const lines = value
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => {
      const lower = line.trim().toLowerCase();
      return !CONTEXT_PREFIXES.some((prefix) => lower.startsWith(prefix));
    });
  return lines.join('\n').trim();
}

function isContextOnlyMessage(value: string): boolean {
  const normalized = normalizeWhitespace(stripContextNoise(value)).toLowerCase();
  if (!normalized) return true;
  return CONTEXT_PREFIXES.some((prefix) => normalized === prefix);
}

function intentFromUserContent(userContent: string): string {
  const cleaned = stripContextNoise(userContent);
  if (!cleaned) return 'ユーザー依頼の抽出に失敗';
  const firstLine = cleaned
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? normalizeWhitespace(firstLine) : normalizeWhitespace(cleaned);
}

function toIsoOrUndefined(value?: string): string | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function toSessionMessageInputs(
  messages: Array<{
    id: string;
    role: 'user' | 'assistant' | 'unknown';
    content: string;
    createdAt: string;
  }>,
): SessionMessageInput[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  }));
}

export function splitSessionTurns(messages: SessionMessageInput[]): SessionTurnBlock[] {
  const sorted = [...messages].sort((a, b) => {
    const timeDiff = normalizeTime(a.createdAt) - normalizeTime(b.createdAt);
    if (timeDiff !== 0) return timeDiff;
    return (a.id ?? '').localeCompare(b.id ?? '');
  });

  const turns: SessionTurnBlock[] = [];
  let current: SessionTurnBlock | null = null;

  for (const message of sorted) {
    const content = message.content.trim();
    if (content.length === 0) continue;

    const isUser = message.role === 'user';
    if (isUser) {
      if (current) turns.push(current);
      const cleaned = stripContextNoise(content);
      current = {
        turnIndex: turns.length,
        userMessageId: message.id,
        userContent: cleaned || content,
        messages: [],
        startedAt: toIsoOrUndefined(message.createdAt),
        endedAt: toIsoOrUndefined(message.createdAt),
        deterministicIntent: intentFromUserContent(content),
        deterministicEvidence: [],
        deterministicActions: [],
      };
      if (!isContextOnlyMessage(content)) {
        current.messages.push({ ...message, content: cleaned || content });
      }
      continue;
    }

    if (!current) {
      current = {
        turnIndex: 0,
        userMessageId: undefined,
        userContent: '',
        messages: [],
        startedAt: toIsoOrUndefined(message.createdAt),
        endedAt: toIsoOrUndefined(message.createdAt),
        deterministicIntent: 'system/log only session',
        deterministicEvidence: [],
        deterministicActions: [],
      };
    }

    const cleaned = stripContextNoise(content);
    if (cleaned.length === 0) continue;
    current.messages.push({ ...message, content: cleaned });
    current.startedAt = current.startedAt ?? toIsoOrUndefined(message.createdAt);
    current.endedAt = toIsoOrUndefined(message.createdAt) ?? current.endedAt;
  }

  if (current) turns.push(current);

  return turns.map((turn, index) => ({
    ...turn,
    turnIndex: index,
  }));
}
