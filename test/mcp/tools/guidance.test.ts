import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('../../../src/config.js', () => ({
  config: {
    embedCommand: 'mock-embed',
    embedTimeoutMs: 1000,
    embeddingDimension: 3,
    dedupeThreshold: 0.9,
    llmTimeoutMs: 90_000,
    claudeLogDir: '/tmp/claude',
    antigravityLogDir: '/tmp/antigravity',
    localLlmPath: '/tmp/local-llm',
    synthesisBatchSize: 10,
    memory: { retries: 1, retryWaitMultiplier: 0.01 },
    graph: { similarityThreshold: 0.8, maxPathHops: 5 },
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
    llm: { maxBuffer: 10 * 1024 * 1024, defaultTimeoutMs: 45_000 },
  },
}));

const mockSaveGuidance = mock();
mock.module('../../../src/services/guidance/index.js', () => ({
  saveGuidance: mockSaveGuidance,
}));

import { guidanceTools } from '../../../src/mcp/tools/guidance.js';

const getHandler = (name: string) => {
  const tool = guidanceTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool.handler;
};

describe('guidance MCP tools', () => {
  beforeEach(() => {
    mockSaveGuidance.mockReset();
  });

  afterEach(() => {
    mockSaveGuidance.mockReset();
  });

  describe('register_guidance', () => {
    it('calls saveGuidance and returns success message', async () => {
      mockSaveGuidance.mockResolvedValue({ archiveKey: 'test-key-123' });

      const handler = getHandler('register_guidance');
      const result = await handler({
        title: 'Test Rule',
        content: 'Always do X',
        guidanceType: 'rule',
        scope: 'always',
      });

      expect(mockSaveGuidance).toHaveBeenCalledTimes(1);
      expect(result.content[0]?.type).toBe('text');
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('Test Rule');
      expect(text).toContain('test-key-123');
    });

    it('passes optional fields through to saveGuidance', async () => {
      mockSaveGuidance.mockResolvedValue({ archiveKey: 'skill-key' });

      const handler = getHandler('register_guidance');
      await handler({
        title: 'My Skill',
        content: 'How to do Y',
        guidanceType: 'skill',
        scope: 'on_demand',
        priority: 80,
        tags: ['typescript', 'testing'],
        applicability: {
          projects: ['gnosis'],
          domains: ['programming'],
          languages: ['typescript'],
          environments: ['local'],
          repos: ['github.com/ugnoguchigxp/gnosis'],
        },
        archiveKey: 'my-skill',
      });

      // biome-ignore lint/suspicious/noExplicitAny: mock
      const callArg = (mockSaveGuidance.mock.calls as any)[0][0];
      expect(callArg.guidanceType).toBe('skill');
      expect(callArg.scope).toBe('on_demand');
      expect(callArg.priority).toBe(80);
      expect(callArg.tags).toEqual(['typescript', 'testing']);
      expect(callArg.applicability.projects).toEqual(['gnosis']);
    });

    it('throws on invalid input schema', async () => {
      const handler = getHandler('register_guidance');
      await expect(
        handler({
          title: 'Bad',
          content: 'content',
          guidanceType: 'invalid-type',
          scope: 'always',
        }),
      ).rejects.toThrow();
    });
  });
});
