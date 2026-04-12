import { describe, expect, it } from 'bun:test';
import { runEvalSuite } from '../../src/services/knowflow/eval/runner';

describe('eval runner', () => {
  it('runs local eval suite and reports summary', async () => {
    const result = await runEvalSuite({
      suiteName: 'local',
      llmConfig: {
        timeoutMs: 2000,
        maxRetries: 1,
        retryDelayMs: 0,
      },
      requestPrefix: 'test',
      llmLogger: () => {},
    });

    expect(result.suite).toBe('local');
    expect(result.caseCount).toBeGreaterThan(0);
    expect(result.caseCount).toBe(result.passedCount + result.failedCount);
    expect(result.cases).toHaveLength(result.caseCount);
  });
});
