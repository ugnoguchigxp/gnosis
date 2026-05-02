import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { vibeMemories } from '../db/schema.js';
import { filterSensitiveData } from '../utils/secretFilter.js';

type VibeMemoryRow = typeof vibeMemories.$inferSelect;

type SessionSummary = {
  id: string;
  title: string;
  source: string;
  sourceId: string | null;
  sessionFile: string | null;
  memorySessionId: string;
  chunkCount: number;
  messageCount: number;
  roles: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  preview: string;
};

type SessionMessage = {
  id: string;
  role: 'user' | 'assistant' | 'unknown';
  content: string;
  createdAt: string;
  source: string;
  chunkId: string;
};

type SessionDetail = {
  summary: SessionSummary;
  messages: SessionMessage[];
};

type MutableSessionGroup = SessionSummary & {
  firstSeenTime: number;
  lastSeenTime: number;
  titleCandidate: string | null;
  titleCandidateTime: number | null;
};

const AGENT_LOG_KIND = 'agent_log_chunk';
const FALLBACK_SESSION_PREFIX = 'memory:';
const SESSION_LIST_LIMIT = 500;
const SESSION_DETAIL_LIMIT = 200;

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing or invalid ${name}`);
  }
  return value.trim();
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function metadataStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item, index, values) => item.length > 0 && values.indexOf(item) === index);
}

function createdAtTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function createdAtIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function metadataTimestamp(metadata: Record<string, unknown>): string | null {
  const value = metadataString(metadata, 'timestamp');
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function rowObservedTime(row: VibeMemoryRow, metadata: Record<string, unknown>): number {
  const timestamp = metadataTimestamp(metadata);
  return timestamp ? new Date(timestamp).getTime() : createdAtTime(row.createdAt);
}

function rowObservedIso(row: VibeMemoryRow, metadata: Record<string, unknown>): string {
  return metadataTimestamp(metadata) ?? createdAtIso(row.createdAt);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function removeTranscriptRolePrefix(value: string): string {
  return value.replace(/^(USER|ASSISTANT):\s*/, '');
}

function parseLogTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function roleFromStructuredLog(value: Record<string, unknown>, fallback: SessionMessage['role']) {
  const source = typeof value.source === 'string' ? value.source : '';
  const type = typeof value.type === 'string' ? value.type : '';
  if (source.includes('USER') || type === 'USER_INPUT') return 'user';
  if (source.includes('MODEL') || source.includes('ASSISTANT')) return 'assistant';
  return fallback;
}

function extractTaggedContent(value: string, tagName: string): string | null {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`);
  const match = value.match(pattern);
  const content = match?.[1]?.trim();
  return content && content.length > 0 ? content : null;
}

function cleanStructuredLogContent(value: string): string {
  return extractTaggedContent(value, 'USER_REQUEST') ?? value.trim();
}

function extractRequestBody(value: string): string {
  const requestMatch = value.match(/(?:^|\n)#{0,3}\s*My request for Codex:\s*([\s\S]*)/i);
  const taggedRequest = extractTaggedContent(value, 'USER_REQUEST');
  return (requestMatch?.[1] ?? taggedRequest ?? value).trim();
}

function isContextOnlyUserContent(value: string): boolean {
  const normalized = normalizeWhitespace(value).toLowerCase();
  return (
    normalized.startsWith('# agents.md instructions') ||
    normalized.startsWith('<environment_context>') ||
    normalized.startsWith('<collaboration_mode>') ||
    normalized.startsWith('<turn_')
  );
}

function titleCandidateFromUserContent(value: string): string | null {
  const body = extractRequestBody(value);
  if (body === value.trim() && isContextOnlyUserContent(value)) return null;

  const lines = body
    .split('\n')
    .map((line) => normalizeWhitespace(line).replace(/^#{1,6}\s*/, ''))
    .filter((line) => {
      const lower = line.toLowerCase();
      return (
        line.length > 0 &&
        !lower.startsWith('files mentioned by the user') &&
        !lower.startsWith('<image ') &&
        !lower.startsWith('<turn_')
      );
    });
  const candidate = normalizeWhitespace(lines[0] ?? body);
  return candidate.length > 0 ? candidate : null;
}

function titleCandidateFromMessages(messages: SessionMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const candidate = titleCandidateFromUserContent(message.content);
    if (candidate) return candidate;
  }
  return null;
}

function titleFromCandidate(candidate: string | null, fallback: string): string {
  return candidate ? truncate(candidate, 160) : fallback;
}

function parseStructuredLogMessages(
  rawContent: string,
  options: {
    idPrefix: string;
    fallbackRole: SessionMessage['role'];
    fallbackCreatedAt: string;
    fallbackSource: string;
    chunkId: string;
  },
): SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (const [index, line] of rawContent.split('\n').entries()) {
    const normalizedLine = removeTranscriptRolePrefix(line).trim();
    if (!normalizedLine.startsWith('{') || !normalizedLine.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(normalizedLine) as Record<string, unknown>;
      if (typeof parsed.content !== 'string' || parsed.content.trim().length === 0) continue;
      const content = cleanStructuredLogContent(parsed.content);
      messages.push({
        id: `${options.idPrefix}:log:${index}`,
        role: roleFromStructuredLog(parsed, options.fallbackRole),
        content: filterSensitiveData(content),
        createdAt: parseLogTimestamp(parsed.created_at, options.fallbackCreatedAt),
        source: options.fallbackSource,
        chunkId: options.chunkId,
      });
    } catch {}
  }
  return messages;
}

function previewContent(row: VibeMemoryRow, source: string, createdAt: string): string {
  const structuredMessages = parseStructuredLogMessages(row.content, {
    idPrefix: row.id,
    fallbackRole: 'unknown',
    fallbackCreatedAt: createdAt,
    fallbackSource: source,
    chunkId: row.id,
  });
  return structuredMessages[0]?.content ?? row.content;
}

function sessionTitle(sessionFile: string | null, source: string, memorySessionId: string): string {
  if (!sessionFile) {
    return `${source} / ${memorySessionId}`;
  }
  return path.basename(sessionFile).replace(/\.jsonl$/i, '');
}

function sourceForRow(row: VibeMemoryRow, metadata: Record<string, unknown>): string {
  return metadataString(metadata, 'source') ?? row.sourceTask ?? 'Vibe Memory';
}

function sourceIdForRow(metadata: Record<string, unknown>): string | null {
  return metadataString(metadata, 'sourceId');
}

function rolesForRow(metadata: Record<string, unknown>): string[] {
  return metadataStringArray(metadata, 'roles');
}

function messageCountForRow(metadata: Record<string, unknown>): number {
  const value = metadata.messageCount;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function sessionFilesForRow(metadata: Record<string, unknown>): string[] {
  const sessionFile = metadataString(metadata, 'sessionFile');
  const sessionFiles = metadataStringArray(metadata, 'sessionFiles');
  return sessionFiles.length > 0 ? sessionFiles : sessionFile ? [sessionFile] : [];
}

function fallbackSessionId(row: VibeMemoryRow, metadata: Record<string, unknown>): string {
  const sourceId = sourceIdForRow(metadata) ?? 'unknown';
  return `${FALLBACK_SESSION_PREFIX}${sourceId}:${row.sessionId}`;
}

function sessionIdsForRow(row: VibeMemoryRow, metadata: Record<string, unknown>): string[] {
  const sessionFiles = sessionFilesForRow(metadata);
  return sessionFiles.length > 0 ? sessionFiles : [fallbackSessionId(row, metadata)];
}

function sessionFileFromId(id: string): string | null {
  return id.startsWith(FALLBACK_SESSION_PREFIX) ? null : id;
}

function summarizeRows(rows: VibeMemoryRow[]): SessionSummary[] {
  const groups = new Map<string, MutableSessionGroup>();

  for (const row of rows) {
    const metadata = metadataRecord(row.metadata);
    const source = sourceForRow(row, metadata);
    const sourceId = sourceIdForRow(metadata);
    const roles = rolesForRow(metadata);
    const messageCount = messageCountForRow(metadata);
    const rowTime = rowObservedTime(row, metadata);
    const rowIso = rowObservedIso(row, metadata);
    const rowTitleCandidate = titleCandidateFromMessages(parseTranscript(row));

    for (const id of sessionIdsForRow(row, metadata)) {
      const sessionFile = sessionFileFromId(id);
      const existing = groups.get(id);
      if (!existing) {
        const fallbackTitle = sessionTitle(sessionFile, source, row.sessionId);
        groups.set(id, {
          id,
          title: titleFromCandidate(rowTitleCandidate, fallbackTitle),
          source,
          sourceId,
          sessionFile,
          memorySessionId: row.sessionId,
          chunkCount: 1,
          messageCount,
          roles,
          firstSeenAt: rowIso,
          lastSeenAt: rowIso,
          firstSeenTime: rowTime,
          lastSeenTime: rowTime,
          titleCandidate: rowTitleCandidate,
          titleCandidateTime: rowTitleCandidate ? rowTime : null,
          preview: truncate(previewContent(row, source, rowIso), 180),
        });
        continue;
      }

      existing.chunkCount += 1;
      existing.messageCount += messageCount;
      existing.roles = Array.from(new Set([...existing.roles, ...roles]));
      if (
        rowTitleCandidate &&
        (existing.titleCandidateTime === null || rowTime < existing.titleCandidateTime)
      ) {
        existing.titleCandidate = rowTitleCandidate;
        existing.titleCandidateTime = rowTime;
        existing.title = titleFromCandidate(
          rowTitleCandidate,
          sessionTitle(existing.sessionFile, existing.source, existing.memorySessionId),
        );
      }
      if (rowTime < existing.firstSeenTime) {
        existing.firstSeenAt = rowIso;
        existing.firstSeenTime = rowTime;
      }
      if (rowTime > existing.lastSeenTime) {
        existing.lastSeenAt = rowIso;
        existing.lastSeenTime = rowTime;
        existing.preview = truncate(previewContent(row, source, rowIso), 180);
      }
    }
  }

  return Array.from(groups.values())
    .sort((a, b) => b.lastSeenTime - a.lastSeenTime)
    .map(
      ({
        firstSeenTime: _firstSeenTime,
        lastSeenTime: _lastSeenTime,
        titleCandidate: _titleCandidate,
        titleCandidateTime: _titleCandidateTime,
        ...summary
      }) => summary,
    );
}

function parseFallbackSessionId(sessionId: string): { sourceId: string; memorySessionId: string } {
  const rest = sessionId.slice(FALLBACK_SESSION_PREFIX.length);
  const separatorIndex = rest.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === rest.length - 1) {
    throw new Error(`Invalid fallback session id: ${sessionId}`);
  }
  return {
    sourceId: rest.slice(0, separatorIndex),
    memorySessionId: rest.slice(separatorIndex + 1),
  };
}

function sessionDetailWhere(sessionId: string) {
  if (sessionId.startsWith(FALLBACK_SESSION_PREFIX)) {
    const parsed = parseFallbackSessionId(sessionId);
    return and(
      eq(vibeMemories.sessionId, parsed.memorySessionId),
      sql`${vibeMemories.metadata}->>'sourceId' = ${parsed.sourceId}`,
      sql`${vibeMemories.metadata}->>'kind' = ${AGENT_LOG_KIND}`,
    );
  }

  return and(
    sql`${vibeMemories.metadata}->>'kind' = ${AGENT_LOG_KIND}`,
    sql`(
      ${vibeMemories.metadata}->>'sessionFile' = ${sessionId}
      OR (${vibeMemories.metadata}->'sessionFiles') @> ${JSON.stringify([sessionId])}::jsonb
    )`,
  );
}

function parseTranscript(row: VibeMemoryRow): SessionMessage[] {
  const metadata = metadataRecord(row.metadata);
  const source = sourceForRow(row, metadata);
  const createdAt = rowObservedIso(row, metadata);
  const matches = Array.from(row.content.matchAll(/(?:^|\n\n)(USER|ASSISTANT): /g));

  if (matches.length === 0) {
    const structuredMessages = parseStructuredLogMessages(row.content, {
      idPrefix: row.id,
      fallbackRole: 'unknown',
      fallbackCreatedAt: createdAt,
      fallbackSource: source,
      chunkId: row.id,
    });
    if (structuredMessages.length > 0) return structuredMessages;

    return [
      {
        id: `${row.id}:0`,
        role: 'unknown',
        content: row.content.trim(),
        createdAt,
        source,
        chunkId: row.id,
      },
    ];
  }

  return matches
    .flatMap((match, index) => {
      const role: SessionMessage['role'] = match[1] === 'USER' ? 'user' : 'assistant';
      const start = (match.index ?? 0) + match[0].length;
      const end = matches[index + 1]?.index ?? row.content.length;
      const content = row.content.slice(start, end).trim();
      const structuredMessages = parseStructuredLogMessages(content, {
        idPrefix: `${row.id}:${index}`,
        fallbackRole: role,
        fallbackCreatedAt: createdAt,
        fallbackSource: source,
        chunkId: row.id,
      });
      if (structuredMessages.length > 0) return structuredMessages;
      return [
        {
          id: `${row.id}:${index}`,
          role,
          content,
          createdAt,
          source,
          chunkId: row.id,
        },
      ];
    })
    .filter((message) => message.content.length > 0);
}

function extractCodexTextContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';

  return raw
    .filter(
      (part): part is { type?: unknown; text?: string } =>
        part !== null &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string' &&
        ['input_text', 'output_text', 'text', 'summary_text'].includes(
          String((part as { type?: unknown }).type ?? 'text'),
        ),
    )
    .map((part) => part.text ?? '')
    .join('\n');
}

function parseCodexSessionMessageLine(
  summary: SessionSummary,
  line: string,
  index: number,
): SessionMessage | null {
  if (!line.trim()) return null;

  try {
    const data = JSON.parse(line) as {
      timestamp?: unknown;
      type?: unknown;
      payload?: {
        type?: unknown;
        role?: unknown;
        content?: unknown;
      };
    };
    if (data.type !== 'response_item') return null;
    const payload = data.payload;
    if (!payload || payload.type !== 'message') return null;
    if (payload.role !== 'user' && payload.role !== 'assistant') return null;

    const messageContent = filterSensitiveData(extractCodexTextContent(payload.content));
    if (!messageContent.trim()) return null;

    const timestamp =
      typeof data.timestamp === 'string' && Number.isFinite(new Date(data.timestamp).getTime())
        ? new Date(data.timestamp).toISOString()
        : summary.lastSeenAt;

    return {
      id: `${summary.sessionFile ?? summary.id}:${index}`,
      role: payload.role,
      content: messageContent,
      createdAt: timestamp,
      source: summary.source,
      chunkId: summary.sessionFile ?? summary.id,
    };
  } catch {
    return null;
  }
}

async function readCodexSessionTitleCandidate(summary: SessionSummary): Promise<string | null> {
  if (!summary.sessionFile) return null;

  try {
    const lines = createInterface({
      input: createReadStream(summary.sessionFile, { encoding: 'utf8' }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    let index = 0;
    for await (const line of lines) {
      const message = parseCodexSessionMessageLine(summary, line, index);
      index += 1;
      if (message?.role !== 'user') continue;

      const candidate = titleCandidateFromUserContent(message.content);
      if (candidate) {
        lines.close();
        return candidate;
      }
    }
  } catch {}

  return null;
}

async function readCodexSessionMessages(summary: SessionSummary): Promise<SessionMessage[]> {
  if (!summary.sessionFile) return [];

  let content = '';
  try {
    content = await fs.readFile(summary.sessionFile, 'utf8');
  } catch {
    return [];
  }

  const messages: SessionMessage[] = [];
  for (const [index, line] of content.split('\n').entries()) {
    const message = parseCodexSessionMessageLine(summary, line, index);
    if (message) messages.push(message);
  }

  return messages;
}

function summaryWithMessages(summary: SessionSummary, messages: SessionMessage[]): SessionSummary {
  if (messages.length === 0) return summary;
  const titleCandidate = titleCandidateFromMessages(messages);
  return {
    ...summary,
    title: titleFromCandidate(titleCandidate, summary.title),
    messageCount: messages.length,
    roles: Array.from(new Set(messages.map((message) => message.role))),
    firstSeenAt: messages[0]?.createdAt ?? summary.firstSeenAt,
    lastSeenAt: messages[messages.length - 1]?.createdAt ?? summary.lastSeenAt,
    preview: truncate(messages[0]?.content ?? summary.preview, 180),
  };
}

function needsSessionFileTitle(summary: SessionSummary): boolean {
  if (!summary.sessionFile) return false;
  return (
    summary.title === sessionTitle(summary.sessionFile, summary.source, summary.memorySessionId)
  );
}

async function enrichSessionFileTitles(summaries: SessionSummary[]): Promise<SessionSummary[]> {
  const enriched: SessionSummary[] = [];

  for (const summary of summaries) {
    if (!needsSessionFileTitle(summary)) {
      enriched.push(summary);
      continue;
    }

    const titleCandidate = await readCodexSessionTitleCandidate(summary);
    enriched.push({
      ...summary,
      title: titleFromCandidate(titleCandidate, summary.title),
    });
  }

  return enriched;
}

async function listSessions(): Promise<SessionSummary[]> {
  const rows = await db
    .select()
    .from(vibeMemories)
    .where(sql`${vibeMemories.metadata}->>'kind' = ${AGENT_LOG_KIND}`)
    .orderBy(desc(vibeMemories.createdAt))
    .limit(SESSION_LIST_LIMIT);

  return enrichSessionFileTitles(summarizeRows(rows));
}

async function getSession(sessionId: string): Promise<SessionDetail> {
  const rows = await db
    .select()
    .from(vibeMemories)
    .where(sessionDetailWhere(sessionId))
    .orderBy(asc(vibeMemories.createdAt))
    .limit(SESSION_DETAIL_LIMIT);

  if (rows.length === 0) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const [summary] = summarizeRows(rows).filter((item) => item.id === sessionId);
  if (!summary) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const fileMessages = await readCodexSessionMessages(summary);
  const messages = fileMessages.length > 0 ? fileMessages : rows.flatMap(parseTranscript);

  return {
    summary: summaryWithMessages(summary, messages),
    messages,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'list') {
    console.log(JSON.stringify(await listSessions(), null, 2));
    return;
  }

  if (command === 'detail') {
    const sessionId = requireString(args[1], 'session id');
    console.log(JSON.stringify(await getSession(sessionId), null, 2));
    return;
  }

  throw new Error('Usage: bun run src/scripts/monitor-sessions.ts <list|detail> [session-id]');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
