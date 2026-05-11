#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GNOSIS_CONSTANTS } from '../src/constants.js';
import { COLORS, loadLocalEnv } from './lib/quality.ts';

type CheckResult = {
  name: string;
  ok: boolean;
  message: string;
};

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function toAbsoluteFromRoot(value: string): string {
  if (path.isAbsolute(value)) return value;
  return path.resolve(ROOT_DIR, value);
}

function normalizeCommand(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (path.isAbsolute(trimmed)) return trimmed;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('.')) {
    return path.resolve(ROOT_DIR, trimmed);
  }
  return trimmed;
}

async function runCapture(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer | string) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer | string) => {
      stderr += data.toString();
    });
    child.on('error', (error) => {
      stderr += String(error);
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function commandAvailable(command: string): Promise<boolean> {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return existsSync(command);
  }
  if (process.platform === 'win32') {
    const result = await runCapture('where', [command]);
    return result.code === 0;
  }
  const result = await runCapture('bash', [
    '-lc',
    `command -v '${command.replace(/'/g, `'"'"'`)}'`,
  ]);
  return result.code === 0;
}

async function httpHealthy(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function print(result: CheckResult): void {
  const color = result.ok ? COLORS.green : COLORS.yellow;
  const symbol = result.ok ? '✔' : '⚠';
  process.stdout.write(`${color}${symbol} ${result.name}${COLORS.reset}: ${result.message}\n`);
}

async function main(): Promise<void> {
  loadLocalEnv(path.join(ROOT_DIR, '.env'));

  const localLlmRootCandidate =
    process.env.GNOSIS_LOCAL_LLM_PATH?.trim() || GNOSIS_CONSTANTS.LOCAL_LLM_PATH_DEFAULT;
  const localLlmRoot = toAbsoluteFromRoot(localLlmRootCandidate);
  const localLlmScript = normalizeCommand(
    process.env.GNOSIS_LLM_SCRIPT || GNOSIS_CONSTANTS.LLM_SCRIPT_DEFAULT,
  );
  const embedCommand = normalizeCommand(
    process.env.GNOSIS_EMBED_COMMAND || GNOSIS_CONSTANTS.EMBED_COMMAND_DEFAULT,
  );

  const llmBaseUrl = (process.env.LOCAL_LLM_API_BASE_URL || 'http://127.0.0.1:44448').replace(
    /\/+$/,
    '',
  );
  const embedBaseUrl = (process.env.GNOSIS_EMBED_DAEMON_URL || 'http://127.0.0.1:44512').replace(
    /\/+$/,
    '',
  );

  process.stdout.write(
    `${COLORS.cyan}=== Gnosis External local-llm Bootstrap ===${COLORS.reset}\n`,
  );
  process.stdout.write('This script no longer installs runtime dependencies in this repository.\n');
  process.stdout.write('It validates external local-llm runtime wiring only.\n\n');

  const checks: CheckResult[] = [];

  checks.push({
    name: 'local-llm root',
    ok: existsSync(localLlmRoot),
    message: existsSync(localLlmRoot)
      ? localLlmRoot
      : `${localLlmRoot} not found (set GNOSIS_LOCAL_LLM_PATH if needed)`,
  });

  const runOpenAiScript = path.join(localLlmRoot, 'scripts/run_openai_api.sh');
  const runEmbedScript = path.join(localLlmRoot, 'scripts/run_embedding_daemon.sh');
  checks.push({
    name: 'local-llm start script',
    ok: existsSync(runOpenAiScript),
    message: existsSync(runOpenAiScript)
      ? runOpenAiScript
      : 'missing scripts/run_openai_api.sh in external local-llm runtime',
  });
  checks.push({
    name: 'embedding start script',
    ok: existsSync(runEmbedScript),
    message: existsSync(runEmbedScript)
      ? runEmbedScript
      : 'missing scripts/run_embedding_daemon.sh in external local-llm runtime',
  });

  checks.push({
    name: 'GNOSIS_LLM_SCRIPT',
    ok: await commandAvailable(localLlmScript),
    message: localLlmScript,
  });
  checks.push({
    name: 'GNOSIS_EMBED_COMMAND',
    ok: await commandAvailable(embedCommand),
    message: embedCommand,
  });
  checks.push({
    name: 'local-llm API health',
    ok: await httpHealthy(`${llmBaseUrl}/health`),
    message: `${llmBaseUrl}/health`,
  });
  checks.push({
    name: 'embedding API health',
    ok: await httpHealthy(`${embedBaseUrl}/health`),
    message: `${embedBaseUrl}/health`,
  });

  for (const result of checks) {
    print(result);
  }

  const failed = checks.filter((check) => !check.ok);
  process.stdout.write('\n');
  if (failed.length === 0) {
    process.stdout.write(`${COLORS.green}Bootstrap checks passed.${COLORS.reset}\n`);
    process.stdout.write('Next steps:\n');
    process.stdout.write('  1. bun run doctor\n');
    process.stdout.write('  2. GNOSIS_DOCTOR_REQUIRE_LOCAL_LLM=true bun run doctor\n');
    return;
  }

  process.stdout.write(`${COLORS.yellow}Bootstrap checks found issues.${COLORS.reset}\n`);
  process.stdout.write('Fix the missing external runtime pieces and run this command again.\n');
  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${COLORS.red}bootstrap-local-llm failed: ${message}${COLORS.reset}\n`);
  process.exit(1);
});
