import { describe, expect, it } from 'bun:test';
import { runEvalSuite } from '../../src/services/knowflow/eval/runner';

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
    expect(result.degradedCount).toBe(0);
    expect(result.cases.every((c) => c.backend === 'cli')).toBe(true);
  });
});
