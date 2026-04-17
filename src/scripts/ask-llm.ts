#!/usr/bin/env bun

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  type ReviewCloudProvider,
  createCloudReviewLLMService,
} from '../services/review/llm/cloudProvider.js';
import type { ChatMessage } from '../services/review/llm/types.js';
import { buildToolInstruction, runConversationTurn } from './llmConversation.js';
import { createLocalMcpToolClient } from './localMcpClient.js';

type CliMode = 'interactive' | 'single';
type SessionRecord = {
  session_id: string;
  created_at: string;
  updated_at: string;
  provider: ReviewCloudProvider;
  model: string;
  messages: ChatMessage[];
};

type CloudCliArgs = {
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
  apiKey?: string;
  model?: string;
  enableMcp: boolean;
};

const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const DEFAULT_SESSION_DIR = path.resolve(os.homedir(), '.localLlm', 'sessions');
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadEnvFile(filePath = path.join(ROOT_DIR, '.env')): void {
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

function collectPositionals(argv: string[]): string[] {
  const positionals: string[] = [];
  const valueFlags = new Set([
    '--provider',
    '--prompt',
    '--input',
    '--output',
    '--session-id',
    '--session-dir',
    '--model-id',
    '--inference-profile-id',
    '--region',
    '--api-base-url',
    '--api-version',
    '--api-key',
    '--model',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      if (valueFlags.has(arg)) {
        index += 1;
      }
      continue;
    }
    if (arg.includes('=')) continue;
    positionals.push(arg);
  }

  return positionals;
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
    provider:
      parsed.provider === 'openai' ||
      parsed.provider === 'azure-openai' ||
      parsed.provider === 'bedrock' ||
      parsed.provider === 'anthropic' ||
      parsed.provider === 'google'
        ? parsed.provider
        : 'bedrock',
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

function baseSystemPrompt(): string {
  return 'あなたは有能なアシスタントです。返答は自然で簡潔にしてください。';
}

function ensureSystemPrompt(
  history: ChatMessage[],
  includeTools: boolean,
  isNativeTools: boolean,
): void {
  let systemContent = baseSystemPrompt();
  if (includeTools && isNativeTools) {
    systemContent += `\n\nあなたにはウェブ検索とURL取得の2つのツールがあります。
- search_web: ウェブ検索。リアルタイム情報（天気・ニュース・最新の出来事など）が必要な場合に使う。
- fetch_content: 指定URLのページ内容を取得。検索結果のスニペットだけでは情報が不足する場合、URLを指定して詳細を取得する。

重要: 検索結果のスニペットに具体的な数値や詳細が含まれていない場合は、必ず fetch_content で該当URLの中身を取得してから回答してください。推測や「確認できませんでした」という回答は避けてください。`;
  } else if (includeTools) {
    systemContent += `\n\n${buildToolInstruction()}`;
  }

  if (history[0]?.role === 'system') {
    history[0] = { role: 'system', content: systemContent };
    return;
  }

  history.unshift({ role: 'system', content: systemContent });
}

export function parseArgs(argv: string[]): CloudCliArgs {
  const providerArg = (getArg(argv, '--provider') ?? 'bedrock') as ReviewCloudProvider;
  const promptArg = getArg(argv, '--prompt') ?? getArg(argv, '--input');
  const output = getArg(argv, '--output') === 'json' ? 'json' : 'text';
  const mode = argv.includes('--interactive') ? 'interactive' : 'single';
  const enableMcp = !argv.includes('--no-mcp') || argv.includes('--mcp');

  const positionals = collectPositionals(argv);
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
    apiKey: getArg(argv, '--api-key'),
    model: getArg(argv, '--model'),
    enableMcp,
  };
}

function resolveEffectiveProvider(args: CloudCliArgs): ReviewCloudProvider {
  if (
    args.provider === 'openai' &&
    !args.apiKey &&
    !process.env.OPENAI_API_KEY &&
    process.env.AZURE_OPENAI_API_KEY
  ) {
    return 'azure-openai';
  }
  return args.provider;
}

function buildService(args: CloudCliArgs) {
  if (args.provider === 'bedrock') {
    return createCloudReviewLLMService({
      provider: 'bedrock',
      bedrockModelId: args.modelId,
      bedrockInferenceProfileId: args.inferenceProfileId,
      awsRegion: args.region,
      apiBaseUrl: args.apiBaseUrl,
    });
  }

  const effectiveProvider = resolveEffectiveProvider(args);

  const apiKey =
    args.apiKey ??
    (effectiveProvider === 'azure-openai'
      ? process.env.AZURE_OPENAI_API_KEY ?? process.env.GNOSIS_REVIEW_LLM_API_KEY
      : process.env.OPENAI_API_KEY ?? process.env.GNOSIS_REVIEW_LLM_API_KEY);

  const model =
    args.model ??
    (effectiveProvider === 'azure-openai'
      ? process.env.AZURE_OPENAI_MODEL ?? process.env.GNOSIS_REVIEW_LLM_MODEL
      : process.env.OPENAI_MODEL ?? process.env.GNOSIS_REVIEW_LLM_MODEL ?? 'gpt-5-mini');

  return createCloudReviewLLMService({
    provider: effectiveProvider,
    apiKey,
    model,
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

function resolveModelLabel(args: CloudCliArgs): string {
  const effectiveProvider = resolveEffectiveProvider(args);
  if (effectiveProvider === 'azure-openai') {
    const model =
      args.model ?? process.env.AZURE_OPENAI_MODEL ?? process.env.GNOSIS_REVIEW_LLM_MODEL ?? '';
    return `Azure OpenAI${model ? ` (${model})` : ''}`;
  }
  if (effectiveProvider === 'openai') {
    const model =
      args.model ?? process.env.OPENAI_MODEL ?? process.env.GNOSIS_REVIEW_LLM_MODEL ?? 'gpt-5-mini';
    return `OpenAI (${model})`;
  }
  if (effectiveProvider === 'bedrock') {
    const model =
      args.inferenceProfileId ??
      args.modelId ??
      process.env.GNOSIS_REVIEW_LLM_BEDROCK_INFERENCE_PROFILE_ID ??
      process.env.GNOSIS_REVIEW_LLM_BEDROCK_MODEL_ID ??
      '';
    return `Bedrock${model ? ` (${model})` : ''}`;
  }
  return effectiveProvider;
}

function printStartBanner(label: string, sessionId: string | undefined): void {
  output.write('\n=== Chat session started ===\n');
  output.write(`  Model   : ${label}\n`);
  if (sessionId) output.write(`  Session : ${sessionId}\n`);
  output.write('  Commands: exit · reset · Ctrl+C to quit\n\n');
}

async function runSingleTurn(args: CloudCliArgs, prompt: string): Promise<void> {
  const service = buildService(args);
  const wantsSession = !args.noSession;
  const sessionDir = path.resolve(args.sessionDir ?? DEFAULT_SESSION_DIR);
  const sessionId = args.sessionId ?? (wantsSession ? generateSessionId() : undefined);
  const toolClient = args.enableMcp ? createLocalMcpToolClient() : undefined;

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

  const hasNativeTools = Boolean(toolClient && service.generateMessagesStructured);
  ensureSystemPrompt(history, Boolean(toolClient), hasNativeTools);
  const response = await runConversationTurn(history, prompt, service, {
    maxTokens: 4096,
    temperature: 0,
    allowTools: Boolean(toolClient),
    toolClient,
    forceJson: args.output === 'json',
  });

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

  if (toolClient) {
    await toolClient.disconnect().catch(() => undefined);
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

async function runInteractive(args: CloudCliArgs): Promise<void> {
  const service = buildService(args);
  const rl = createInterface({ input, output });
  const wantsSession = !args.noSession;
  const sessionDir = path.resolve(args.sessionDir ?? DEFAULT_SESSION_DIR);
  const sessionId = args.sessionId ?? (wantsSession ? generateSessionId() : undefined);
  const toolClient = args.enableMcp ? createLocalMcpToolClient() : undefined;

  if (sessionId) validateSessionId(sessionId);

  const loaded = sessionId && wantsSession ? loadSession(sessionDir, sessionId) : null;
  const history: ChatMessage[] = loaded?.messages ?? [];
  const sessionCreated = Boolean(sessionId && wantsSession && !loaded);

  const hasNativeTools = Boolean(toolClient && service.generateMessagesStructured);
  ensureSystemPrompt(history, Boolean(toolClient), hasNativeTools);

  const label = resolveModelLabel(args);
  printStartBanner(label, sessionId);

  process.on('SIGINT', () => {
    output.write('\nBye.\n');
    process.exit(0);
  });

  while (true) {
    const userText = (await rl.question('You: ')).trim();
    if (!userText) continue;
    if (userText === '/exit' || userText === 'exit' || userText === 'quit') break;
    if (userText === '/reset' || userText === 'reset') {
      history.length = 0;
      ensureSystemPrompt(history, Boolean(toolClient), hasNativeTools);
      output.write('Chat history reset.\n');
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

    try {
      const response = await runConversationTurn(history, userText, service, {
        maxTokens: 4096,
        temperature: 0,
        allowTools: Boolean(toolClient),
        toolClient,
        forceJson: false,
      });
      output.write(`${response.trim()}\n`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      output.write(`[Error] ${msg}\n`);
    }

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
  }

  if (toolClient) {
    await toolClient.disconnect().catch(() => undefined);
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

if (import.meta.main) {
  main().catch((error) => {
    console.error('Cloud CLI failed:', error);
    process.exit(1);
  });
}
