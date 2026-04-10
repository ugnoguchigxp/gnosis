import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface IngestFileCursor {
  offset: number;
  mtimeMs: number;
}

export type IngestCursor = Record<string, IngestFileCursor>;

export interface IngestResult {
  messages: ChatMessage[];
  cursor: IngestCursor;
  maxObservedMtimeMs: number;
}

interface ClaudeTextPart {
  type: 'text';
  text: string;
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
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(chunks.join('')));
    stream.on('error', reject);
  });
}

/**
 * 機密情報（APIキー、トークン、パスワード等）を検知し、
 * そのブロックを完全に排除します。
 */
export function filterSensitiveData(text: string): string {
  // 一般的な機密情報のパターン
  const sensitivePatterns = [
    /export\s+[A-Z_]*PASSWORD=.*$/gim,
    /export\s+[A-Z_]*TOKEN=.*$/gim,
    /export\s+[A-Z_]*KEY=.*$/gim,
    /([a-zA-Z0-9]{32,})/g, // 長いランダム文字列(キーの可能性)
    /xox[baprs]-.*$/gm, // Slackトークン
    /ghp_.*$/gm, // GitHubトークン
  ];

  let filtered = text;
  for (const pattern of sensitivePatterns) {
    // マスキングではなく、空文字に置換して消去
    filtered = filtered.replace(pattern, '[REMOVED SENSITIVE DATA]');
  }

  // ユーザーの要望に基づき、パスワード等の単語を含む行を物理的に削る
  const lines = filtered.split('\n');
  const cleanLines = lines.filter((line) => {
    const lower = line.toLowerCase();
    return (
      !lower.includes('password') && !lower.includes('secret_key') && !lower.includes('auth_token')
    );
  });

  return cleanLines.join('\n');
}

/**
 * Claude Code の JSONL ログを解析します
 */
export async function ingestClaudeLogs(
  since?: Date,
  cursor: IngestCursor = {},
): Promise<IngestResult> {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  const messages: ChatMessage[] = [];
  const defaultLookbackHours = 24;
  const nextCursor = { ...normalizeIngestCursor(cursor) };
  let maxObservedMtimeMs = since ? since.getTime() : 0;

  try {
    const projects = await fs.readdir(claudeProjectsDir);
    const now = Date.now();
    const threshold = since ? since.getTime() : now - defaultLookbackHours * 60 * 60 * 1000;

    for (const project of projects) {
      const projectPath = path.join(claudeProjectsDir, project);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(projectPath);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = path.join(projectPath, file);
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
        const lines = content.split('\n').filter((line) => line.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line) as {
              type?: unknown;
              message?: { content?: unknown };
            };
            if (data.type === 'user' || data.type === 'assistant') {
              const role = data.type;
              const textContent = extractClaudeTextContent(data.message?.content);

              if (textContent) {
                messages.push({ role, content: filterSensitiveData(textContent) });
              }
            }
          } catch (e) {
            // ignore malformed lines
          }
        }

        nextCursor[filePath] = { offset: fStat.size, mtimeMs: fStat.mtimeMs };
      }
    }
  } catch (err) {
    console.error('Claude logs ingestion failed:', err);
  }

  return { messages, cursor: nextCursor, maxObservedMtimeMs };
}

/**
 * Antigravity の会話ログを解析します (overview.txt)
 */
export async function ingestAntigravityLogs(
  since?: Date,
  cursor: IngestCursor = {},
): Promise<IngestResult> {
  const antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  const messages: ChatMessage[] = [];
  const defaultLookbackHours = 24;
  const nextCursor = { ...normalizeIngestCursor(cursor) };
  let maxObservedMtimeMs = since ? since.getTime() : 0;

  try {
    const sessions = await fs.readdir(antigravityDir);
    const now = Date.now();
    const threshold = since ? since.getTime() : now - defaultLookbackHours * 60 * 60 * 1000;

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
        messages.push({ role: 'assistant', content: filterSensitiveData(content) });
        nextCursor[logPath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
      } catch (e) {
        // file not found or other error
      }
    }
  } catch (err) {
    console.error('Antigravity logs ingestion failed:', err);
  }

  return { messages, cursor: nextCursor, maxObservedMtimeMs };
}
