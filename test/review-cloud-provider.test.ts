import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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

  test('reads OPENAI_API_KEY and OPENAI_MODEL env vars when no options given', async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    const savedModel = process.env.OPENAI_MODEL;
    process.env.OPENAI_API_KEY = 'env-openai-key';
    process.env.OPENAI_MODEL = 'gpt-env-model';

    let seenHeaders: Record<string, string> | undefined;
    let seenBody = '';

    mockFetch({ choices: [{ message: { content: 'ok' } }] }, (_url, init) => {
      seenHeaders = init.headers as Record<string, string>;
      seenBody = String(init.body ?? '');
    });

    try {
      const service = createCloudReviewLLMService({ provider: 'openai' });
      await service.generate('hello');
      expect(seenHeaders?.Authorization).toBe('Bearer env-openai-key');
      expect((JSON.parse(seenBody) as Record<string, unknown>).model).toBe('gpt-env-model');
    } finally {
      if (savedKey === undefined) process.env.OPENAI_API_KEY = undefined;
      else process.env.OPENAI_API_KEY = savedKey;
      if (savedModel === undefined) process.env.OPENAI_MODEL = undefined;
      else process.env.OPENAI_MODEL = savedModel;
    }
  });

  test('uses the Bedrock API shape', async () => {
    const savedInferenceProfile = process.env.GNOSIS_REVIEW_LLM_BEDROCK_INFERENCE_PROFILE_ID;
    const savedModelId = process.env.GNOSIS_REVIEW_LLM_BEDROCK_MODEL_ID;
    process.env.GNOSIS_REVIEW_LLM_BEDROCK_INFERENCE_PROFILE_ID = undefined;
    process.env.GNOSIS_REVIEW_LLM_BEDROCK_MODEL_ID = undefined;

    let seenUrl = '';
    let seenHeaders: Record<string, string> | undefined;
    let seenBody = '';

    mockFetch(
      {
        content: [{ type: 'text', text: 'bedrock-response' }],
      },
      (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers as Record<string, string>;
        seenBody = String(init.body ?? '');
      },
    );

    const service = createCloudReviewLLMService({
      provider: 'bedrock',
      apiBaseUrl: 'https://bedrock-runtime.ap-northeast-1.amazonaws.com',
      awsRegion: 'ap-northeast-1',
      awsAccessKeyId: 'AKIA_TEST',
      awsSecretAccessKey: 'SECRET_TEST',
      bedrockModelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    });

    try {
      const output = await service.generate('hello');

      expect(output).toBe('bedrock-response');
      expect(seenUrl).toBe(
        'https://bedrock-runtime.ap-northeast-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20240620-v1%3A0/invoke',
      );
      expect(seenHeaders).toMatchObject({
        'content-type': 'application/json',
        host: 'bedrock-runtime.ap-northeast-1.amazonaws.com',
      });
      expect(seenHeaders?.['x-amz-content-sha256']).toMatch(/^[a-f0-9]{64}$/);
      expect(seenHeaders?.['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
      expect(seenHeaders?.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(JSON.parse(seenBody) as Record<string, unknown>).toMatchObject({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      });
    } finally {
      if (savedInferenceProfile === undefined) {
        process.env.GNOSIS_REVIEW_LLM_BEDROCK_INFERENCE_PROFILE_ID = undefined;
      } else {
        process.env.GNOSIS_REVIEW_LLM_BEDROCK_INFERENCE_PROFILE_ID = savedInferenceProfile;
      }
      if (savedModelId === undefined) {
        process.env.GNOSIS_REVIEW_LLM_BEDROCK_MODEL_ID = undefined;
      } else {
        process.env.GNOSIS_REVIEW_LLM_BEDROCK_MODEL_ID = savedModelId;
      }
    }
  });

  test('falls back to the Bedrock model id after a 404 on the inference profile id', async () => {
    const savedReviewModel = process.env.GNOSIS_REVIEW_LLM_MODEL;
    process.env.GNOSIS_REVIEW_LLM_MODEL = 'gpt-5.4-mini';

    const seenUrls: string[] = [];
    const seenBodies: string[] = [];

    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      seenUrls.push(String(input));
      seenBodies.push(String(init.body ?? ''));

      if (seenUrls.length === 1) {
        return new Response(
          JSON.stringify({ error: { code: '404', message: 'Resource not found' } }),
          {
            status: 404,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'fallback-ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const service = createCloudReviewLLMService({
      provider: 'bedrock',
      apiBaseUrl: 'https://bedrock-runtime.ap-northeast-1.amazonaws.com',
      awsRegion: 'ap-northeast-1',
      awsAccessKeyId: 'AKIA_TEST',
      awsSecretAccessKey: 'SECRET_TEST',
      bedrockInferenceProfileId: 'bad.profile.id',
      bedrockModelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    });

    const output = await service.generate('hello');

    expect(output).toBe('fallback-ok');
    expect(seenUrls).toHaveLength(2);
    expect(seenUrls.join('\n')).not.toContain('gpt-5.4-mini');
    expect(seenUrls[0]).toContain('/model/bad.profile.id/invoke');
    expect(seenUrls[1]).toContain('/model/anthropic.claude-3-5-sonnet-20240620-v1%3A0/invoke');
    expect(JSON.parse(seenBodies[0]) as Record<string, unknown>).toMatchObject({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });

    if (savedReviewModel === undefined) process.env.GNOSIS_REVIEW_LLM_MODEL = undefined;
    else process.env.GNOSIS_REVIEW_LLM_MODEL = savedReviewModel;
  });

  test('reads AZURE_OPENAI_API_KEY and AZURE_OPENAI_MODEL env vars', async () => {
    const savedKey = process.env.AZURE_OPENAI_API_KEY;
    const savedModel = process.env.AZURE_OPENAI_MODEL;
    process.env.AZURE_OPENAI_API_KEY = 'env-azure-key';
    process.env.AZURE_OPENAI_MODEL = 'azure-env-model';

    let seenHeaders: Record<string, string> | undefined;
    let seenBody = '';

    mockFetch({ choices: [{ message: { content: 'ok' } }] }, (_url, init) => {
      seenHeaders = init.headers as Record<string, string>;
      seenBody = String(init.body ?? '');
    });

    try {
      const service = createCloudReviewLLMService({
        provider: 'azure-openai',
        apiBaseUrl: 'https://example.openai.azure.com',
      });
      await service.generate('hello');
      expect(seenHeaders?.['api-key']).toBe('env-azure-key');
      expect((JSON.parse(seenBody) as Record<string, unknown>).model).toBeUndefined();
    } finally {
      if (savedKey === undefined) process.env.AZURE_OPENAI_API_KEY = undefined;
      else process.env.AZURE_OPENAI_API_KEY = savedKey;
      if (savedModel === undefined) process.env.AZURE_OPENAI_MODEL = undefined;
      else process.env.AZURE_OPENAI_MODEL = savedModel;
    }
  });

  test('throws E007 when API key is missing for openai provider', () => {
    const savedKey = process.env.OPENAI_API_KEY;
    const savedGnosis = process.env.GNOSIS_REVIEW_LLM_API_KEY;
    process.env.OPENAI_API_KEY = undefined;
    process.env.GNOSIS_REVIEW_LLM_API_KEY = undefined;

    try {
      expect(() => createCloudReviewLLMService({ provider: 'openai', model: 'gpt-4.1' })).toThrow(
        'missing API key',
      );
    } finally {
      if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
      if (savedGnosis !== undefined) process.env.GNOSIS_REVIEW_LLM_API_KEY = savedGnosis;
    }
  });

  test('bedrock ignores GNOSIS_REVIEW_LLM_API_BASE_URL so Azure URL does not leak', async () => {
    const savedBaseUrl = process.env.GNOSIS_REVIEW_LLM_API_BASE_URL;
    process.env.GNOSIS_REVIEW_LLM_API_BASE_URL = 'https://azure-should-not-appear.openai.azure.com';

    let seenUrl = '';
    mockFetch({ content: [{ type: 'text', text: 'ok' }] }, (url) => {
      seenUrl = url;
    });

    try {
      const service = createCloudReviewLLMService({
        provider: 'bedrock',
        awsRegion: 'us-east-1',
        awsAccessKeyId: 'AKIA_TEST',
        awsSecretAccessKey: 'SECRET_TEST',
        bedrockModelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
      });
      await service.generate('hello');
      expect(seenUrl).toContain('bedrock-runtime.us-east-1.amazonaws.com');
      expect(seenUrl).not.toContain('azure');
    } finally {
      if (savedBaseUrl === undefined) process.env.GNOSIS_REVIEW_LLM_API_BASE_URL = undefined;
      else process.env.GNOSIS_REVIEW_LLM_API_BASE_URL = savedBaseUrl;
    }
  });
});
