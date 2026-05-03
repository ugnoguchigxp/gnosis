import { afterAll, describe, expect, it, mock } from 'bun:test';

mock.module('../../src/config.js', () => ({
  config: {
    knowflow: {
      llm: {
        apiBaseUrl: 'http://localhost:8080/v1',
        apiPath: 'chat/completions',
        apiKeyEnv: 'LOCAL_LLM_API_KEY',
        model: 'model',
        temperature: 0.1,
        maxRetries: 3,
        retryDelayMs: 100,
        timeoutMs: 5000,
        enableCliFallback: true,
        cliCommand: 'echo test',
        cliPromptMode: 'arg',
        cliPromptPlaceholder: '{{prompt}}',
      },
    },
    llm: {
      maxBuffer: 1024 * 1024,
    },
  },
}));
import { extractJsonCandidate, parseLlmTaskOutputText, runLlmTask } from '../../src/adapters/llm';

const noopLogger = () => {
  // no-op in test
};

describe('llm adapter', () => {
  afterAll(() => {
    mock.restore();
  });

  it('extracts JSON from complex responses', () => {
    expect(extractJsonCandidate('```json\n{"a":1}\n```')).toContain('{"a":1}');
    expect(extractJsonCandidate('Sure, here is your JSON: {"c":3} and some more text.')).toContain(
      '{"c":3}',
    );
    expect(extractJsonCandidate('')).toBeUndefined();
    expect(extractJsonCandidate('No JSON here')).toBe('No JSON here');
  });

  it('tolerates non-structured outputs in parseLlmTaskOutputText', () => {
    const raw = '{"gaps":[{"type":"uncertain"}]}';
    const parsed = parseLlmTaskOutputText('gap_detection', raw);
    expect(parsed.gaps.length).toBeGreaterThan(0);
  });

  it('tolerates malformed JSON-like text in parseLlmTaskOutputText', () => {
    const raw = '{"bad": json}';
    const parsed = parseLlmTaskOutputText('summarize', raw);
    expect(parsed.summary.length).toBeGreaterThan(0);
  });

  it('returns API output when schema-valid', async () => {
    const result = await runLlmTask(
      {
        task: 'query_generation',
        context: { topic: 'TypeScript Compiler API' },
        requestId: 'req-api-success',
      },
      {
        config: {
          maxRetries: 1,
          enableCliFallback: true,
        },
        deps: {
          loadPromptTemplate: async () => '{{context_json}}',
          invokeApi: async () => '{"queries":["typescript compiler api docs"]}',
          invokeCli: async () => '{"queries":["should not be used"]}',
          logger: noopLogger,
        },
      },
    );

    expect(result.backend).toBe('api');
    expect(result.degraded).toBe(false);
    expect(result.output.queries.length).toBeGreaterThan(0);
  });

  it('falls back to CLI when API fails', async () => {
    const result = await runLlmTask(
      {
        task: 'hypothesis',
        context: { topic: 'Graph RAG' },
        requestId: 'req-cli-fallback',
      },
      {
        config: {
          maxRetries: 1,
          enableCliFallback: true,
        },
        deps: {
          loadPromptTemplate: async () => '{{context_json}}',
          invokeApi: async () => {
            throw new Error('api down');
          },
          invokeCli: async () =>
            '{"hypotheses":[{"id":"h1","hypothesis":"Compare graph rag retrieval","priority":0.8}]}',
          logger: noopLogger,
        },
      },
    );

    expect(result.backend).toBe('cli');
    expect(result.degraded).toBe(false);
    expect(result.output.hypotheses).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('returns non-degraded plain-text parsed output when backends return text', async () => {
    const result = await runLlmTask(
      {
        task: 'gap_detection',
        context: { topic: 'Knowledge Graph' },
        requestId: 'req-degraded',
      },
      {
        config: {
          maxRetries: 1,
          enableCliFallback: true,
        },
        deps: {
          loadPromptTemplate: async () => '{{context_json}}',
          invokeApi: async () => 'not json',
          invokeCli: async () => 'still not json',
          logger: noopLogger,
        },
      },
    );

    expect(result.degraded).toBe(false);
    expect(result.output.gaps[0]?.type).toBe('uncertain');
    expect(result.warnings.length).toBe(0);
  });

  it('respects maxRetries=1 (no retries)', async () => {
    let apiCalls = 0;
    const result = await runLlmTask(
      { task: 'summarize', context: {} },
      {
        config: {
          maxRetries: 1,
          enableCliFallback: false,
        },
        deps: {
          loadPromptTemplate: async () => 'template',
          invokeApi: async () => {
            apiCalls++;
            throw new Error('fail');
          },
          invokeCli: async () => {
            throw new Error('cli should not run');
          },
          logger: noopLogger,
        },
      },
    );

    expect(apiCalls).toBe(1); // 試行1回のみでリトライなし
    expect(result.degraded).toBe(true);
  });
});
