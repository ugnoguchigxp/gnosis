import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ingestAntigravityLogs,
  ingestClaudeLogs,
  normalizeIngestCursor,
} from '../src/services/ingest';

// config の一部をモックして一時ディレクトリを指すようにする
const tmpBase = path.join(os.tmpdir(), `gnosis-ingest-test-${Date.now()}`);
const claudeLogDir = path.join(tmpBase, 'claude');
const antigravityLogDir = path.join(tmpBase, 'antigravity');

mock.module('../src/config.js', () => ({
  config: {
    claudeLogDir,
    antigravityLogDir,
  },
}));

describe('ingest service', () => {
  beforeEach(async () => {
    await fs.mkdir(tmpBase, { recursive: true });
    await fs.mkdir(claudeLogDir, { recursive: true });
    await fs.mkdir(antigravityLogDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  describe('normalizeIngestCursor', () => {
    it('normalizes valid cursor', () => {
      const raw = { 'file.txt': { offset: 100, mtimeMs: 123456 } };
      const normalized = normalizeIngestCursor(raw);
      expect(normalized['file.txt']).toEqual({ offset: 100, mtimeMs: 123456 });
    });

    it('handles invalid values with defaults', () => {
      const raw = { 'bad.txt': { offset: 'bad', mtimeMs: -1 } };
      const normalized = normalizeIngestCursor(raw);
      expect(normalized['bad.txt']).toEqual({ offset: 0, mtimeMs: 0 });
    });
  });

  describe('ingestClaudeLogs', () => {
    it('ingests messages from JSONL files', async () => {
      const projectDir = path.join(claudeLogDir, 'project-1');
      await fs.mkdir(projectDir, { recursive: true });

      const logFile = path.join(projectDir, 'log.jsonl');
      const content = `${[
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hi' }] },
        }),
      ].join('\n')}\n`;

      await fs.writeFile(logFile, content);

      const result = await ingestClaudeLogs();
      expect(result.ok).toBe(true);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toEqual({ role: 'user', content: 'hello' });
      expect(result.messages[1]).toEqual({ role: 'assistant', content: 'hi' });
      expect(result.cursor[logFile].offset).toBeGreaterThan(0);
    });

    it('respects cursor offset to avoid duplicates', async () => {
      const projectDir = path.join(claudeLogDir, 'p1');
      await fs.mkdir(projectDir, { recursive: true });
      const logFile = path.join(projectDir, 'log.jsonl');

      const line1 = `${JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'l1' }] },
      })}\n`;
      const line2 = `${JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'l2' }] },
      })}\n`;

      await fs.writeFile(logFile, line1 + line2);
      const offset1 = Buffer.byteLength(line1, 'utf8');

      const result = await ingestClaudeLogs(undefined, {
        [logFile]: { offset: offset1, mtimeMs: 0 },
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('l2');
    });
  });

  describe('ingestAntigravityLogs', () => {
    it('ingests messages from overview.txt', async () => {
      const sessionDir = path.join(antigravityLogDir, 'session-abc', '.system_generated', 'logs');
      await fs.mkdir(sessionDir, { recursive: true });

      const overviewFile = path.join(sessionDir, 'overview.txt');
      await fs.writeFile(overviewFile, 'Conversation content');

      const result = await ingestAntigravityLogs();
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('Conversation content');
      expect(result.cursor[overviewFile].offset).toBe(
        Buffer.byteLength('Conversation content', 'utf8'),
      );
    });

    it('skips missing optional files', async () => {
      await fs.mkdir(path.join(antigravityLogDir, 'empty-session'), { recursive: true });
      const result = await ingestAntigravityLogs();
      expect(result.ok).toBe(true);
      expect(result.messages).toHaveLength(0);
    });
  });
});
