import { describe, expect, it } from 'bun:test';
import { extractJsonCandidate, parseLlmTaskOutputText, runLlmTask } from '../../src/adapters/llm';

const noopLogger = () => {
  // no-op in test
};

describe('llm adapter', () => {
  it('extracts JSON from complex responses', () => {
    // Fenced with json tag
    expect(extractJsonCandidate('```json\n{"a":1}\n```')).toBe('{"a":1}');
    // Fenced without tag
    expect(extractJsonCandidate('```\n{"b":2}\n```')).toBe('{"b":2}');
    // No fences
    expect(extractJsonCandidate('Sure, here is your JSON: {"c":3} and some more text.')).toBe(
      '{"c":3}',
    );
    // Multiple blocks (should take first one found by regex which is non-greedy)
    expect(extractJsonCandidate('First: ```{"d":4}``` Second: ```{"e":5}```')).toBe('{"d":4}');
    // Empty/None
    expect(extractJsonCandidate('')).toBeUndefined();
    expect(extractJsonCandidate('No JSON here')).toBeUndefined();
  });

  it('throws on schema violations in parseLlmTaskOutputText', () => {
    const raw = '{"gaps":[{"type":"uncertain"}]}';
    // description と priority が足りないので throw するはず
    expect(() => parseLlmTaskOutputText('gap_detection', raw)).toThrow();
  });

  it('throws on malformed JSON in parseLlmTaskOutputText', () => {
    const raw = '{"bad": json}';
    expect(() => parseLlmTaskOutputText('summarize', raw)).toThrow(/JSON parse failed/);
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
    expect(result.output.queries).toEqual(['typescript compiler api docs']);
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

  it('returns degraded output when all backends fail', async () => {
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

    expect(result.degraded).toBe(true);
    expect(result.output.gaps[0]?.type).toBe('uncertain');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('respects maxRetries=1 (no retries)', async () => {
    let apiCalls = 0;
    const result = await runLlmTask(
      { task: 'summarize', context: {} },
      {
        config: { maxRetries: 1 },
        deps: {
          loadPromptTemplate: async () => 'template',
          invokeApi: async () => {
            apiCalls++;
            throw new Error('fail');
          },
          logger: noopLogger,
        },
      },
    );

    expect(apiCalls).toBe(1); // 試行1回のみでリトライなし
    expect(result.degraded).toBe(true);
  });
});
