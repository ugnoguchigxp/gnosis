import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { config } from '../src/config.js';

// モック定義をインポートより前に行う（依存関係への適用を確実にするため）
const mockSpawn = mock();
mock.module('node:child_process', () => ({
  spawn: mockSpawn,
}));

mock.module('../src/utils/lock.js', () => ({
  withGlobalSemaphore: async <T>(
    _name: string,
    _concurrency: number,
    fn: () => Promise<T>,
  ): Promise<T> => fn(),
}));

mock.module('../src/config.js', () => ({
  config: {
    embedCommand: 'mock-embed',
    embedTimeoutMs: 1000,
    embeddingDimension: 384,
    dedupeThreshold: 0.9,
    llmTimeoutMs: 90_000,
    claudeLogDir: '/tmp/claude',
    antigravityLogDir: '/tmp/antigravity',
    memory: {
      retries: 2,
      retryWaitMultiplier: 0.01,
    },
    graph: {
      similarityThreshold: 0.9,
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

import { GnosisError } from '../src/domain/errors';
import {
  deleteMemory,
  generateEmbedding,
  listMemoriesByMetadata,
  saveMemory,
  searchMemory,
} from '../src/services/memory';

describe('memory service', () => {
  beforeEach(() => {
    mockSpawn.mockClear();
  });

  describe('generateEmbedding', () => {
    it('generates embedding successfully', async () => {
      mockSpawn.mockImplementation(() => ({
        stdout: {
          // biome-ignore lint/suspicious/noExplicitAny: mock
          on: (event: string, cb: any) =>
            event === 'data' &&
            cb(Buffer.from(JSON.stringify(new Array(config.embeddingDimension).fill(0.1)))),
        },
        stderr: { on: () => {} },
        // biome-ignore lint/suspicious/noExplicitAny: mock
        on: (event: string, cb: any) => {
          if (event === 'close') setTimeout(() => cb(0), 10);
        },
        kill: () => {},
      }));

      const vector = await generateEmbedding('hello');
      expect(vector).toEqual(new Array(config.embeddingDimension).fill(0.1));
      expect(mockSpawn).toHaveBeenCalled();
    });

    it('retries on failure', async () => {
      let calls = 0;
      mockSpawn.mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return {
            stdout: { on: () => {} },
            stderr: {
              // biome-ignore lint/suspicious/noExplicitAny: mock
              on: (event: string, cb: any) => event === 'data' && cb(Buffer.from('error')),
            },
            // biome-ignore lint/suspicious/noExplicitAny: mock
            on: (event: string, cb: any) => event === 'close' && setTimeout(() => cb(1), 10),
            kill: () => {},
          };
        }
        return {
          stdout: {
            // biome-ignore lint/suspicious/noExplicitAny: mock
            on: (event: string, cb: any) =>
              event === 'data' &&
              cb(Buffer.from(JSON.stringify(new Array(config.embeddingDimension).fill(0.5)))),
          },
          stderr: { on: () => {} },
          // biome-ignore lint/suspicious/noExplicitAny: mock
          on: (event: string, cb: any) => event === 'close' && setTimeout(() => cb(0), 10),
          kill: () => {},
        };
      });

      const vector = await generateEmbedding('hello');
      expect(vector).toEqual(new Array(config.embeddingDimension).fill(0.5));
      expect(calls).toBe(2);
    });

    it('throws GnosisError on parse failure', async () => {
      mockSpawn.mockImplementation(() => ({
        stdout: {
          // biome-ignore lint/suspicious/noExplicitAny: mock
          on: (event: string, cb: any) => event === 'data' && cb(Buffer.from('invalid json')),
        },
        stderr: { on: () => {} },
        // biome-ignore lint/suspicious/noExplicitAny: mock
        on: (event: string, cb: any) => event === 'close' && setTimeout(() => cb(0), 10),
        kill: () => {},
      }));

      await expect(generateEmbedding('hello')).rejects.toThrow(GnosisError);
    });
  });

  describe('saveMemory', () => {
    it('validates input and saves with embedding', async () => {
      // generateEmbedding はモック済みの spawn を通じて動作
      mockSpawn.mockImplementation(() => ({
        stdout: {
          // biome-ignore lint/suspicious/noExplicitAny: mock
          on: (event: string, cb: any) =>
            event === 'data' &&
            cb(Buffer.from(JSON.stringify(new Array(config.embeddingDimension).fill(0.1)))),
        },
        stderr: { on: () => {} },
        // biome-ignore lint/suspicious/noExplicitAny: mock
        on: (event: string, cb: any) => event === 'close' && setTimeout(() => cb(0), 10),
        kill: () => {},
      }));

      const mockReturning = [
        {
          id: 'm1',
          content: 'test',
          metadata: {},
          sessionId: 's1',
          embedding: new Array(config.embeddingDimension).fill(0.1),
          createdAt: new Date(),
          // biome-ignore lint/suspicious/noExplicitAny: mock
        } as any,
      ];
      const mockValues = mock(() => ({
        returning: async () => mockReturning,
      }));
      const mockDb = {
        insert: mock(() => ({ values: mockValues })),
        // biome-ignore lint/suspicious/noExplicitAny: mock
      } as any;

      const result = await saveMemory('session-1', 'test content', { key: 'val' }, mockDb);
      expect(result).toEqual(mockReturning[0]);
      expect(mockDb.insert).toHaveBeenCalled();

      // biome-ignore lint/suspicious/noExplicitAny: mock
      const insertData = (mockValues.mock.calls as any)[0][0];
      expect(insertData.content).toBe('test content');
      expect(insertData.embedding).toEqual(new Array(config.embeddingDimension).fill(0.1));
    });
  });

  describe('searchMemory', () => {
    it('performs semantic search with similarity calculation', async () => {
      mockSpawn.mockImplementation(() => ({
        stdout: {
          // biome-ignore lint/suspicious/noExplicitAny: mock
          on: (event: string, cb: any) =>
            event === 'data' &&
            cb(Buffer.from(JSON.stringify(new Array(config.embeddingDimension).fill(0)))),
        },
        stderr: { on: () => {} },
        // biome-ignore lint/suspicious/noExplicitAny: mock
        on: (event: string, cb: any) => event === 'close' && setTimeout(() => cb(0), 10),
        kill: () => {},
      }));

      // biome-ignore lint/suspicious/noExplicitAny: mock
      const mockResults = [{ id: 'm1', content: 'found', similarity: 0.9 } as any];
      const mockLimit = mock(() => mockResults);
      const mockOrderBy = mock(() => ({ limit: mockLimit }));
      const mockWhere = mock(() => ({ orderBy: mockOrderBy }));
      const mockFrom = mock(() => ({ where: mockWhere }));

      const mockUpdateLimit = mock(() => ({}));
      const mockUpdateSet = mock(() => ({ where: mockUpdateLimit }));

      const mockDb = {
        select: mock(() => ({ from: mockFrom })),
        update: mock(() => ({ set: mockUpdateSet })),
        // biome-ignore lint/suspicious/noExplicitAny: mock
      } as any;

      const results = await searchMemory('s1', 'query', 3, { category: 'tech' }, mockDb);
      expect(results).toEqual(mockResults);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.update).toHaveBeenCalled(); // 参照実績の更新
    });
  });

  describe('listMemoriesByMetadata', () => {
    it('lists memories by metadata without generating embedding', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: mock
      const mockResults = [{ id: 'm1', content: 'list' } as any];
      const mockLimit = mock(() => mockResults);
      const mockOrderBy = mock(() => ({ limit: mockLimit }));
      const mockWhere = mock(() => ({ orderBy: mockOrderBy }));
      const mockFrom = mock(() => ({ where: mockWhere }));
      const mockDb = {
        select: mock(() => ({ from: mockFrom })),
        update: mock(() => ({ set: () => ({ where: () => {} }) })),
        // biome-ignore lint/suspicious/noExplicitAny: mock
      } as any;

      const results = await listMemoriesByMetadata('s1', { type: 'memo' }, 5, {}, mockDb);
      expect(results).toEqual(mockResults);
      expect(mockSpawn).not.toHaveBeenCalled(); // 埋め込みは不要
    });
  });

  describe('deleteMemory', () => {
    it('deletes memory by id', async () => {
      const mockWhere = mock(() => {});
      const mockDb = {
        delete: mock(() => ({ where: mockWhere })),
        // biome-ignore lint/suspicious/noExplicitAny: mock
      } as any;

      await deleteMemory('id-to-delete', mockDb);
      expect(mockDb.delete).toHaveBeenCalled();
    });
  });
});
