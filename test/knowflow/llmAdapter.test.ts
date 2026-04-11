import { describe, expect, it } from 'bun:test';
import { extractJsonCandidate, parseLlmTaskOutputText, runLlmTask } from '../../src/adapters/llm';

const noopLogger = () => {
  // no-op in test
};

describe('llm adapter', () => {
  it('extracts JSON from fenced response', () => {
    const raw = '```json\n{"summary":"ok","findings":["a"]}\n```';
    const candidate = extractJsonCandidate(raw);
    expect(candidate).toBe('{"summary":"ok","findings":["a"]}');

    const parsed = parseLlmTaskOutputText('summarize', raw);
    expect(parsed.summary).toBe('ok');
    expect(parsed.findings).toEqual(['a']);
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
});
