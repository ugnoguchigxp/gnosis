import { REVIEW_LIMITS, ReviewError } from '../errors.js';
import type { ReviewLLMService } from './types.js';

export type ReviewCloudProvider = 'openai' | 'anthropic' | 'google';

type CloudProviderOptions = {
  provider?: ReviewCloudProvider;
  apiBaseUrl?: string;
  apiPath?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
};

const DEFAULTS: Record<ReviewCloudProvider, { baseUrl: string; path: string }> = {
  openai: {
    baseUrl: 'https://api.openai.com',
    path: '/v1/chat/completions',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    path: '/v1/messages',
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    path: '/v1beta/models',
  },
};

function normalizeProvider(value: string | undefined): ReviewCloudProvider {
  if (value === 'anthropic' || value === 'google' || value === 'openai') return value;
  return 'openai';
}

function resolveRequestConfig(
  provider: ReviewCloudProvider,
  model: string,
  apiBaseUrl: string,
  apiPath: string,
  apiKey: string,
): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  extractText: (payload: Record<string, unknown>) => string;
} {
  if (provider === 'google') {
    const path = `${apiPath.replace(/\/$/, '')}/${encodeURIComponent(
      model,
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;
    return {
      url: new URL(path, apiBaseUrl).toString(),
      headers: {
        'content-type': 'application/json',
      },
      body: {
        contents: [{ role: 'user', parts: [{ text: '' }] }],
      },
      extractText: (payload: any) =>
        payload.candidates?.[0]?.content?.parts?.map((part: any) => part.text ?? '').join('') ?? '',
    };
  }

  if (provider === 'anthropic') {
    return {
      url: new URL(apiPath, apiBaseUrl).toString(),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: '' }],
      },
      extractText: (payload: any) =>
        payload.content?.map((part: any) => part.text ?? '').join('') ?? '',
    };
  }

  return {
    url: new URL(apiPath, apiBaseUrl).toString(),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: {
      model,
      messages: [{ role: 'user', content: '' }],
      temperature: 0,
    },
    extractText: (payload: any) =>
      payload.choices?.[0]?.message?.content ?? payload.output_text ?? payload.content ?? '',
  };
}

export function createCloudReviewLLMService(options: CloudProviderOptions = {}): ReviewLLMService {
  const provider = options.provider ?? normalizeProvider(process.env.GNOSIS_REVIEW_LLM_PROVIDER);
  const defaults = DEFAULTS[provider];
  const apiBaseUrl =
    options.apiBaseUrl ?? process.env.GNOSIS_REVIEW_LLM_API_BASE_URL ?? defaults.baseUrl;
  const apiPath = options.apiPath ?? process.env.GNOSIS_REVIEW_LLM_API_PATH ?? defaults.path;
  const apiKey = options.apiKey ?? process.env.GNOSIS_REVIEW_LLM_API_KEY;
  const model = options.model ?? process.env.GNOSIS_REVIEW_LLM_MODEL;
  const timeoutMs = options.timeoutMs ?? REVIEW_LIMITS.LLM_TIMEOUT_MS;

  if (!apiKey) {
    throw new ReviewError('E007', 'Cloud review LLM is not configured: missing API key');
  }
  if (!model) {
    throw new ReviewError('E007', 'Cloud review LLM is not configured: missing model');
  }

  return {
    provider: 'cloud',
    async generate(prompt: string, opts = {}): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const request = resolveRequestConfig(provider, model, apiBaseUrl, apiPath, apiKey);
        const body =
          provider === 'google'
            ? {
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                  temperature: 0,
                  ...(opts.format === 'json' ? { responseMimeType: 'application/json' } : {}),
                },
              }
            : provider === 'anthropic'
              ? {
                  ...request.body,
                  messages: [{ role: 'user', content: prompt }],
                  ...(opts.format === 'json' ? { tools: [], system: 'Return JSON only.' } : {}),
                }
              : {
                  ...request.body,
                  messages: [{ role: 'user', content: prompt }],
                  ...(opts.format === 'json' ? { response_format: { type: 'json_object' } } : {}),
                };

        const response = await fetch(request.url, {
          method: 'POST',
          signal: controller.signal,
          headers: request.headers,
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new ReviewError('E007', `Cloud LLM request failed (${response.status}): ${text}`);
        }

        const payload = (await response.json()) as Record<string, unknown>;
        const content = request.extractText(payload);

        if (!content.trim()) {
          throw new ReviewError('E007', 'Cloud LLM returned an empty response');
        }

        return content.trim();
      } catch (error) {
        if (error instanceof ReviewError) throw error;
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new ReviewError('E006', `Cloud LLM request timed out after ${timeoutMs}ms`);
        }
        throw new ReviewError('E007', `Cloud LLM request failed: ${error}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
