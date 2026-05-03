import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { filterSensitiveData } from '../utils/secretFilter.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface IngestFileCursor {
  offset: number;
  mtimeMs: number;
}

export type IngestCursor = Record<string, IngestFileCursor>;

export interface IngestResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  messages: ChatMessage[];
  cursor: IngestCursor;
  maxObservedMtimeMs: number;
}

interface ClaudeTextPart {
  type: 'text';
  text: string;
}

interface CodexTextPart {
  type?: string;
  text?: string;
}

function extractClaudeTextContent(raw: unknown): string {
  if (!Array.isArray(raw)) return '';

  return raw
    .filter(
      (part): part is ClaudeTextPart =>
        part !== null &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
}

function extractCodexTextContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';

  return raw
    .filter(
      (part): part is CodexTextPart =>
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasFsErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function isIgnorableOptionalFileError(error: unknown): boolean {
  return hasFsErrorCode(error, 'ENOENT') || hasFsErrorCode(error, 'ENOTDIR');
}

function parseClaudeJsonLine(line: string, filePath: string): ChatMessage | null {
  try {
    const data = JSON.parse(line) as {
      type?: unknown;
      message?: { content?: unknown };
    };
    if (data.type !== 'user' && data.type !== 'assistant') return null;

    const textContent = extractClaudeTextContent(data.message?.content);
    if (!textContent.trim()) return null;

    return {
      role: data.type,
      content: filterSensitiveData(textContent),
      metadata: {
        source: 'Claude Code',
        sourceId: 'claude_logs',
        sessionFile: filePath,
      },
    };
  } catch {
    return null;
  }
}

function parseCodexJsonLine(line: string, filePath: string): ChatMessage | null {
  try {
    const data = JSON.parse(line) as {
      timestamp?: unknown;
      type?: unknown;
      payload?: {
        type?: unknown;
        role?: unknown;
        content?: unknown;
        cwd?: unknown;
        id?: unknown;
      };
    };
    if (data.type !== 'response_item') return null;
    const payload = data.payload;
    if (!payload || payload.type !== 'message') return null;
    if (payload.role !== 'user' && payload.role !== 'assistant') return null;

    const textContent = extractCodexTextContent(payload.content);
    if (!textContent.trim()) return null;

    return {
      role: payload.role,
      content: filterSensitiveData(textContent),
      metadata: {
        source: 'Codex',
        sourceId: 'codex_logs',
        sessionFile: filePath,
        timestamp: typeof data.timestamp === 'string' ? data.timestamp : undefined,
      },
    };
  } catch {
    return null;
  }
}

function processClaudeJsonlDelta(
  filePath: string,
  content: string,
  startOffset: number,
): { messages: ChatMessage[]; nextOffset: number } {
  if (!content) return { messages: [], nextOffset: startOffset };

  const messages: ChatMessage[] = [];
  const endsWithNewline = content.endsWith('\n');

  let completeSegment = content;
  let trailingSegment = '';
  if (!endsWithNewline) {
    const lastNewlineIndex = content.lastIndexOf('\n');
    if (lastNewlineIndex >= 0) {
      completeSegment = content.slice(0, lastNewlineIndex + 1);
      trailingSegment = content.slice(lastNewlineIndex + 1);
    } else {
      completeSegment = '';
      trailingSegment = content;
    }
  }

  if (completeSegment) {
    const lines = completeSegment.split('\n').filter((line) => line.trim());
    for (const line of lines) {
      const parsed = parseClaudeJsonLine(line, filePath);
      if (parsed) messages.push(parsed);
    }
  }

  let consumedBytes = Buffer.byteLength(completeSegment, 'utf8');
  if (!endsWithNewline) {
    const trailingTrimmed = trailingSegment.trim();
    if (!trailingTrimmed) {
      consumedBytes += Buffer.byteLength(trailingSegment, 'utf8');
    } else {
      const parsedTrailing = parseClaudeJsonLine(trailingSegment, filePath);
      if (parsedTrailing) {
        messages.push(parsedTrailing);
        consumedBytes += Buffer.byteLength(trailingSegment, 'utf8');
      }
    }
  }

  return { messages, nextOffset: startOffset + consumedBytes };
}

function processCodexJsonlDelta(
  filePath: string,
  content: string,
  startOffset: number,
): { messages: ChatMessage[]; nextOffset: number } {
  if (!content) return { messages: [], nextOffset: startOffset };

  const messages: ChatMessage[] = [];
  const endsWithNewline = content.endsWith('\n');
  let completeSegment = content;
  let trailingSegment = '';
  if (!endsWithNewline) {
    const lastNewlineIndex = content.lastIndexOf('\n');
    if (lastNewlineIndex >= 0) {
      completeSegment = content.slice(0, lastNewlineIndex + 1);
      trailingSegment = content.slice(lastNewlineIndex + 1);
    } else {
      completeSegment = '';
      trailingSegment = content;
    }
  }

  if (completeSegment) {
    const lines = completeSegment.split('\n').filter((line) => line.trim());
    for (const line of lines) {
      const parsed = parseCodexJsonLine(line, filePath);
      if (parsed) messages.push(parsed);
    }
  }

  let consumedBytes = Buffer.byteLength(completeSegment, 'utf8');
  if (!endsWithNewline) {
    const trailingTrimmed = trailingSegment.trim();
    if (!trailingTrimmed) {
      consumedBytes += Buffer.byteLength(trailingSegment, 'utf8');
    } else {
      const parsedTrailing = parseCodexJsonLine(trailingSegment, filePath);
      if (parsedTrailing) {
        messages.push(parsedTrailing);
        consumedBytes += Buffer.byteLength(trailingSegment, 'utf8');
      }
    }
  }

  return { messages, nextOffset: startOffset + consumedBytes };
}

export function normalizeIngestCursor(raw: unknown): IngestCursor {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const normalized: IngestCursor = {};
  for (const [filePath, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const offset = Number((value as IngestFileCursor).offset);
    const mtimeMs = Number((value as IngestFileCursor).mtimeMs);
    normalized[filePath] = {
      offset: Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0,
      mtimeMs: Number.isFinite(mtimeMs) && mtimeMs >= 0 ? Math.floor(mtimeMs) : 0,
    };
  }

  return normalized;
}

async function readTextDelta(filePath: string, startOffset: number): Promise<string> {
  if (startOffset <= 0) {
    return fs.readFile(filePath, 'utf-8');
  }

  return await new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const stream = createReadStream(filePath, { start: startOffset, encoding: 'utf-8' });
    stream.on('data', (chunk) =>
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8')),
    );
    stream.on('end', () => resolve(chunks.join('')));
    stream.on('error', reject);
  });
}

export { filterSensitiveData } from '../utils/secretFilter.js';

/**
 * Claude Code の JSONL ログを解析します
 */
export async function ingestClaudeLogs(
  since?: Date,
  cursor: IngestCursor = {},
): Promise<IngestResult> {
  const claudeProjectsDir = config.claudeLogDir;
  const messages: ChatMessage[] = [];
  const fatalErrors: string[] = [];
  const warnings: string[] = [];
  const defaultLookbackHours = 24;
  const nextCursor = { ...normalizeIngestCursor(cursor) };
  let maxObservedMtimeMs = since ? since.getTime() : 0;

  try {
    const projects = await fs.readdir(claudeProjectsDir);
    const threshold = since ? since.getTime() : Date.now() - defaultLookbackHours * 60 * 60 * 1000;

    for (const project of projects) {
      const projectPath = path.join(claudeProjectsDir, project);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(projectPath);
      } catch (error) {
        warnings.push(`Claude project stat failed (${projectPath}): ${toErrorMessage(error)}`);
        continue;
      }
      if (!stat.isDirectory()) continue;

      let files: string[] = [];
      try {
        files = await fs.readdir(projectPath);
      } catch (error) {
        warnings.push(`Claude project read failed (${projectPath}): ${toErrorMessage(error)}`);
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = path.join(projectPath, file);
        try {
          const fStat = await fs.stat(filePath);
          maxObservedMtimeMs = Math.max(maxObservedMtimeMs, fStat.mtimeMs);
          const prev = nextCursor[filePath];

          // 初回のみ lookback 以前のファイルはスキップし、カーソルだけ現在サイズへ進める
          if (!prev && fStat.mtimeMs < threshold) {
            nextCursor[filePath] = { offset: fStat.size, mtimeMs: fStat.mtimeMs };
            continue;
          }

          let startOffset = prev?.offset ?? 0;
          if (startOffset > fStat.size) {
            // ログローテーション等でファイルが縮んだ場合は先頭から読み直す
            startOffset = 0;
          }
          if (startOffset === fStat.size) {
            nextCursor[filePath] = { offset: fStat.size, mtimeMs: fStat.mtimeMs };
            continue;
          }

          const content = await readTextDelta(filePath, startOffset);
          const deltaResult = processClaudeJsonlDelta(filePath, content, startOffset);
          messages.push(...deltaResult.messages);
          nextCursor[filePath] = { offset: deltaResult.nextOffset, mtimeMs: fStat.mtimeMs };
        } catch (error) {
          warnings.push(`Claude file ingest failed (${filePath}): ${toErrorMessage(error)}`);
        }
      }
    }
  } catch (err) {
    console.error('Claude logs ingestion failed:', err);
    fatalErrors.push(`Claude logs root ingest failed: ${toErrorMessage(err)}`);
  }

  return {
    ok: fatalErrors.length === 0,
    errors: fatalErrors,
    warnings,
    messages,
    cursor: nextCursor,
    maxObservedMtimeMs,
  };
}

/**
 * Antigravity の会話ログを解析します (overview.txt)
 */
export async function ingestAntigravityLogs(
  since?: Date,
  cursor: IngestCursor = {},
): Promise<IngestResult> {
  const antigravityDir = config.antigravityLogDir;
  const messages: ChatMessage[] = [];
  const fatalErrors: string[] = [];
  const warnings: string[] = [];
  const defaultLookbackHours = 24;
  const nextCursor = { ...normalizeIngestCursor(cursor) };
  let maxObservedMtimeMs = since ? since.getTime() : 0;

  try {
    const sessions = await fs.readdir(antigravityDir);
    const threshold = since ? since.getTime() : Date.now() - defaultLookbackHours * 60 * 60 * 1000;

    for (const session of sessions) {
      const logPath = path.join(
        antigravityDir,
        session,
        '.system_generated',
        'logs',
        'overview.txt',
      );

      try {
        const stat = await fs.stat(logPath);
        maxObservedMtimeMs = Math.max(maxObservedMtimeMs, stat.mtimeMs);
        const prev = nextCursor[logPath];

        if (!prev && stat.mtimeMs < threshold) {
          nextCursor[logPath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
          continue;
        }

        let startOffset = prev?.offset ?? 0;
        if (startOffset > stat.size) {
          startOffset = 0;
        }
        if (startOffset === stat.size) {
          nextCursor[logPath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
          continue;
        }

        const content = await readTextDelta(logPath, startOffset);
        // Antigravity の overview.txt は通常、エージェントとユーザーの対話記録
        // フォーマットに合わせてパース（ここでは簡易的に不純物を取り除くのみ）
        messages.push({
          role: 'assistant',
          content: filterSensitiveData(content),
          metadata: {
            source: 'Antigravity',
            sourceId: 'antigravity_logs',
            sessionFile: logPath,
          },
        });
        nextCursor[logPath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
      } catch (error) {
        if (isIgnorableOptionalFileError(error)) {
          continue;
        }
        warnings.push(`Antigravity file ingest failed (${logPath}): ${toErrorMessage(error)}`);
      }
    }
  } catch (err) {
    console.error('Antigravity logs ingestion failed:', err);
    fatalErrors.push(`Antigravity logs root ingest failed: ${toErrorMessage(err)}`);
  }

  return {
    ok: fatalErrors.length === 0,
    errors: fatalErrors,
    warnings,
    messages,
    cursor: nextCursor,
    maxObservedMtimeMs,
  };
}

async function listJsonlFilesRecursively(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isIgnorableOptionalFileError(error)) return;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(entryPath);
      }
    }
  }
  await visit(root);
  return files;
}

/**
 * Codex Desktop / CLI の JSONL セッションログを解析します。
 */
export async function ingestCodexLogs(
  since?: Date,
  cursor: IngestCursor = {},
): Promise<IngestResult> {
  const roots = [config.codexSessionDir, config.codexArchivedSessionDir].filter(
    (dir): dir is string => typeof dir === 'string' && dir.trim().length > 0,
  );
  const messages: ChatMessage[] = [];
  const fatalErrors: string[] = [];
  const warnings: string[] = [];
  const initialLookbackHours = Number(process.env.GNOSIS_CODEX_INITIAL_LOOKBACK_HOURS ?? '0');
  const nextCursor = { ...normalizeIngestCursor(cursor) };
  let maxObservedMtimeMs = since ? since.getTime() : 0;

  for (const root of roots) {
    let files: string[] = [];
    try {
      files = await listJsonlFilesRecursively(root);
    } catch (error) {
      warnings.push(`Codex root ingest failed (${root}): ${toErrorMessage(error)}`);
      continue;
    }

    const threshold = since
      ? since.getTime()
      : Number.isFinite(initialLookbackHours) && initialLookbackHours > 0
        ? Date.now() - initialLookbackHours * 60 * 60 * 1000
        : 0;
    for (const filePath of files) {
      try {
        const fStat = await fs.stat(filePath);
        maxObservedMtimeMs = Math.max(maxObservedMtimeMs, fStat.mtimeMs);
        const prev = nextCursor[filePath];

        if (!prev && fStat.mtimeMs < threshold) {
          nextCursor[filePath] = { offset: fStat.size, mtimeMs: fStat.mtimeMs };
          continue;
        }

        let startOffset = prev?.offset ?? 0;
        if (startOffset > fStat.size) {
          startOffset = 0;
        }
        if (startOffset === fStat.size) {
          nextCursor[filePath] = { offset: fStat.size, mtimeMs: fStat.mtimeMs };
          continue;
        }

        const content = await readTextDelta(filePath, startOffset);
        const deltaResult = processCodexJsonlDelta(filePath, content, startOffset);
        messages.push(...deltaResult.messages);
        nextCursor[filePath] = { offset: deltaResult.nextOffset, mtimeMs: fStat.mtimeMs };
      } catch (error) {
        warnings.push(`Codex file ingest failed (${filePath}): ${toErrorMessage(error)}`);
      }
    }
  }

  return {
    ok: fatalErrors.length === 0,
    errors: fatalErrors,
    warnings,
    messages,
    cursor: nextCursor,
    maxObservedMtimeMs,
  };
}
