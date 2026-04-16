import { afterEach, describe, expect, test } from 'bun:test';
import { createCloudReviewLLMService } from '../src/services/review/llm/cloudProvider.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(
  responseBody: unknown,
  onRequest: (url: string, init: RequestInit) => void,
): void {
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    onRequest(String(input), init);
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  }) as typeof fetch;
}

describe('review cloud provider', () => {
  test('uses the OpenAI API shape', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> | undefined;
    let seenBody = '';

    mockFetch(
      {
        choices: [{ message: { content: 'openai-response' } }],
      },
      (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers as Record<string, string>;
        seenBody = String(init.body ?? '');
      },
    );

    const service = createCloudReviewLLMService({
      provider: 'openai',
      apiBaseUrl: 'https://api.openai.com',
      apiPath: '/v1/chat/completions',
      apiKey: 'sk-openai',
      model: 'gpt-4.1',
    });

    const output = await service.generate('Review this diff.', { format: 'json' });

    expect(output).toBe('openai-response');
    expect(seenUrl).toBe('https://api.openai.com/v1/chat/completions');
    expect(seenHeaders).toMatchObject({
      Authorization: 'Bearer sk-openai',
      'content-type': 'application/json',
    });

    const body = JSON.parse(seenBody) as Record<string, unknown>;
    expect(body.model).toBe('gpt-4.1');
    expect(body.messages).toEqual([{ role: 'user', content: 'Review this diff.' }]);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  test('uses the Azure OpenAI API shape', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> | undefined;
    let seenBody = '';

    mockFetch(
      {
        choices: [{ message: { content: 'azure-response' } }],
      },
      (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers as Record<string, string>;
        seenBody = String(init.body ?? '');
      },
    );

    const service = createCloudReviewLLMService({
      provider: 'azure-openai',
      apiBaseUrl: 'https://example.openai.azure.com',
      apiPath: '/openai/deployments',
      apiVersion: '2024-06-01',
      apiKey: 'azure-key',
      model: 'review-deployment',
    });

    const output = await service.generate('Review this diff.', { format: 'json' });

    expect(output).toBe('azure-response');
    expect(seenUrl).toBe(
      'https://example.openai.azure.com/openai/deployments/review-deployment/chat/completions?api-version=2024-06-01',
    );
    expect(seenHeaders).toMatchObject({
      'api-key': 'azure-key',
      'content-type': 'application/json',
    });
    expect((seenHeaders as Record<string, string>).Authorization).toBeUndefined();

    const body = JSON.parse(seenBody) as Record<string, unknown>;
    expect(body.model).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'user', content: 'Review this diff.' }]);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
});
