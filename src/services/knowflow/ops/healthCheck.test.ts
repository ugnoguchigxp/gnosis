import { afterEach, describe, expect, it, mock } from 'bun:test';
import { checkLlmHealth } from './healthCheck.js';

describe('healthCheck', () => {
  const llmConfig = {
    apiBaseUrl: 'http://localhost:1234',
    apiPath: '/v1/chat',
    apiKeyEnv: 'KEY',
    model: 'test',
    temperature: 0,
    timeoutMs: 1000,
    maxRetries: 1,
    retryDelayMs: 0,
    enableCliFallback: true,
    cliCommand: 'any_command',
    cliPromptMode: 'arg' as const,
    cliPromptPlaceholder: '{{prompt}}',
  };

  const mockExec = (shouldFail: boolean) => {
    return mock().mockImplementation(async (cmd: string) => {
      if (shouldFail) {
        throw new Error('command not found');
      }
      return { stdout: 'ok', stderr: '' };
    });
  };

  afterEach(() => {
    mock.restore();
  });

  it('should return ok: true if API is reachable', async () => {
    const globalFetch = global.fetch;
    (global.fetch as unknown as () => Promise<unknown>) = mock().mockResolvedValue({ ok: true });

    const result = await checkLlmHealth(llmConfig, undefined, { exec: mockExec(false) });

    expect(result.ok).toBe(true);
    expect(result.details.api?.ok).toBe(true);
    expect(result.details.cli?.ok).toBe(true);

    global.fetch = globalFetch;
  });

  it('should return ok: false if both API and CLI fail', async () => {
    (global.fetch as unknown as () => Promise<unknown>) = mock().mockRejectedValue(
      new Error('Network error'),
    );

    const result = await checkLlmHealth(llmConfig, undefined, { exec: mockExec(true) });

    expect(result.ok).toBe(false);
    expect(result.details.api?.ok).toBe(false);
    expect(result.details.cli?.ok).toBe(false);
  });

  it('should return ok: true if API fails but CLI is ok (fallback)', async () => {
    (global.fetch as unknown as () => Promise<unknown>) = mock().mockRejectedValue(
      new Error('Network error'),
    );

    const result = await checkLlmHealth(llmConfig, undefined, { exec: mockExec(false) });

    expect(result.ok).toBe(true);
    expect(result.details.api?.ok).toBe(false);
    expect(result.details.cli?.ok).toBe(true);
  });
});
