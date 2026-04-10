import { saveMemory, searchMemory } from '../services/memory.js';

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
};

const DEFAULT_API_BASE_URL = 'http://localhost:8000';
const DEFAULT_API_PATH = '/v1/chat/completions';
const DEFAULT_API_KEY_ENV = 'LOCAL_LLM_API_KEY';
const DEFAULT_MODEL = 'gemma4-default';

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

  const limit = Number(limitRaw);
  const temperature = Number(temperatureRaw);

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

  const memories = await searchMemory(args.sessionId, prompt, args.limit).catch(() => []);
  const memoryContext = formatMemoryContext(
    memories.map((m) => ({
      content: m.content,
      similarity: m.similarity,
      metadata: m.metadata,
      createdAt: m.createdAt,
    })),
  );

  const augmentedPrompt = memoryContext
    ? [
        'You are given retrieved memory context from previous coding sessions.',
        'Use relevant facts only when helpful.',
        '',
        '[Retrieved Memory]',
        memoryContext,
        '',
        '[Current Request]',
        prompt,
      ].join('\n')
    : prompt;

  const generated = await generateWithApi(augmentedPrompt, args);

  if (args.store) {
    await saveMemory(args.sessionId, `Prompt:\n${prompt}\n\nResponse:\n${generated}`, {
      source: 'llmharness.localLlm',
      model: args.model,
      contextCount: memories.length,
    }).catch(() => {});
  }

  process.stdout.write(
    JSON.stringify({
      response: generated,
      summary: `Generated with Gnosis context (${memories.length} memories)`,
      rawResponse: {
        sessionId: args.sessionId,
        contextCount: memories.length,
      },
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
