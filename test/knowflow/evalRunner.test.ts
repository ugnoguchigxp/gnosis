import { describe, expect, it, mock } from 'bun:test';
import type { runLlmTask } from '../../src/adapters/llm.js';
import { type RunEvalSuiteDeps, runEvalSuite } from '../../src/services/knowflow/eval/runner.js';

const validSuiteJson = JSON.stringify({
  name: 'test-suite',
  description: 'test desc',
  cases: [
    { id: 'case-1', task: 'phrase_scout', context: { context: 'TypeScript typecheck logs' } },
    {
      id: 'case-2',
      task: 'research_note',
      context: { topic: 'Bun', source_texts: 'Bun runtime notes' },
    },
  ],
});

describe('eval runner', () => {
  it('runs local eval suite in mock mode with deterministic success', async () => {
    const result = await runEvalSuite({
      suiteName: 'local',
      mode: 'mock',
      requestPrefix: 'test',
      llmLogger: () => {},
    });

    expect(result.suite).toBe('local');
    expect(result.caseCount).toBeGreaterThan(0);
    expect(result.caseCount).toBe(result.passedCount + result.failedCount);
    expect(result.cases).toHaveLength(result.caseCount);
    expect(result.failedCount).toBe(0);
    expect(result.passRate).toBe(100);
    expect(result.cases.every((c) => c.backend === 'cli')).toBe(true);
  });

  it('throws when suite root is not an object', async () => {
    await expect(
      runEvalSuite(
        { suiteName: 'bad', mode: 'live' },
        { readSuiteFile: async () => JSON.stringify([]) },
      ),
    ).rejects.toThrow('Invalid eval suite: suite root must be an object');
  });

  it('throws when suite name is missing', async () => {
    await expect(
      runEvalSuite(
        { suiteName: 'bad', mode: 'live' },
        { readSuiteFile: async () => JSON.stringify({ name: '', cases: [] }) },
      ),
    ).rejects.toThrow('Invalid eval suite: name must be a non-empty string');
  });

  it('throws when cases is not an array', async () => {
    await expect(
      runEvalSuite(
        { suiteName: 'bad', mode: 'live' },
        { readSuiteFile: async () => JSON.stringify({ name: 'x', cases: 'bad' }) },
      ),
    ).rejects.toThrow('Invalid eval suite: cases must be an array');
  });

  it('throws when a case is not an object', async () => {
    await expect(
      runEvalSuite(
        { suiteName: 'bad', mode: 'live' },
        {
          readSuiteFile: async () => JSON.stringify({ name: 'x', cases: ['not-an-object'] }),
        },
      ),
    ).rejects.toThrow('Invalid eval suite: cases[0] must be an object');
  });

  it('throws when case id is empty', async () => {
    await expect(
      runEvalSuite(
        { suiteName: 'bad', mode: 'live' },
        {
          readSuiteFile: async () =>
            JSON.stringify({
              name: 'x',
              cases: [{ id: '', task: 'phrase_scout', context: {} }],
            }),
        },
      ),
    ).rejects.toThrow('cases[0].id must be a non-empty string');
  });

  it('throws when case task is not a string', async () => {
    await expect(
      runEvalSuite(
        { suiteName: 'bad', mode: 'live' },
        {
          readSuiteFile: async () =>
            JSON.stringify({
              name: 'x',
              cases: [{ id: 'c1', task: 123, context: {} }],
            }),
        },
      ),
    ).rejects.toThrow('cases[0].task must be a string');
  });

  it('throws when case context is not an object', async () => {
    await expect(
      runEvalSuite(
        { suiteName: 'bad', mode: 'live' },
        {
          readSuiteFile: async () =>
            JSON.stringify({
              name: 'x',
              cases: [{ id: 'c1', task: 'phrase_scout', context: 'bad' }],
            }),
        },
      ),
    ).rejects.toThrow('cases[0].context must be a JSON object');
  });

  it('throws when case task is an unsupported value', async () => {
    await expect(
      runEvalSuite(
        { suiteName: 'bad', mode: 'live' },
        {
          readSuiteFile: async () =>
            JSON.stringify({
              name: 'x',
              cases: [{ id: 'c1', task: 'unsupported_task', context: {} }],
            }),
        },
      ),
    ).rejects.toThrow('cases[0].task is not supported');
  });

  it('runs live mode with injected runLlmTask', async () => {
    const mockRunLlmTask = mock(async () => ({
      backend: 'api' as const,
      warnings: [],
      text: 'result',
    }));

    const result = await runEvalSuite(
      { suiteName: 'test', mode: 'live', requestPrefix: 'unit' },
      {
        readSuiteFile: async () => validSuiteJson,
        runLlmTask: mockRunLlmTask as unknown as NonNullable<RunEvalSuiteDeps['runLlmTask']>,
      },
    );

    expect(result.suite).toBe('test-suite');
    expect(result.description).toBe('test desc');
    expect(result.caseCount).toBe(2);
    expect(result.passedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.passRate).toBe(100);
    expect(result.backends.api).toBe(2);
    expect(result.backends.cli).toBe(0);
    expect(mockRunLlmTask).toHaveBeenCalledTimes(2);
  });

  it('records failure when runLlmTask throws', async () => {
    const mockRunLlmTask = mock(async () => {
      throw new Error('LLM unavailable');
    });

    const result = await runEvalSuite(
      { suiteName: 'test', mode: 'live' },
      {
        readSuiteFile: async () => validSuiteJson,
        runLlmTask: mockRunLlmTask as unknown as NonNullable<RunEvalSuiteDeps['runLlmTask']>,
      },
    );

    expect(result.failedCount).toBe(2);
    expect(result.passedCount).toBe(0);
    expect(result.cases[0]?.ok).toBe(false);
    expect(result.cases[0]?.error).toBe('LLM unavailable');
  });

  it('includes latency stats for zero-case suite', async () => {
    const mockRunLlmTask = mock(async () => ({
      backend: 'cli' as const,
      warnings: [],
      text: '',
    }));

    const result = await runEvalSuite(
      { suiteName: 'empty', mode: 'live' },
      {
        readSuiteFile: async () => JSON.stringify({ name: 'empty-suite', cases: [] }),
        runLlmTask: mockRunLlmTask as unknown as NonNullable<RunEvalSuiteDeps['runLlmTask']>,
      },
    );
    expect(result.caseCount).toBe(0);
    expect(result.latency.minMs).toBe(0);
    expect(result.latency.avgMs).toBe(0);
    expect(result.latency.p95Ms).toBe(0);
    expect(result.latency.maxMs).toBe(0);
    expect(result.passRate).toBe(0);
  });

  it('includes warning case rate when task has warnings', async () => {
    const mockRunLlmTask = mock(async () => ({
      backend: 'cli' as const,
      warnings: ['warn1'],
      text: 'result',
    }));

    const result = await runEvalSuite(
      { suiteName: 'test', mode: 'live' },
      {
        readSuiteFile: async () => validSuiteJson,
        runLlmTask: mockRunLlmTask as unknown as NonNullable<RunEvalSuiteDeps['runLlmTask']>,
      },
    );

    expect(result.warningCaseRate).toBe(100);
  });
});
