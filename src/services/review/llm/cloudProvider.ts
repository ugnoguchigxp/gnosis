import { GNOSIS_CONSTANTS } from '../../../constants.js';
import { REVIEW_LIMITS, ReviewError } from '../errors.js';
import type {
  ChatMessage,
  LLMGenerateResult,
  LLMToolDefinition,
  LLMUsage,
  NativeToolCall,
  ReviewLLMService,
} from './types.js';

export type ReviewCloudProvider = 'openai' | 'bedrock' | 'azure-openai' | 'anthropic' | 'google';
type EffectiveReviewCloudProvider = Exclude<ReviewCloudProvider, 'openai'>;

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
    baseUrl: '',
    path: '/openai/deployments',
    apiVersion: '2025-04-01-preview',
  },
  bedrock: {
    baseUrl: '',
    path: '',
  },
  'azure-openai': {
    baseUrl: '',
    path: '/openai/deployments',
    apiVersion: '2025-04-01-preview',
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

export function resolveEffectiveReviewCloudProvider(
  provider: ReviewCloudProvider,
): EffectiveReviewCloudProvider {
  return provider === 'openai' ? 'azure-openai' : provider;
}

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

const extractUsage = (payload: Record<string, unknown>): LLMUsage | undefined => {
  const usage = payload.usage;
  if (!isPlainRecord(usage)) return undefined;
  const promptTokens =
    typeof usage.prompt_tokens === 'number'
      ? usage.prompt_tokens
      : typeof usage.input_tokens === 'number'
        ? usage.input_tokens
        : undefined;
  const completionTokens =
    typeof usage.completion_tokens === 'number'
      ? usage.completion_tokens
      : typeof usage.output_tokens === 'number'
        ? usage.output_tokens
        : undefined;
  const totalTokens =
    typeof usage.total_tokens === 'number'
      ? usage.total_tokens
      : promptTokens !== undefined || completionTokens !== undefined
        ? (promptTokens ?? 0) + (completionTokens ?? 0)
        : undefined;
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens };
};

function normalizeProvider(value: string | undefined): ReviewCloudProvider {
  if (value === 'bedrock' || value === 'aws-bedrock' || value === 'aws') return 'bedrock';
  if (value === 'azure' || value === 'azure-openai' || value === 'openai') return 'azure-openai';
  if (value === 'anthropic' || value === 'google') return value;
  return 'azure-openai';
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

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

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

const getBedrockIdentifiers = (options: {
  bedrockInferenceProfileId?: string;
  bedrockModelId?: string;
}): string[] => {
  const identifiers = [options.bedrockInferenceProfileId, options.bedrockModelId].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  return [...new Set(identifiers)];
};

async function runBedrockRequest(params: {
  identifiers: string[];
  apiBaseUrl: string;
  apiPath: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken?: string;
  body: string;
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  let lastStatusText = '';
  const triedIdentifiers: string[] = [];

  for (const identifier of params.identifiers) {
    triedIdentifiers.push(identifier);
    const baseUrl =
      params.apiBaseUrl || `https://bedrock-runtime.${params.awsRegion}.amazonaws.com`;
    const path = `${params.apiPath.replace(/\/$/, '')}/model/${encodeURIComponent(
      identifier,
    )}/invoke`;
    const url = new URL(path, baseUrl).toString();
    const headers = await signBedrockRequest({
      url: new URL(url),
      body: params.body,
      accessKeyId: params.awsAccessKeyId,
      secretAccessKey: params.awsSecretAccessKey,
      sessionToken: params.awsSessionToken,
      region: params.awsRegion,
    });

    const response = await fetch(url, {
      method: 'POST',
      signal: params.signal,
      headers,
      body: params.body,
    });

    if (response.ok) {
      return (await response.json()) as Record<string, unknown>;
    }

    const text = await response.text().catch(() => '');
    lastStatusText = `(${response.status}) ${text}`;
    if (response.status !== 404) {
      throw new ReviewError('E007', `Cloud LLM request failed ${lastStatusText}`);
    }
  }

  const triedText =
    triedIdentifiers.length > 0 ? ` Tried identifiers: ${triedIdentifiers.join(', ')}` : '';
  throw new ReviewError(
    'E007',
    `Cloud LLM request failed ${lastStatusText || '(404)'}${triedText}`,
  );
}

function getProviderApiKeyEnv(provider: EffectiveReviewCloudProvider): string | undefined {
  switch (provider) {
    case 'azure-openai':
      return process.env.AZURE_OPENAI_API_KEY;
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    case 'google':
      return process.env.GOOGLE_API_KEY;
    case 'bedrock':
      return undefined;
  }
}

function getProviderModelEnv(provider: EffectiveReviewCloudProvider): string | undefined {
  switch (provider) {
    case 'azure-openai':
      return process.env.AZURE_OPENAI_MODEL;
    case 'anthropic':
      return process.env.ANTHROPIC_MODEL;
    case 'google':
      return process.env.GOOGLE_MODEL;
    case 'bedrock':
      return undefined;
  }
}

function getProviderApiKeyEnvName(provider: EffectiveReviewCloudProvider): string {
  switch (provider) {
    case 'azure-openai':
      return 'AZURE_OPENAI_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'google':
      return 'GOOGLE_API_KEY';
    case 'bedrock':
      return 'AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY';
  }
}

function getProviderModelEnvName(provider: EffectiveReviewCloudProvider): string {
  switch (provider) {
    case 'azure-openai':
      return 'AZURE_OPENAI_MODEL';
    case 'anthropic':
      return 'ANTHROPIC_MODEL';
    case 'google':
      return 'GOOGLE_MODEL';
    case 'bedrock':
      return 'GNOSIS_REVIEW_LLM_BEDROCK_MODEL_ID';
  }
}

export function createCloudReviewLLMService(options: CloudProviderOptions = {}): ReviewLLMService {
  const requestedProvider =
    options.provider ??
    normalizeProvider(
      process.env.GNOSIS_REVIEW_LLM_PROVIDER || GNOSIS_CONSTANTS.REVIEW_LLM_PROVIDER_DEFAULT,
    );
  const provider = resolveEffectiveReviewCloudProvider(requestedProvider);
  const defaults = DEFAULTS[provider];
  const apiBaseUrl =
    options.apiBaseUrl ??
    (provider === 'bedrock'
      ? defaults.baseUrl
      : process.env.GNOSIS_REVIEW_LLM_API_BASE_URL ??
        GNOSIS_CONSTANTS.REVIEW_LLM_API_BASE_URL_DEFAULT ??
        defaults.baseUrl);
  const apiPath =
    options.apiPath ??
    (provider === 'bedrock'
      ? defaults.path
      : process.env.GNOSIS_REVIEW_LLM_API_PATH ?? defaults.path);
  const apiVersion =
    options.apiVersion ?? process.env.GNOSIS_REVIEW_LLM_API_VERSION ?? defaults.apiVersion;
  const timeoutMs = options.timeoutMs ?? REVIEW_LIMITS.LLM_TIMEOUT_MS;
  const providerApiKeyEnv = getProviderApiKeyEnv(provider);
  const providerModelEnv = getProviderModelEnv(provider);
  const apiKey = options.apiKey ?? providerApiKeyEnv ?? process.env.GNOSIS_REVIEW_LLM_API_KEY;
  const model =
    options.model ??
    providerModelEnv ??
    process.env.GNOSIS_REVIEW_LLM_MODEL ??
    (provider === 'azure-openai' ? GNOSIS_CONSTANTS.AZURE_OPENAI_MODEL_DEFAULT : undefined);
  const awsRegion =
    options.awsRegion ?? process.env.AWS_REGION ?? GNOSIS_CONSTANTS.AWS_REGION_DEFAULT;
  const awsAccessKeyId = options.awsAccessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
  const awsSecretAccessKey = options.awsSecretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
  const awsSessionToken = options.awsSessionToken ?? process.env.AWS_SESSION_TOKEN;
  const bedrockInferenceProfileId =
    options.bedrockInferenceProfileId ??
    process.env.GNOSIS_REVIEW_LLM_BEDROCK_INFERENCE_PROFILE_ID ??
    (options.bedrockModelId ? undefined : GNOSIS_CONSTANTS.BEDROCK_INFERENCE_PROFILE_ID_DEFAULT);
  const bedrockModelId =
    options.bedrockModelId ??
    process.env.GNOSIS_REVIEW_LLM_BEDROCK_MODEL_ID ??
    GNOSIS_CONSTANTS.BEDROCK_MODEL_ID_DEFAULT;

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
      const envVarName = getProviderApiKeyEnvName(provider);
      throw new ReviewError(
        'E007',
        `Cloud review LLM is not configured: missing API key (set ${envVarName} in .env or pass --api-key)`,
      );
    }
    if (!model) {
      const envVarName = getProviderModelEnvName(provider);
      throw new ReviewError(
        'E007',
        `Cloud review LLM is not configured: missing model (set ${envVarName} in .env or pass --model)`,
      );
    }
  }
  if (provider === 'azure-openai' && !apiBaseUrl) {
    throw new ReviewError(
      'E007',
      'Cloud review LLM is not configured: missing Azure OpenAI endpoint',
    );
  }

  // Internal: generate text (no tool schema) — shared by generateMessages and
  // the google/anthropic fallback in generateMessagesStructured
  async function callTextGenerate(
    messages: ChatMessage[],
    opts: { format?: 'json' | 'text' },
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (provider === 'bedrock') {
        const systemMsg = messages.find((m) => m.role === 'system')?.content;
        const chatMsgs = messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role, content: [{ type: 'text', text: m.content }] }));
        const body = JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 4096,
          temperature: 0,
          ...(systemMsg ? { system: systemMsg } : {}),
          ...(opts.format === 'json' ? { system: systemMsg ?? 'Return JSON only.' } : {}),
          messages: chatMsgs,
        });
        const payload = await runBedrockRequest({
          identifiers: getBedrockIdentifiers({ bedrockInferenceProfileId, bedrockModelId }),
          apiBaseUrl,
          apiPath,
          awsRegion: awsRegion as string,
          awsAccessKeyId: awsAccessKeyId as string,
          awsSecretAccessKey: awsSecretAccessKey as string,
          awsSessionToken,
          body,
          signal: controller.signal,
        });
        const content = extractBedrockText(payload);
        if (!content.trim()) throw new ReviewError('E007', 'Cloud LLM returned an empty response');
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
      const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));
      const body =
        provider === 'google'
          ? {
              contents: apiMessages
                .filter((m) => m.role !== 'system')
                .map((m) => ({
                  role: m.role === 'assistant' ? 'model' : 'user',
                  parts: [{ text: m.content }],
                })),
              systemInstruction: messages.find((m) => m.role === 'system')
                ? { parts: [{ text: messages.find((m) => m.role === 'system')?.content }] }
                : undefined,
              generationConfig: {
                temperature: 0,
                ...(opts.format === 'json' ? { responseMimeType: 'application/json' } : {}),
              },
            }
          : provider === 'anthropic'
            ? {
                ...request.body,
                system: messages.find((m) => m.role === 'system')?.content,
                messages: apiMessages.filter((m) => m.role !== 'system'),
                ...(opts.format === 'json' ? { tools: [] } : {}),
              }
            : {
                ...request.body,
                messages: apiMessages,
                max_completion_tokens: 4096,
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
      const choices = payload.choices as Array<{ message: { content: string } }> | undefined;
      const content =
        choices?.[0]?.message?.content ??
        extractAnthropicText(payload) ??
        extractGoogleText(payload) ??
        '';
      if (!content.trim()) throw new ReviewError('E007', 'Cloud LLM returned an empty response');
      return content.trim();
    } catch (error) {
      if (error instanceof ReviewError) throw error;
      if (isAbortError(error)) {
        throw new ReviewError('E006', `Cloud LLM request timed out after ${timeoutMs}ms`);
      }
      throw new ReviewError('E007', `Cloud LLM request failed: ${error}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    provider: 'cloud',
    async generateMessages(
      messages: ChatMessage[],
      opts: { format?: 'json' | 'text' } = {},
    ): Promise<string> {
      return callTextGenerate(messages, opts);
    },
    async generateMessagesStructured(
      messages: ChatMessage[],
      opts: { format?: 'json' | 'text'; tools?: LLMToolDefinition[] } = {},
    ): Promise<LLMGenerateResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        if (provider === 'bedrock') {
          const systemMsg = messages.find((m) => m.role === 'system')?.content;
          const chatMsgs = messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role, content: [{ type: 'text' as const, text: m.content }] }));
          const anthropicTools = (opts.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          }));
          const body = JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 4096,
            temperature: 0,
            ...(systemMsg ? { system: systemMsg } : {}),
            messages: chatMsgs,
            ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
          });
          const payload = await runBedrockRequest({
            identifiers: getBedrockIdentifiers({ bedrockInferenceProfileId, bedrockModelId }),
            apiBaseUrl,
            apiPath,
            awsRegion: awsRegion as string,
            awsAccessKeyId: awsAccessKeyId as string,
            awsSecretAccessKey: awsSecretAccessKey as string,
            awsSessionToken,
            body,
            signal: controller.signal,
          });
          const contentBlocks = Array.isArray(payload.content)
            ? (payload.content as Array<Record<string, unknown>>)
            : [];
          const textParts = contentBlocks
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text as string);
          const toolCalls: NativeToolCall[] = contentBlocks
            .filter((b) => b.type === 'tool_use')
            .map((b) => ({
              id: String(b.id ?? ''),
              name: String(b.name ?? ''),
              arguments: Object.fromEntries(
                Object.entries((b.input ?? {}) as Record<string, unknown>).map(([k, v]) => [
                  k,
                  typeof v === 'string' ? v : JSON.stringify(v),
                ]),
              ),
            }));
          return {
            text: textParts.join(''),
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            rawAssistantContent: contentBlocks,
            usage: extractUsage(payload),
          };
        }

        // Azure OpenAI path, including the openai compatibility alias (native tool_calls)
        // google / anthropic: delegate to callTextGenerate (text-only, no tool_calls)
        if (provider !== 'azure-openai') {
          const textResult = await callTextGenerate(messages, opts);
          return { text: textResult };
        }
        const request = resolveRequestConfig(
          provider,
          model as string,
          apiBaseUrl,
          apiPath,
          apiKey as string,
          apiVersion,
        );
        const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));
        const openaiTools = (opts.tools ?? []).map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        const bodyObj: Record<string, unknown> = {
          ...request.body,
          messages: apiMessages,
          max_completion_tokens: 4096,
          ...(opts.format === 'json' ? { response_format: { type: 'json_object' } } : {}),
          ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
        };
        const response = await fetch(request.url, {
          method: 'POST',
          signal: controller.signal,
          headers: request.headers,
          body: JSON.stringify(bodyObj),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new ReviewError('E007', `Cloud LLM request failed (${response.status}): ${text}`);
        }
        const payload = (await response.json()) as Record<string, unknown>;
        const choices = payload.choices as
          | Array<{
              message: {
                content?: string;
                tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
              };
            }>
          | undefined;
        const msg = choices?.[0]?.message;
        const text = msg?.content ?? '';
        const toolCalls: NativeToolCall[] = (msg?.tool_calls ?? []).map((tc) => {
          let args: Record<string, string> = {};
          try {
            const parsed = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            args = Object.fromEntries(
              Object.entries(parsed).map(([k, v]) => [
                k,
                typeof v === 'string' ? v : JSON.stringify(v),
              ]),
            );
          } catch {
            /* ignore */
          }
          return { id: tc.id, name: tc.function.name, arguments: args };
        });
        return {
          text,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage: extractUsage(payload),
        };
      } catch (error) {
        if (error instanceof ReviewError) throw error;
        if (isAbortError(error)) {
          throw new ReviewError('E006', `Cloud LLM request timed out after ${timeoutMs}ms`);
        }
        throw new ReviewError('E007', `Cloud LLM request failed: ${error}`);
      } finally {
        clearTimeout(timer);
      }
    },
    async generate(prompt: string, opts = {}): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        if (provider === 'bedrock') {
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

          const payload = await runBedrockRequest({
            identifiers: getBedrockIdentifiers({
              bedrockInferenceProfileId,
              bedrockModelId,
            }),
            apiBaseUrl,
            apiPath,
            awsRegion: awsRegion as string,
            awsAccessKeyId: awsAccessKeyId as string,
            awsSecretAccessKey: awsSecretAccessKey as string,
            awsSessionToken,
            body,
            signal: controller.signal,
          });
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
        if (isAbortError(error)) {
          throw new ReviewError('E006', `Cloud LLM request timed out after ${timeoutMs}ms`);
        }
        throw new ReviewError('E007', `Cloud LLM request failed: ${error}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
