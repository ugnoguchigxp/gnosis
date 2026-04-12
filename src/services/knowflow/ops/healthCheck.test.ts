import { describe, expect, it, mock, spyOn, afterEach } from 'bun:test';
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
    cliCommand: '/Users/y.noguchi/.bun/bin/bun', // Use absolute path
    cliPromptMode: 'arg' as const,
    cliPromptPlaceholder: '{{prompt}}',
  };

  afterEach(() => {
    mock.restore();
  });

  it('should return ok: true if API is reachable', async () => {
    // Mock fetch to simulate successful connection
    const globalFetch = global.fetch;
    global.fetch = mock().mockResolvedValue({ ok: true });

    const result = await checkLlmHealth(llmConfig);
    
    expect(result.ok).toBe(true);
    expect(result.details.api?.ok).toBe(true);
    expect(result.details.cli?.ok).toBe(true);

    global.fetch = globalFetch;
  });

  it('should return ok: false if both API and CLI fail', async () => {
    global.fetch = mock().mockRejectedValue(new Error('Network error'));
    
    const badConfig = {
       ...llmConfig,
       cliCommand: 'non_existent_command_12345'
    };

    const result = await checkLlmHealth(badConfig);
    
    expect(result.ok).toBe(false);
    expect(result.details.api?.ok).toBe(false);
    expect(result.details.cli?.ok).toBe(false);
  });

  it('should return ok: true if API fails but CLI is ok (fallback)', async () => {
    global.fetch = mock().mockRejectedValue(new Error('Network error'));
    
    const result = await checkLlmHealth(llmConfig);
    
    expect(result.ok).toBe(true);
    expect(result.details.api?.ok).toBe(false);
    expect(result.details.cli?.ok).toBe(true);
  });
});
