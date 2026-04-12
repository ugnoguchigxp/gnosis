import { config } from '../config.js';
import { listMemoriesByMetadata, saveMemory, searchMemory } from '../services/memory.js';

type OpenAICompatibleResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

type Args = {
  prompt?: string;
  sessionId: string;
  limit: number;
  model?: string;
  apiBaseUrl: string;
  apiPath: string;
  apiKeyEnv: string;
  temperature: number;
  store: boolean;
  guidanceEnabled: boolean;
  guidanceSessionId: string;
  guidanceAlwaysLimit: number;
  guidanceOnDemandLimit: number;
  guidanceMinSimilarity: number;
  guidanceMaxChars: number;
  guidanceProject?: string;
};

const DEFAULT_API_BASE_URL = config.llmharness.defaultApiBaseUrl;
const DEFAULT_API_PATH = config.llmharness.defaultApiPath;
const DEFAULT_API_KEY_ENV = config.llmharness.defaultApiKeyEnv;
const DEFAULT_MODEL = config.llmharness.defaultModel;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return fallback;
}

function parseArgValue(argv: string[], key: string): string | undefined {
  const idx = argv.indexOf(key);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function hasArg(argv: string[], key: string): boolean {
  return argv.includes(key);
}

async function readStdinIfAny(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) return '';
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim();
}

function parseArgs(argv: string[]): Args {
  const sessionId =
    parseArgValue(argv, '--session-id') || process.env.GNOSIS_SESSION_ID || 'llmharness';
  const limitRaw = parseArgValue(argv, '--limit') || process.env.GNOSIS_CONTEXT_LIMIT || '5';
  const temperatureRaw =
    parseArgValue(argv, '--temperature') || process.env.LOCAL_LLM_TEMPERATURE || '0';
  const guidanceAlwaysLimitRaw =
    parseArgValue(argv, '--guidance-always-limit') || String(config.guidance.alwaysLimit);
  const guidanceOnDemandLimitRaw =
    parseArgValue(argv, '--guidance-on-demand-limit') || String(config.guidance.onDemandLimit);
  const guidanceMinSimilarityRaw =
    parseArgValue(argv, '--guidance-min-similarity') || String(config.guidance.minSimilarity);
  const guidanceMaxCharsRaw =
    parseArgValue(argv, '--guidance-max-chars') || String(config.guidance.maxPromptChars);
  const guidanceDisabled = hasArg(argv, '--no-guidance');

  const limit = Number(limitRaw);
  const temperature = Number(temperatureRaw);
  const guidanceAlwaysLimit = Number(guidanceAlwaysLimitRaw);
  const guidanceOnDemandLimit = Number(guidanceOnDemandLimitRaw);
  const guidanceMinSimilarity = Number(guidanceMinSimilarityRaw);
  const guidanceMaxChars = Number(guidanceMaxCharsRaw);

  return {
    prompt: parseArgValue(argv, '--prompt'),
    sessionId,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5,
    model: parseArgValue(argv, '--model') || process.env.LOCAL_LLM_MODEL || DEFAULT_MODEL,
    apiBaseUrl:
      parseArgValue(argv, '--api-base-url') ||
      process.env.LOCAL_LLM_API_BASE_URL ||
      DEFAULT_API_BASE_URL,
    apiPath:
      parseArgValue(argv, '--api-path') || process.env.LOCAL_LLM_API_PATH || DEFAULT_API_PATH,
    apiKeyEnv:
      parseArgValue(argv, '--api-key-env') ||
      process.env.LOCAL_LLM_API_KEY_ENV ||
      DEFAULT_API_KEY_ENV,
    temperature: Number.isFinite(temperature) ? temperature : 0,
    store:
      hasArg(argv, '--store') ||
      (process.env.GNOSIS_LLMHARNESS_STORE || '').toLowerCase() === 'true',
    guidanceEnabled:
      !guidanceDisabled &&
      parseBoolean(process.env.GUIDANCE_ENABLED, config.guidance.enabled ?? true),
    guidanceSessionId:
      parseArgValue(argv, '--guidance-session-id') ||
      process.env.GUIDANCE_SESSION_ID ||
      config.guidance.sessionId,
    guidanceAlwaysLimit:
      Number.isFinite(guidanceAlwaysLimit) && guidanceAlwaysLimit > 0
        ? Math.floor(guidanceAlwaysLimit)
        : config.guidance.alwaysLimit,
    guidanceOnDemandLimit:
      Number.isFinite(guidanceOnDemandLimit) && guidanceOnDemandLimit > 0
        ? Math.floor(guidanceOnDemandLimit)
        : config.guidance.onDemandLimit,
    guidanceMinSimilarity: Number.isFinite(guidanceMinSimilarity)
      ? guidanceMinSimilarity
      : config.guidance.minSimilarity,
    guidanceMaxChars:
      Number.isFinite(guidanceMaxChars) && guidanceMaxChars > 0
        ? Math.floor(guidanceMaxChars)
        : config.guidance.maxPromptChars,
    guidanceProject:
      parseArgValue(argv, '--guidance-project') || process.env.GUIDANCE_PROJECT || undefined,
  };
}

function resolveUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const texts = content
    .map((part) => {
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter(Boolean);

  return texts.join('\n');
}

function formatMemoryContext(
  memories: Array<{
    content: string;
    similarity: unknown;
    metadata: unknown;
    createdAt: unknown;
  }>,
): string {
  if (memories.length === 0) return '';

  const lines = memories.map((m, idx) => {
    const score = Number(m.similarity);
    const metadata = m.metadata ? JSON.stringify(m.metadata) : '{}';
    const createdAt = m.createdAt ? String(m.createdAt) : '';
    return [
      `#${idx + 1} similarity=${Number.isFinite(score) ? score.toFixed(4) : 'n/a'}`,
      `createdAt=${createdAt}`,
      `metadata=${metadata}`,
      `content=${m.content}`,
    ].join('\n');
  });

  return lines.join('\n\n');
}

type GuidanceItem = {
  content: string;
  similarity?: unknown;
  metadata: unknown;
  createdAt: unknown;
};

function formatGuidanceContext(items: GuidanceItem[], maxChars: number): string {
  if (items.length === 0) return '';

  const blocks: string[] = [];
  let usedChars = 0;

  for (const [index, item] of items.entries()) {
    const metadata =
      item.metadata && typeof item.metadata === 'object'
        ? (item.metadata as Record<string, unknown>)
        : {};
    const priority =
      typeof metadata.priority === 'number' && Number.isFinite(metadata.priority)
        ? metadata.priority
        : 0;
    const title = typeof metadata.title === 'string' ? metadata.title : 'untitled';
    const docPath = typeof metadata.docPath === 'string' ? metadata.docPath : '';
    const guidanceType =
      typeof metadata.guidanceType === 'string' ? metadata.guidanceType : 'guidance';
    const scope = typeof metadata.scope === 'string' ? metadata.scope : '';
    const similarity =
      item.similarity === undefined || item.similarity === null
        ? 'n/a'
        : Number(item.similarity).toFixed(4);

    const block = [
      `#${
        index + 1
      } type=${guidanceType} scope=${scope} priority=${priority} similarity=${similarity}`,
      `title=${title}`,
      docPath ? `docPath=${docPath}` : '',
      `content=${item.content}`,
    ]
      .filter((line) => line.length > 0)
      .join('\n');

    const nextSize = usedChars + block.length + (blocks.length > 0 ? 2 : 0);
    if (nextSize > maxChars && blocks.length > 0) {
      break;
    }

    blocks.push(block);
    usedChars = nextSize;
  }

  return blocks.join('\n\n');
}

async function loadGuidanceContext(
  args: Args,
  prompt: string,
): Promise<{
  guidanceContext: string;
  alwaysCount: number;
  onDemandCount: number;
}> {
  if (!args.guidanceEnabled) {
    return { guidanceContext: '', alwaysCount: 0, onDemandCount: 0 };
  }

  const alwaysFilter: Record<string, unknown> = {
    kind: 'guidance',
    scope: 'always',
  };
  const onDemandFilter: Record<string, unknown> = {
    kind: 'guidance',
    scope: 'on_demand',
  };

  if (args.guidanceProject) {
    alwaysFilter.project = args.guidanceProject;
    onDemandFilter.project = args.guidanceProject;
  }

  const always = await listMemoriesByMetadata(
    args.guidanceSessionId,
    alwaysFilter,
    args.guidanceAlwaysLimit,
    { sortByPriority: true },
  ).catch(() => []);

  const onDemandRaw = await searchMemory(
    args.guidanceSessionId,
    prompt,
    args.guidanceOnDemandLimit,
    onDemandFilter,
  ).catch(() => []);

  const onDemand = onDemandRaw.filter((item) => {
    const similarity = Number(item.similarity);
    return Number.isFinite(similarity) && similarity >= args.guidanceMinSimilarity;
  });

  const formatted = formatGuidanceContext(
    [
      ...always.map((item) => ({
        content: item.content,
        metadata: item.metadata,
        createdAt: item.createdAt,
      })),
      ...onDemand.map((item) => ({
        content: item.content,
        metadata: item.metadata,
        similarity: item.similarity,
        createdAt: item.createdAt,
      })),
    ],
    args.guidanceMaxChars,
  );

  return {
    guidanceContext: formatted,
    alwaysCount: always.length,
    onDemandCount: onDemand.length,
  };
}

async function generateWithApi(prompt: string, args: Args): Promise<string> {
  const apiKey = process.env[args.apiKeyEnv];
  const response = await fetch(resolveUrl(args.apiBaseUrl, args.apiPath), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: args.model,
      temperature: args.temperature,
      messages: [
        {
          role: 'system',
          content: 'Return only a patch operation JSON for the harness.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`local LLM API error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as OpenAICompatibleResponse;
  const content = contentToString(data.choices?.[0]?.message?.content);
  if (!content.trim()) {
    throw new Error('local LLM API returned empty content');
  }

  return content;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stdinPrompt = await readStdinIfAny();
  const prompt = (args.prompt || stdinPrompt || '').trim();

  if (!prompt) {
    throw new Error('prompt is required. pass --prompt or stdin');
  }

  const [memories, guidanceResult] = await Promise.all([
    searchMemory(args.sessionId, prompt, args.limit).catch(() => []),
    args.guidanceEnabled
      ? loadGuidanceContext(args, prompt).catch(() => ({
          guidanceContext: '',
          alwaysCount: 0,
          onDemandCount: 0,
        }))
      : Promise.resolve({ guidanceContext: '', alwaysCount: 0, onDemandCount: 0 }),
  ]);
  const guidanceContext = guidanceResult.guidanceContext;

  const memoryContext = formatMemoryContext(
    memories.map((m: GuidanceItem) => ({
      content: m.content,
      similarity: m.similarity,
      metadata: m.metadata,
      createdAt: m.createdAt,
    })),
  );

  const promptParts: string[] = [];

  if (guidanceContext) {
    promptParts.push('[Guidance & Skills]');
    promptParts.push(guidanceContext);
    promptParts.push('');
  }

  if (memoryContext) {
    promptParts.push('You are given retrieved memory context from previous coding sessions.');
    promptParts.push('Use relevant facts only when helpful.');
    promptParts.push('');
    promptParts.push('[Retrieved Memory]');
    promptParts.push(memoryContext);
    promptParts.push('');
  }

  promptParts.push('[Current Request]');
  promptParts.push(prompt);
  const augmentedPrompt = promptParts.join('\n');

  const generated = await generateWithApi(augmentedPrompt, args);

  if (args.store) {
    await saveMemory(args.sessionId, `Prompt:\n${prompt}\n\nResponse:\n${generated}`, {
      source: 'llmharness.localLlm',
      model: args.model,
      contextCount: memories.length,
      hasGuidance: Boolean(guidanceContext),
    }).catch(() => {});
  }

  process.stdout.write(
    JSON.stringify({
      response: generated,
      summary: `Generated with Gnosis context (${memories.length} memories${
        guidanceContext ? ', with guidance' : ''
      })`,
      rawResponse: {
        sessionId: args.sessionId,
        contextCount: memories.length,
        hasGuidance: Boolean(guidanceContext),
      },
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
