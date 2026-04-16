import { REVIEW_LIMITS, ReviewError } from '../errors.js';
import type { ReviewLLMService } from './types.js';

export type ReviewCloudProvider = 'openai' | 'bedrock' | 'azure-openai' | 'anthropic' | 'google';

type CloudProviderOptions = {
  provider?: ReviewCloudProvider;
  apiBaseUrl?: string;
  apiPath?: string;
  apiVersion?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  awsRegion?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  bedrockModelId?: string;
  bedrockInferenceProfileId?: string;
};

const DEFAULTS: Record<
  ReviewCloudProvider,
  { baseUrl: string; path: string; apiVersion?: string }
> = {
  openai: {
    baseUrl: 'https://api.openai.com',
    path: '/v1/chat/completions',
  },
  bedrock: {
    baseUrl: '',
    path: '',
  },
  'azure-openai': {
    baseUrl: '',
    path: '/openai/deployments',
    apiVersion: '2024-06-01',
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

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const extractOpenAiText = (payload: Record<string, unknown>): string => {
  const choices = payload.choices;
  if (Array.isArray(choices)) {
    const firstChoice = choices[0];
    if (isPlainRecord(firstChoice)) {
      const message = firstChoice.message;
      if (isPlainRecord(message) && typeof message.content === 'string') {
        return message.content;
      }
    }
  }

  if (typeof payload.output_text === 'string') {
    return payload.output_text;
  }

  if (typeof payload.content === 'string') {
    return payload.content;
  }

  return '';
};

const extractGoogleText = (payload: Record<string, unknown>): string => {
  const candidates = payload.candidates;
  if (!Array.isArray(candidates)) {
    return '';
  }

  const firstCandidate = candidates[0];
  if (!isPlainRecord(firstCandidate)) {
    return '';
  }

  const content = firstCandidate.content;
  if (!isPlainRecord(content) || !Array.isArray(content.parts)) {
    return '';
  }

  return content.parts
    .map((part) => (isPlainRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
};

function normalizeProvider(value: string | undefined): ReviewCloudProvider {
  if (value === 'bedrock' || value === 'aws-bedrock' || value === 'aws') return 'bedrock';
  if (value === 'azure' || value === 'azure-openai') return 'azure-openai';
  if (value === 'anthropic' || value === 'google' || value === 'openai') return value;
  return 'openai';
}

const extractAnthropicText = (payload: Record<string, unknown>): string => {
  const content = payload.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isPlainRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }

  if (typeof payload.output_text === 'string') {
    return payload.output_text;
  }

  return '';
};

const extractBedrockText = (payload: Record<string, unknown>): string => {
  const text = extractAnthropicText(payload);
  if (text) return text;

  if (typeof payload.content === 'string') {
    return payload.content;
  }

  return '';
};

const hexFromBytes = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const sha256Hex = async (input: string): Promise<string> => {
  const data = new TextEncoder().encode(input);
  return hexFromBytes(await crypto.subtle.digest('SHA-256', data));
};

const hmacSha256 = async (key: ArrayBuffer, data: string): Promise<ArrayBuffer> => {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
};

const deriveSigningKey = async (
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> => {
  const kSecret = new TextEncoder().encode(`AWS4${secretAccessKey}`);
  const kDate = await hmacSha256(kSecret.buffer, date);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
};

const canonicalizeHeaders = (
  headers: Record<string, string>,
): {
  canonicalHeaders: string;
  signedHeaders: string;
} => {
  const entries = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase().trim(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  return {
    canonicalHeaders: entries.map(([key, value]) => `${key}:${value}\n`).join(''),
    signedHeaders: entries.map(([key]) => key).join(';'),
  };
};

const signBedrockRequest = async (params: {
  url: URL;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}): Promise<Record<string, string>> => {
  const amzDate = `${new Date().toISOString().replace(/[:-]|\..+/g, '')}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(params.body);

  const headers: Record<string, string> = {
    host: params.url.host,
    'content-type': 'application/json',
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (params.sessionToken) {
    headers['x-amz-security-token'] = params.sessionToken;
  }

  const { canonicalHeaders, signedHeaders } = canonicalizeHeaders(headers);
  const canonicalRequest = [
    'POST',
    params.url.pathname,
    params.url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    `${dateStamp}/${params.region}/bedrock/aws4_request`,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await deriveSigningKey(
    params.secretAccessKey,
    dateStamp,
    params.region,
    'bedrock',
  );
  const signature = hexFromBytes(await hmacSha256(signingKey, stringToSign));

  headers.authorization = [
    `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${dateStamp}/${params.region}/bedrock/aws4_request`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  return headers;
};

function resolveRequestConfig(
  provider: ReviewCloudProvider,
  model: string,
  apiBaseUrl: string,
  apiPath: string,
  apiKey: string,
  apiVersion?: string,
): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  extractText: (payload: Record<string, unknown>) => string;
} {
  if (provider === 'azure-openai') {
    const resolvedApiVersion = apiVersion?.trim() || DEFAULTS['azure-openai'].apiVersion;
    if (!resolvedApiVersion) {
      throw new ReviewError(
        'E007',
        'Cloud review LLM is not configured: missing Azure OpenAI API version',
      );
    }

    const path = `${apiPath.replace(/\/$/, '')}/${encodeURIComponent(
      model,
    )}/chat/completions?api-version=${encodeURIComponent(resolvedApiVersion)}`;
    return {
      url: new URL(path, apiBaseUrl).toString(),
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
      },
      body: {
        messages: [{ role: 'user', content: '' }],
        temperature: 0,
      },
      extractText: extractOpenAiText,
    };
  }

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
      extractText: extractGoogleText,
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
      extractText: extractAnthropicText,
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
    extractText: extractOpenAiText,
  };
}

export function createCloudReviewLLMService(options: CloudProviderOptions = {}): ReviewLLMService {
  const provider = options.provider ?? normalizeProvider(process.env.GNOSIS_REVIEW_LLM_PROVIDER);
  const defaults = DEFAULTS[provider];
  const apiBaseUrl =
    options.apiBaseUrl ?? process.env.GNOSIS_REVIEW_LLM_API_BASE_URL ?? defaults.baseUrl;
  const apiPath = options.apiPath ?? process.env.GNOSIS_REVIEW_LLM_API_PATH ?? defaults.path;
  const apiVersion =
    options.apiVersion ?? process.env.GNOSIS_REVIEW_LLM_API_VERSION ?? defaults.apiVersion;
  const timeoutMs = options.timeoutMs ?? REVIEW_LIMITS.LLM_TIMEOUT_MS;
  const apiKey = options.apiKey ?? process.env.GNOSIS_REVIEW_LLM_API_KEY;
  const model = options.model ?? process.env.GNOSIS_REVIEW_LLM_MODEL;
  const awsRegion = options.awsRegion ?? process.env.AWS_REGION;
  const awsAccessKeyId = options.awsAccessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
  const awsSecretAccessKey = options.awsSecretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
  const awsSessionToken = options.awsSessionToken ?? process.env.AWS_SESSION_TOKEN;
  const bedrockInferenceProfileId =
    options.bedrockInferenceProfileId ?? process.env.GNOSIS_REVIEW_LLM_BEDROCK_INFERENCE_PROFILE_ID;
  const bedrockModelId = options.bedrockModelId ?? process.env.GNOSIS_REVIEW_LLM_BEDROCK_MODEL_ID;

  if (provider === 'bedrock') {
    if (!awsRegion) {
      throw new ReviewError('E007', 'Cloud review LLM is not configured: missing AWS region');
    }
    if (!awsAccessKeyId || !awsSecretAccessKey) {
      throw new ReviewError(
        'E007',
        'Cloud review LLM is not configured: missing AWS access key or secret access key',
      );
    }
    if (!bedrockInferenceProfileId && !bedrockModelId) {
      throw new ReviewError(
        'E007',
        'Cloud review LLM is not configured: missing Bedrock model id or inference profile id',
      );
    }
  } else {
    if (!apiKey) {
      throw new ReviewError('E007', 'Cloud review LLM is not configured: missing API key');
    }
    if (!model) {
      throw new ReviewError('E007', 'Cloud review LLM is not configured: missing model');
    }
  }
  if (provider === 'azure-openai' && !apiBaseUrl) {
    throw new ReviewError(
      'E007',
      'Cloud review LLM is not configured: missing Azure OpenAI endpoint',
    );
  }

  return {
    provider: 'cloud',
    async generate(prompt: string, opts = {}): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        if (provider === 'bedrock') {
          const resolvedRegion = awsRegion as string;
          const identifier = bedrockInferenceProfileId ?? bedrockModelId;
          const baseUrl = apiBaseUrl || `https://bedrock-runtime.${resolvedRegion}.amazonaws.com`;
          const path = `${apiPath.replace(/\/$/, '')}/model/${encodeURIComponent(
            identifier as string,
          )}/invoke`;
          const url = new URL(path, baseUrl).toString();
          const body = JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 4096,
            temperature: 0,
            ...(opts.format === 'json' ? { system: 'Return JSON only.' } : {}),
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: prompt }],
              },
            ],
          });

          const headers = await signBedrockRequest({
            url: new URL(url),
            body,
            accessKeyId: awsAccessKeyId as string,
            secretAccessKey: awsSecretAccessKey as string,
            sessionToken: awsSessionToken,
            region: resolvedRegion,
          });

          const response = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers,
            body,
          });

          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new ReviewError('E007', `Cloud LLM request failed (${response.status}): ${text}`);
          }

          const payload = (await response.json()) as Record<string, unknown>;
          const content = extractBedrockText(payload);

          if (!content.trim()) {
            throw new ReviewError('E007', 'Cloud LLM returned an empty response');
          }

          return content.trim();
        }

        const request = resolveRequestConfig(
          provider,
          model as string,
          apiBaseUrl,
          apiPath,
          apiKey as string,
          apiVersion,
        );
        const body =
          provider === 'azure-openai'
            ? {
                ...request.body,
                messages: [{ role: 'user', content: prompt }],
                ...(opts.format === 'json' ? { response_format: { type: 'json_object' } } : {}),
              }
            : provider === 'google'
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
