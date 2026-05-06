import type {
  SessionAction,
  SessionEvidence,
  SessionMessageInput,
  SessionTurnBlock,
} from './types.js';

const commandPattern = /\b(?:bun run|npm|pnpm|git|rg|drizzle-kit)\b[^\n]*/gi;
const filePattern = /(?:\/[\w./-]+|\b(?:src|apps|docs|test)\/[\w./-]+)/g;
const errorPattern = /(?:\bError:|\bfailed\b|MCP_HOST_ERROR|stack trace)/i;
const passPattern = /(?:\bpass\b|verify passed|0 fail|svelte-check|typecheck)/i;
const decisionPattern = /(別 table|自動登録しない|承認後に登録|昇格|keep|drop)/i;
const toolPattern =
  /\b(agentic_search|review_task|record_task_note|search_knowledge|memory_search|memory_fetch|doctor)\b/g;

function dedupeByText<T extends { text?: string; label?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = (item.text ?? item.label ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractMatches(pattern: RegExp, content: string): string[] {
  const matches = content.match(pattern);
  if (!matches) return [];
  return Array.from(new Set(matches.map((m) => m.trim()).filter(Boolean)));
}

function extractActionsFromMessage(message: SessionMessageInput): SessionAction[] {
  const actions: SessionAction[] = [];

  for (const command of extractMatches(commandPattern, message.content)) {
    actions.push({ kind: 'command', label: command, status: 'unknown' });
  }

  for (const toolName of extractMatches(toolPattern, message.content)) {
    actions.push({ kind: 'tool', label: toolName, status: 'unknown' });
  }

  for (const filePath of extractMatches(filePattern, message.content)) {
    actions.push({ kind: 'file_change', label: filePath, status: 'unknown' });
  }

  if (passPattern.test(message.content)) {
    actions.push({ kind: 'test', label: 'verification', status: 'succeeded' });
  }
  if (errorPattern.test(message.content)) {
    actions.push({ kind: 'test', label: 'verification', status: 'failed' });
  }

  return dedupeByText(actions);
}

function extractEvidenceFromMessage(message: SessionMessageInput): SessionEvidence[] {
  const evidence: SessionEvidence[] = [];

  if (errorPattern.test(message.content)) {
    evidence.push({
      kind: 'error',
      text: message.content.slice(0, 400),
      sourceMessageId: message.id,
    });
  }

  if (passPattern.test(message.content)) {
    evidence.push({
      kind: 'verification',
      text: message.content.slice(0, 400),
      sourceMessageId: message.id,
    });
  }

  if (decisionPattern.test(message.content)) {
    evidence.push({
      kind: 'decision',
      text: message.content.slice(0, 400),
      sourceMessageId: message.id,
    });
  }

  for (const filePath of extractMatches(filePattern, message.content)) {
    evidence.push({ kind: 'file', text: filePath, sourceMessageId: message.id });
  }

  for (const command of extractMatches(commandPattern, message.content)) {
    evidence.push({ kind: 'command_output', text: command, sourceMessageId: message.id });
  }

  return dedupeByText(evidence).slice(0, 12);
}

export function buildDeterministicEvidenceAndActions(turn: SessionTurnBlock): SessionTurnBlock {
  const actions = dedupeByText(turn.messages.flatMap(extractActionsFromMessage)).slice(0, 10);
  const evidence = dedupeByText(turn.messages.flatMap(extractEvidenceFromMessage)).slice(0, 12);

  return {
    ...turn,
    deterministicActions: actions,
    deterministicEvidence: evidence,
  };
}
