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
      worker: {
        maxQueriesPerTask: 3,
        cronRunWindowMs: 3600000,
      },
    },
    llm: {
      maxBuffer: 1024 * 1024,
      concurrencyLimit: 1,
    },
  },
}));

import { runLlmTask } from '../../src/adapters/llm';

const noopLogger = () => {
  // no-op in test
};

describe('llm adapter', () => {
  afterAll(() => {
    mock.restore();
  });

  it('returns API output as raw text', async () => {
    const result = await runLlmTask(
      {
        task: 'research_note',
        context: { topic: 'TypeScript Compiler API' },
        requestId: 'req-api-success',
      },
      {
        config: {
          maxRetries: 1,
          enableCliFallback: true,
        },
        deps: {
          loadPromptTemplate: async () => 'Topic: {{topic}}',
          invokeApi: async () => '  TypeScript compiler API note.  ',
          invokeCli: async () => 'should not be used',
          logger: noopLogger,
        },
      },
    );

    expect(result.backend).toBe('api');
    expect(result.text).toBe('TypeScript compiler API note.');
    expect(result.warnings).toHaveLength(0);
  });

  it('unwraps local model response envelope without parsing LLM content', async () => {
    const result = await runLlmTask(
      {
        task: 'phrase_scout',
        context: { context: 'logs' },
        requestId: 'req-envelope',
      },
      {
        config: {
          maxRetries: 1,
          enableCliFallback: false,
        },
        deps: {
          loadPromptTemplate: async () => '{{context}}',
          invokeApi: async () => JSON.stringify({ response: 'MCP fetch retry budget' }),
          invokeCli: async () => 'should not be used',
          logger: noopLogger,
        },
      },
    );

    expect(result.text).toBe('MCP fetch retry budget');
  });

  it('falls back to CLI when API fails', async () => {
    const result = await runLlmTask(
      {
        task: 'phrase_scout',
        context: { context: 'Graph RAG logs' },
        requestId: 'req-cli-fallback',
      },
      {
        config: {
          maxRetries: 1,
          enableCliFallback: true,
        },
        deps: {
          loadPromptTemplate: async () => '{{context}}',
          invokeApi: async () => {
            throw new Error('api down');
          },
          invokeCli: async () => 'Graph RAG retrieval drift',
          logger: noopLogger,
        },
      },
    );

    expect(result.backend).toBe('cli');
    expect(result.text).toBe('Graph RAG retrieval drift');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('fails when the backend returns a tool or think block parse failure', async () => {
    await expect(
      runLlmTask(
        {
          task: 'research_note',
          context: { topic: 'Boundary testing' },
          requestId: 'req-control-error',
        },
        {
          config: {
            maxRetries: 1,
            enableCliFallback: false,
          },
          deps: {
            loadPromptTemplate: async () => 'Topic: {{topic}}',
            invokeApi: async () =>
              JSON.stringify({
                response: '[System] Tool call or think block was generated but failed to parse.',
              }),
            invokeCli: async () => 'should not be used',
            logger: noopLogger,
          },
        },
      ),
    ).rejects.toThrow('LLM task failed');
  });

  it('uses a plain-text retry prompt after a control parse failure', async () => {
    const prompts: string[] = [];
    const result = await runLlmTask(
      {
        task: 'phrase_scout',
        context: { context: 'review_task provider policy' },
        requestId: 'req-control-retry',
      },
      {
        config: {
          maxRetries: 2,
          enableCliFallback: false,
          retryDelayMs: 0,
        },
        deps: {
          loadPromptTemplate: async () => '{{context}}',
          invokeApi: async (prompt) => {
            prompts.push(prompt);
            if (prompts.length === 1) {
              return JSON.stringify({
                response: '[System] Tool call or think block was generated but failed to parse.',
              });
            }
            return 'MCP review provider routing';
          },
          invokeCli: async () => 'should not be used',
          logger: noopLogger,
        },
      },
    );

    expect(result.text).toBe('MCP review provider routing');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Retry instruction:');
    expect(prompts[1]).toContain('Return final plain text only');
  });

  it('respects maxRetries=1', async () => {
    let apiCalls = 0;
    await expect(
      runLlmTask(
        { task: 'research_note', context: {} },
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
      ),
    ).rejects.toThrow('LLM task failed');

    expect(apiCalls).toBe(1);
  });

  it('passes request priority to API invocation', async () => {
    let observedPriority: unknown;
    const result = await runLlmTask(
      {
        task: 'research_note',
        context: { topic: 'priority' },
        requestId: 'req-priority',
        priority: 'high',
      },
      {
        config: {
          maxRetries: 1,
          enableCliFallback: false,
        },
        deps: {
          loadPromptTemplate: async () => 'Topic: {{topic}}',
          invokeApi: async (_prompt, _config, _signal, priority) => {
            observedPriority = priority;
            return 'priority accepted';
          },
          invokeCli: async () => 'should not be used',
          logger: noopLogger,
        },
      },
    );

    expect(result.text).toBe('priority accepted');
    expect(observedPriority).toBe('high');
  });
});
