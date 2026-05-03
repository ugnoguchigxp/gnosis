import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ingestAntigravityLogs,
  ingestClaudeLogs,
  ingestCodexLogs,
  normalizeIngestCursor,
} from '../src/services/ingest';

// config の一部をモックして一時ディレクトリを指すようにする
const tmpBase = path.join(os.tmpdir(), `gnosis-ingest-test-${Date.now()}`);
const claudeLogDir = path.join(tmpBase, 'claude');
const antigravityLogDir = path.join(tmpBase, 'antigravity');
const codexSessionDir = path.join(tmpBase, 'codex', 'sessions');
const codexArchivedSessionDir = path.join(tmpBase, 'codex', 'archived_sessions');

mock.module('../src/config.js', () => ({
  config: {
    claudeLogDir,
    antigravityLogDir,
    codexSessionDir,
    codexArchivedSessionDir,
    embedCommand: 'mock-embed',
    embedTimeoutMs: 1000,
    embeddingDimension: 384,
    dedupeThreshold: 0.9,
    llmTimeoutMs: 90_000,
    memory: {
      retries: 1,
      retryWaitMultiplier: 0.01,
    },
    graph: {
      similarityThreshold: 0.8,
      maxPathHops: 5,
    },
    knowflow: {
      llm: {
        apiBaseUrl: 'http://localhost:44448',
        apiPath: '/v1/chat/completions',
        apiKeyEnv: 'LOCAL_LLM_API_KEY',
        model: 'test-model',
        temperature: 0,
        timeoutMs: 5000,
        maxRetries: 1,
        retryDelayMs: 0,
        enableCliFallback: true,
        cliCommand: 'echo',
        cliPromptMode: 'arg',
        cliPromptPlaceholder: '{{prompt}}',
      },
      worker: {
        taskTimeoutMs: 5000,
        pollIntervalMs: 1000,
        postTaskDelayMs: 0,
        maxConsecutiveErrors: 3,
        maxQueriesPerTask: 3,
        cronRunWindowMs: 3_600_000,
      },
      budget: { userBudget: 12, cronBudget: 6, cronRunBudget: 30 },
      healthCheck: { timeoutMs: 5000 },
    },
    guidance: {
      inboxDir: '/tmp/guidance-inbox',
      sessionId: 'test-guidance',
      maxFilesPerZip: 500,
      maxZipSizeBytes: 50_000_000,
      maxChunkChars: 2000,
      maxFileChars: 120_000,
      priorityHigh: 100,
      priorityMid: 80,
      priorityLow: 50,
      maxZips: 1000,
      alwaysLimit: 4,
      onDemandLimit: 5,
      maxPromptChars: 3000,
      minSimilarity: 0.72,
      enabled: true,
      project: undefined,
    },
    llm: {
      maxBuffer: 10 * 1024 * 1024,
      defaultTimeoutMs: 45_000,
    },
  },
}));

describe('ingest service', () => {
  beforeEach(async () => {
    await fs.mkdir(tmpBase, { recursive: true });
    await fs.mkdir(claudeLogDir, { recursive: true });
    await fs.mkdir(antigravityLogDir, { recursive: true });
    await fs.mkdir(codexSessionDir, { recursive: true });
    await fs.mkdir(codexArchivedSessionDir, { recursive: true });
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
      expect(result.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
      expect(result.messages[1]).toMatchObject({ role: 'assistant', content: 'hi' });
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

  describe('ingestCodexLogs', () => {
    it('ingests user and assistant messages from Codex JSONL sessions', async () => {
      const sessionDir = path.join(codexSessionDir, '2026', '04', '30');
      await fs.mkdir(sessionDir, { recursive: true });
      const logFile = path.join(sessionDir, 'rollout-test.jsonl');
      const content = `${[
        JSON.stringify({
          timestamp: '2026-04-30T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 's1', cwd: '/repo' },
        }),
        JSON.stringify({
          timestamp: '2026-04-30T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'please implement codex ingest' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-30T00:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'implemented codex ingest' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-30T00:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            output: 'large tool output should be skipped',
          },
        }),
      ].join('\n')}\n`;

      await fs.writeFile(logFile, content);

      const result = await ingestCodexLogs();
      expect(result.ok).toBe(true);
      expect(result.messages).toHaveLength(2);
      expect(result.messages.map((message) => message.content)).toEqual([
        'please implement codex ingest',
        'implemented codex ingest',
      ]);
      expect(result.messages[0].metadata?.source).toBe('Codex');
      expect(result.messages[0].metadata?.sessionFile).toBe(logFile);
      expect(result.cursor[logFile].offset).toBeGreaterThan(0);
    });

    it('respects Codex cursor offset to avoid duplicates', async () => {
      const sessionDir = path.join(codexSessionDir, '2026', '04', '30');
      await fs.mkdir(sessionDir, { recursive: true });
      const logFile = path.join(sessionDir, 'rollout-cursor.jsonl');
      const line1 = `${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'old message' }],
        },
      })}\n`;
      const line2 = `${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'new message' }],
        },
      })}\n`;
      await fs.writeFile(logFile, line1 + line2);
      const offset1 = Buffer.byteLength(line1, 'utf8');

      const result = await ingestCodexLogs(undefined, {
        [logFile]: { offset: offset1, mtimeMs: 0 },
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('new message');
    });

    it('ingests historical Codex sessions on first sync by default', async () => {
      const originalLookback = process.env.GNOSIS_CODEX_INITIAL_LOOKBACK_HOURS;
      process.env.GNOSIS_CODEX_INITIAL_LOOKBACK_HOURS = undefined;
      const sessionDir = path.join(codexSessionDir, '2025', '01', '01');
      await fs.mkdir(sessionDir, { recursive: true });
      const logFile = path.join(sessionDir, 'old-rollout.jsonl');
      await fs.writeFile(
        logFile,
        `${JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'old codex memory' }],
          },
        })}\n`,
      );
      const oldDate = new Date('2025-01-01T00:00:00.000Z');
      await fs.utimes(logFile, oldDate, oldDate);

      try {
        const result = await ingestCodexLogs();

        expect(result.messages.map((message) => message.content)).toContain('old codex memory');
        expect(result.cursor[logFile].offset).toBeGreaterThan(0);
      } finally {
        if (originalLookback === undefined) {
          process.env.GNOSIS_CODEX_INITIAL_LOOKBACK_HOURS = undefined;
        } else {
          process.env.GNOSIS_CODEX_INITIAL_LOOKBACK_HOURS = originalLookback;
        }
      }
    });
  });
});
