#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLORS, loadLocalEnv } from './lib/quality.ts';

type CommandSpec = {
  command: string;
  args: string[];
};

type CommandOutput = {
  code: number;
  stdout: string;
  stderr: string;
};

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_TEMPLATE = path.join(ROOT_DIR, '.env.minimal');
const ROOT_ENV_PATH = path.join(ROOT_DIR, '.env');
const BUN = process.env.GNOSIS_BUN_COMMAND || process.argv[0] || 'bun';
const IS_WINDOWS = process.platform === 'win32';
const LOCAL_LLM_ROOT_DEFAULT = path.resolve(ROOT_DIR, '../local-llm');

function printHeader(title: string): void {
  process.stdout.write(`\n${COLORS.cyan}=== ${title} ===${COLORS.reset}\n`);
}

function printStep(title: string): void {
  process.stdout.write(`${COLORS.cyan}>>> ${title}${COLORS.reset}\n`);
}

function printSuccess(message: string): void {
  process.stdout.write(`${COLORS.green}✔ ${message}${COLORS.reset}\n`);
}

function printWarning(message: string): void {
  process.stdout.write(`${COLORS.yellow}⚠ ${message}${COLORS.reset}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${COLORS.red}${message}${COLORS.reset}\n`);
  process.exit(1);
}

function formatCommand(spec: CommandSpec): string {
  return [spec.command, ...spec.args].join(' ');
}

function runCommand(spec: CommandSpec, env = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env,
      shell: false,
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to start: ${formatCommand(spec)}\n${String(error)}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${code}): ${formatCommand(spec)}`));
    });
  });
}

function canRun(spec: CommandSpec): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: ROOT_DIR,
      stdio: 'ignore',
      env: process.env,
      shell: false,
    });

    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function runCommandCapture(spec: CommandSpec): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
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
      reject(new Error(`Failed to start: ${formatCommand(spec)}\n${String(error)}`));
    });

    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function resolveDockerComposeSpec(): Promise<CommandSpec> {
  const candidates: Array<{ check: CommandSpec; run: CommandSpec }> = [
    {
      check: { command: 'docker', args: ['compose', 'version'] },
      run: { command: 'docker', args: ['compose'] },
    },
    {
      check: { command: 'docker-compose', args: ['version'] },
      run: { command: 'docker-compose', args: [] },
    },
  ];

  for (const candidate of candidates) {
    if (await canRun(candidate.check)) {
      return candidate.run;
    }
  }

  throw new Error('Docker Compose was not found. Install Docker Desktop or docker-compose.');
}

function ensureCopiedTemplate(source: string, destination: string, label: string): void {
  if (!existsSync(source)) {
    throw new Error(`Required template is missing: ${path.relative(ROOT_DIR, source)}`);
  }

  if (existsSync(destination)) {
    printWarning(`${label} already exists. Keeping the current file.`);
    return;
  }

  copyFileSync(source, destination);
  printSuccess(
    `Created ${path.relative(ROOT_DIR, destination)} from ${path.relative(ROOT_DIR, source)}.`,
  );
}

function upsertEnvValue(
  filePath: string,
  key: string,
  value: string,
  options: { preserveExisting?: boolean } = {},
): void {
  const line = `${key}=${value}`;
  const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const lines = current.length > 0 ? current.split('\n') : [];
  let replaced = false;

  const next = lines.map((existingLine) => {
    if (!existingLine.startsWith(`${key}=`)) {
      return existingLine;
    }
    if (options.preserveExisting) {
      replaced = true;
      return existingLine;
    }
    replaced = true;
    return line;
  });

  if (!replaced) {
    if (next.length > 0 && next[next.length - 1] !== '') {
      next.push('');
    }
    next.push(line);
  }

  writeFileSync(filePath, `${next.join('\n').replace(/\n*$/, '\n')}`, 'utf8');
}

function resolveCommand(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (path.isAbsolute(trimmed)) return trimmed;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('.')) {
    return path.resolve(ROOT_DIR, trimmed);
  }
  return trimmed;
}

async function commandAvailable(command: string): Promise<boolean> {
  if (!command.trim()) return false;
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return existsSync(command);
  }

  if (IS_WINDOWS) {
    const result = await runCommandCapture({ command: 'where', args: [command] }).catch(() => null);
    return Boolean(result && result.code === 0);
  }

  const escaped = command.replace(/'/g, `'"'"'`);
  const result = await runCommandCapture({
    command: 'bash',
    args: ['-lc', `command -v '${escaped}'`],
  }).catch(() => null);
  return Boolean(result && result.code === 0);
}

async function runStep(name: string, retryCommand: string, fn: () => Promise<void>): Promise<void> {
  printStep(name);
  try {
    await fn();
    printSuccess(name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Bootstrap failed at step: ${name}\n${message}\nRetry: ${retryCommand}`);
  }
}

async function run(): Promise<void> {
  printHeader('Gnosis Minimal Bootstrap');
  process.stdout.write('Target profile: minimal (DB + external embedding runtime)\n');
  if (IS_WINDOWS) {
    printWarning(
      'Windows support is not guaranteed yet. This bootstrap keeps paths and commands Windows-aware where possible.',
    );
  }

  printStep('Resolving prerequisites');
  const dockerCompose = await resolveDockerComposeSpec();
  printSuccess(`Bun command: ${BUN}`);
  printSuccess(`Docker Compose command: ${formatCommand(dockerCompose)}`.trim());

  await runStep('Installing Bun dependencies', 'bun install', async () => {
    await runCommand({ command: BUN, args: ['install'] });
  });

  await runStep('Preparing environment file', 'cp .env.minimal .env', async () => {
    ensureCopiedTemplate(ENV_TEMPLATE, ROOT_ENV_PATH, '.env');
    upsertEnvValue(ROOT_ENV_PATH, 'GNOSIS_EMBED_COMMAND', 'embed', { preserveExisting: true });
    loadLocalEnv(ROOT_ENV_PATH);
  });

  await runStep(
    'Validating external embedding command',
    'bun run bootstrap:local-llm',
    async () => {
      const embedCommandRaw = process.env.GNOSIS_EMBED_COMMAND?.trim() || 'embed';
      const embedCommand = resolveCommand(embedCommandRaw);
      if (await commandAvailable(embedCommand)) {
        printSuccess(`GNOSIS_EMBED_COMMAND is available: ${embedCommand}`);
        return;
      }

      const localLlmRoot = process.env.GNOSIS_LOCAL_LLM_PATH?.trim()
        ? resolveCommand(process.env.GNOSIS_LOCAL_LLM_PATH.trim())
        : LOCAL_LLM_ROOT_DEFAULT;
      const localEmbedPath = path.join(
        localLlmRoot,
        'embedding/.venv',
        IS_WINDOWS ? 'Scripts' : 'bin',
        IS_WINDOWS ? 'embed.exe' : 'embed',
      );
      const localLlmSetup = path.join(localLlmRoot, 'scripts/setup.sh');

      if (existsSync(localEmbedPath)) {
        upsertEnvValue(ROOT_ENV_PATH, 'GNOSIS_EMBED_COMMAND', localEmbedPath);
        process.env.GNOSIS_EMBED_COMMAND = localEmbedPath;
        loadLocalEnv(ROOT_ENV_PATH);
        printWarning(`GNOSIS_EMBED_COMMAND was updated to ${localEmbedPath}`);
        if (await commandAvailable(localEmbedPath)) {
          printSuccess(`GNOSIS_EMBED_COMMAND is available: ${localEmbedPath}`);
          return;
        }
      }

      if (existsSync(localLlmSetup)) {
        throw new Error(
          `Embedding command not found: ${embedCommand}\nInstall external runtime first: cd ${localLlmRoot} && ./scripts/setup.sh`,
        );
      }

      throw new Error(
        `Embedding command not found: ${embedCommand}\nInstall external local-llm runtime and set GNOSIS_EMBED_COMMAND to a valid command/path.`,
      );
    },
  );

  await runStep('Starting PostgreSQL with pgvector', 'docker compose up -d gnosis', async () => {
    await runCommand({
      command: dockerCompose.command,
      args: [...dockerCompose.args, 'up', '-d', 'gnosis'],
    });
  });

  await runStep('Initializing database', 'bun run db:init', async () => {
    await runCommand({ command: BUN, args: ['run', 'db:init'] }, process.env);
  });

  printHeader('Bootstrap Complete');
  process.stdout.write('Next commands:\n');
  process.stdout.write('  1. bun run doctor\n');
  process.stdout.write('  2. bun run onboarding:smoke\n');
  process.stdout.write('  3. bun run start\n');
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(`Bootstrap failed.\n${message}`);
});
