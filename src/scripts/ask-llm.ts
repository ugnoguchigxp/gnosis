#!/usr/bin/env bun

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
  type ReviewCloudProvider,
  createCloudReviewLLMService,
} from '../services/review/llm/cloudProvider.js';

type CliMode = 'interactive' | 'single';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type SessionRecord = {
  session_id: string;
  created_at: string;
  updated_at: string;
  provider: ReviewCloudProvider;
  model: string;
  messages: ChatMessage[];
};

type BedrockCliArgs = {
  provider: ReviewCloudProvider;
  prompt?: string;
  output: 'text' | 'json';
  mode: CliMode;
  sessionId?: string;
  sessionDir?: string;
  noSession: boolean;
  modelId?: string;
  inferenceProfileId?: string;
  region?: string;
  apiBaseUrl?: string;
  apiVersion?: string;
};

const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const DEFAULT_SESSION_DIR = path.resolve(os.homedir(), '.localLlm', 'sessions');

function loadEnvFile(filePath = path.resolve(process.cwd(), '.env')): void {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex <= 0) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    const rawValue = trimmed.slice(equalIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getArg(argv: string[], key: string): string | undefined {
  const index = argv.indexOf(key);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('Invalid --session-id. Use 6-64 chars: A-Z a-z 0-9 _ -');
  }
}

function generateSessionId(): string {
  return `sess_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function getSessionPath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.json`);
}

function loadSession(sessionDir: string, sessionId: string): SessionRecord | null {
  const filePath = getSessionPath(sessionDir, sessionId);
  if (!fs.existsSync(filePath)) return null;

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<SessionRecord>;
  if (!Array.isArray(parsed.messages)) return null;

  return {
    session_id: typeof parsed.session_id === 'string' ? parsed.session_id : sessionId,
    created_at:
      typeof parsed.created_at === 'string' ? parsed.created_at : new Date().toISOString(),
    updated_at:
      typeof parsed.updated_at === 'string' ? parsed.updated_at : new Date().toISOString(),
    provider: parsed.provider === 'openai' ? 'openai' : 'bedrock',
    model: typeof parsed.model === 'string' ? parsed.model : '',
    messages: parsed.messages.filter((item): item is ChatMessage =>
      Boolean(
        item &&
          typeof item === 'object' &&
          (item as ChatMessage).role &&
          typeof (item as ChatMessage).content === 'string',
      ),
    ),
  };
}

function saveSession(sessionDir: string, record: SessionRecord): void {
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    getSessionPath(sessionDir, record.session_id),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function buildConversationPrompt(history: ChatMessage[], userText: string): string {
  const transcript = history
    .map(
      (message) => `${message.role === 'user' ? 'ユーザー' : 'アシスタント'}: ${message.content}`,
    )
    .join('\n');

  return [
    'あなたは有能な日本語アシスタントです。',
    '返答は自然で簡潔にしてください。',
    '以下は会話履歴です。必要に応じて文脈を踏まえて答えてください。',
    '',
    transcript ? `会話履歴:\n${transcript}\n` : '会話履歴: なし\n',
    `ユーザー: ${userText}`,
    'アシスタント:',
  ].join('\n');
}

function parseArgs(argv: string[]): BedrockCliArgs {
  const providerArg = (getArg(argv, '--provider') ?? 'bedrock') as ReviewCloudProvider;
  const promptArg = getArg(argv, '--prompt') ?? getArg(argv, '--input');
  const output = getArg(argv, '--output') === 'json' ? 'json' : 'text';
  const mode = argv.includes('--interactive') ? 'interactive' : 'single';

  const positionals = argv.filter((arg) => !arg.startsWith('--') && !arg.includes('='));
  const prompt = promptArg ?? (positionals.join(' ').trim() || undefined);

  return {
    provider: providerArg,
    prompt,
    output,
    mode: prompt ? 'single' : mode,
    sessionId: getArg(argv, '--session-id'),
    sessionDir: getArg(argv, '--session-dir'),
    noSession: argv.includes('--no-session'),
    modelId: getArg(argv, '--model-id'),
    inferenceProfileId: getArg(argv, '--inference-profile-id'),
    region: getArg(argv, '--region'),
    apiBaseUrl: getArg(argv, '--api-base-url'),
    apiVersion: getArg(argv, '--api-version'),
  };
}

function buildService(args: BedrockCliArgs) {
  return createCloudReviewLLMService({
    provider: args.provider,
    bedrockModelId: args.modelId,
    bedrockInferenceProfileId: args.inferenceProfileId,
    awsRegion: args.region,
    apiBaseUrl: args.apiBaseUrl,
    apiVersion: args.apiVersion,
  });
}

async function readStdinPrompt(): Promise<string> {
  if (input.isTTY) return '';

  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk.toString();
  }
  return buffer.trim();
}

async function runSingleTurn(args: BedrockCliArgs, prompt: string): Promise<void> {
  const service = buildService(args);
  const wantsSession = !args.noSession;
  const sessionDir = path.resolve(args.sessionDir ?? DEFAULT_SESSION_DIR);
  const sessionId = args.sessionId ?? (wantsSession ? generateSessionId() : undefined);

  if (sessionId) validateSessionId(sessionId);

  let history: ChatMessage[] = [];
  let sessionCreated = false;

  if (sessionId && wantsSession) {
    const loaded = loadSession(sessionDir, sessionId);
    if (loaded) {
      history = loaded.messages;
    } else {
      sessionCreated = true;
    }
  }

  const finalPrompt = buildConversationPrompt(history, prompt);
  const response = await service.generate(finalPrompt, {
    format: args.output === 'json' ? 'json' : 'text',
  });

  history.push({ role: 'user', content: prompt });
  history.push({ role: 'assistant', content: response.trim() });

  if (sessionId && wantsSession) {
    saveSession(sessionDir, {
      session_id: sessionId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      provider: args.provider,
      model: args.modelId ?? args.inferenceProfileId ?? 'bedrock',
      messages: history,
    });
  }

  if (args.output === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          session_id: sessionId,
          session_created: sessionCreated,
          provider: args.provider,
          model: args.modelId ?? args.inferenceProfileId,
          message_count: history.length,
          response: response.trim(),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`${response.trim()}\n`);
}

async function runInteractive(args: BedrockCliArgs): Promise<void> {
  const service = buildService(args);
  const rl = createInterface({ input, output });
  const wantsSession = !args.noSession;
  const sessionDir = path.resolve(args.sessionDir ?? DEFAULT_SESSION_DIR);
  const sessionId = args.sessionId ?? (wantsSession ? generateSessionId() : undefined);

  if (sessionId) validateSessionId(sessionId);

  const loaded = sessionId && wantsSession ? loadSession(sessionDir, sessionId) : null;
  const history: ChatMessage[] = loaded?.messages ?? [];
  const sessionCreated = Boolean(sessionId && wantsSession && !loaded);

  output.write(
    `Bedrock interactive mode. Commands: /exit, /reset${
      sessionId ? `, session: ${sessionId}` : ''
    }\n`,
  );

  while (true) {
    const userText = (await rl.question('You: ')).trim();
    if (!userText) continue;
    if (userText === '/exit' || userText === 'exit' || userText === 'quit') break;
    if (userText === '/reset' || userText === 'reset') {
      history.length = 0;
      output.write('History cleared.\n');
      if (sessionId && wantsSession) {
        saveSession(sessionDir, {
          session_id: sessionId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          provider: args.provider,
          model: args.modelId ?? args.inferenceProfileId ?? 'bedrock',
          messages: history,
        });
      }
      continue;
    }

    const prompt = buildConversationPrompt(history, userText);
    const response = await service.generate(prompt, { format: 'text' });
    history.push({ role: 'user', content: userText });
    history.push({ role: 'assistant', content: response.trim() });

    if (sessionId && wantsSession) {
      saveSession(sessionDir, {
        session_id: sessionId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        provider: args.provider,
        model: args.modelId ?? args.inferenceProfileId ?? 'bedrock',
        messages: history,
      });
    }

    output.write(`${response.trim()}\n`);
  }

  if (args.output === 'json') {
    output.write(
      `${JSON.stringify(
        {
          session_id: sessionId,
          session_created: sessionCreated,
          provider: args.provider,
          model: args.modelId ?? args.inferenceProfileId,
          message_count: history.length,
        },
        null,
        2,
      )}\n`,
    );
  }

  rl.close();
}

async function main(): Promise<void> {
  loadEnvFile();

  const args = parseArgs(process.argv.slice(2));
  const stdinPrompt = await readStdinPrompt();
  const prompt = args.prompt ?? stdinPrompt;

  if (prompt) {
    await runSingleTurn(args, prompt);
    return;
  }

  await runInteractive(args);
}

main().catch((error) => {
  console.error('Bedrock CLI failed:', error);
  process.exit(1);
});
