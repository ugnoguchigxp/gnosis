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

function parsePythonVersion(raw: string): { major: number; minor: number } | null {
  const match = raw.match(/Python\s+(\d+)\.(\d+)/i);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function isSupportedPythonVersion(version: { major: number; minor: number } | null): boolean {
  if (!version) return false;
  return version.major > 3 || (version.major === 3 && version.minor >= 10);
}

async function resolvePythonSpec(): Promise<CommandSpec> {
  const candidates: CommandSpec[] = [];
  if (process.env.GNOSIS_PYTHON_COMMAND?.trim()) {
    candidates.push({ command: process.env.GNOSIS_PYTHON_COMMAND.trim(), args: ['--version'] });
  }
  candidates.push(
    { command: 'python3', args: ['--version'] },
    { command: 'python', args: ['--version'] },
    { command: 'py', args: ['-3', '--version'] },
  );

  for (const candidate of candidates) {
    const result = await runCommandCapture(candidate).catch(() => null);
    if (!result || result.code !== 0) continue;

    const version = parsePythonVersion(`${result.stdout}\n${result.stderr}`);
    if (!isSupportedPythonVersion(version)) continue;

    if (candidate.command === 'py') {
      return { command: 'py', args: ['-3'] };
    }
    return { command: candidate.command, args: [] };
  }

  throw new Error('Python 3.10+ was not found. Install python3 and retry.');
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

function upsertEnvValue(filePath: string, key: string, value: string): void {
  const line = `${key}=${value}`;
  const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const lines = current.length > 0 ? current.split('\n') : [];
  let replaced = false;

  const next = lines.map((existingLine) => {
    if (!existingLine.startsWith(`${key}=`)) {
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

function getExecutablePath(serviceDir: string, name: string): string {
  const executable = IS_WINDOWS ? `${name}.exe` : name;
  return path.join(serviceDir, '.venv', IS_WINDOWS ? 'Scripts' : 'bin', executable);
}

function toEnvPath(filePath: string): string {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join('/');
}

async function installEmbeddingService(pythonBase: CommandSpec): Promise<void> {
  const serviceDir = path.join(ROOT_DIR, 'services/embedding');
  const venvDir = path.join(serviceDir, '.venv');
  const requirementsLock = path.join(serviceDir, 'requirements.lock');
  const requirementsTxt = path.join(serviceDir, 'requirements.txt');
  const requirementsFile = existsSync(requirementsLock) ? requirementsLock : requirementsTxt;

  if (!existsSync(venvDir)) {
    await runCommand({
      command: pythonBase.command,
      args: [...pythonBase.args, '-m', 'venv', venvDir],
    });
  }

  const pip = getExecutablePath(serviceDir, 'pip');
  if (!existsSync(pip)) {
    throw new Error('pip was not created for services/embedding.');
  }

  await runCommand({ command: pip, args: ['install', '--upgrade', 'pip'] });
  await runCommand({ command: pip, args: ['install', '-r', requirementsFile] });
  await runCommand({ command: pip, args: ['install', '-e', serviceDir] });
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
  process.stdout.write('Target profile: minimal (DB + embedding)\n');
  if (IS_WINDOWS) {
    printWarning(
      'Windows support is not guaranteed yet. This bootstrap keeps paths and commands Windows-aware where possible.',
    );
  }

  printStep('Resolving prerequisites');
  const python = await resolvePythonSpec();
  const dockerCompose = await resolveDockerComposeSpec();
  printSuccess(
    `Python command: ${formatCommand({ command: python.command, args: python.args })}`.trim(),
  );
  printSuccess(`Docker Compose command: ${formatCommand(dockerCompose)}`.trim());

  await runStep('Installing Bun dependencies', 'bun install', async () => {
    await runCommand({ command: BUN, args: ['install'] });
  });

  await runStep('Preparing environment file', 'cp .env.minimal .env', async () => {
    ensureCopiedTemplate(ENV_TEMPLATE, ROOT_ENV_PATH, '.env');
    upsertEnvValue(
      ROOT_ENV_PATH,
      'GNOSIS_EMBED_COMMAND',
      toEnvPath(getExecutablePath(path.join(ROOT_DIR, 'services/embedding'), 'embed')),
    );
    loadLocalEnv(ROOT_ENV_PATH);
  });

  await runStep('Setting up embedding service', 'bun run bootstrap', async () => {
    await installEmbeddingService(python);
  });

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
