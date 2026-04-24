#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pkg from 'pg';
import { COLORS, loadLocalEnv } from './lib/quality.ts';

const { Pool } = pkg;

type Status = 'OK' | 'WARN' | 'FAIL';

type CheckResult = {
  name: string;
  status: Status;
  message: string;
  fix?: string;
};

type CommandSpec = {
  command: string;
  args: string[];
};

type CommandOutput = {
  code: number;
  stdout: string;
  stderr: string;
};

const ROOT_DIR = process.cwd();
const BUN = process.env.GNOSIS_BUN_COMMAND || process.argv[0] || 'bun';
const IS_WINDOWS = process.platform === 'win32';

async function runCapture(spec: CommandSpec): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
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

    child.on('error', (error) => reject(error));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function resolveDockerComposeSpec(): Promise<CommandSpec | null> {
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
    const result = await runCapture(candidate.check).catch(() => null);
    if (result && result.code === 0) {
      return candidate.run;
    }
  }

  return null;
}

function parsePythonVersion(raw: string): { major: number; minor: number } | null {
  const match = raw.match(/Python\s+(\d+)\.(\d+)/i);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function isSupportedPython(version: { major: number; minor: number } | null): boolean {
  if (!version) return false;
  return version.major > 3 || (version.major === 3 && version.minor >= 10);
}

function resolveEmbedPath(): string {
  const configured = process.env.GNOSIS_EMBED_COMMAND?.trim();
  if (configured && configured.length > 0) {
    return path.isAbsolute(configured) ? configured : path.resolve(ROOT_DIR, configured);
  }
  return path.resolve(
    ROOT_DIR,
    'services/embedding/.venv',
    IS_WINDOWS ? 'Scripts' : 'bin',
    IS_WINDOWS ? 'embed.exe' : 'embed',
  );
}

async function checkLocalLlmHealth(): Promise<CheckResult> {
  const base = process.env.LOCAL_LLM_API_BASE_URL?.trim();
  if (!base) {
    return {
      name: 'local-llm health',
      status: 'WARN',
      message: 'LOCAL_LLM_API_BASE_URL is not set.',
      fix: 'Set LOCAL_LLM_API_BASE_URL or run without local-llm features.',
    };
  }

  const healthUrl = `${base.replace(/\/+$/, '')}/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    if (response.ok) {
      return { name: 'local-llm health', status: 'OK', message: `${healthUrl} responded ${response.status}` };
    }
    return {
      name: 'local-llm health',
      status: 'WARN',
      message: `${healthUrl} responded ${response.status}.`,
      fix: 'Run services/local-llm/scripts/run_openai_api.sh and retry.',
    };
  } catch {
    return {
      name: 'local-llm health',
      status: 'WARN',
      message: `Could not reach ${healthUrl}.`,
      fix: 'Run services/local-llm/scripts/run_openai_api.sh and retry.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function printResult(result: CheckResult): void {
  const color =
    result.status === 'OK' ? COLORS.green : result.status === 'WARN' ? COLORS.yellow : COLORS.red;
  process.stdout.write(`${color}[${result.status}]${COLORS.reset} ${result.name}: ${result.message}\n`);
  if (result.fix) {
    process.stdout.write(`      fix: ${result.fix}\n`);
  }
}

async function main(): Promise<void> {
  loadLocalEnv(path.join(ROOT_DIR, '.env'));
  process.stdout.write(`${COLORS.cyan}=== Gnosis Doctor ===${COLORS.reset}\n`);

  const results: CheckResult[] = [];

  const bunCheck = await runCapture({ command: BUN, args: ['--version'] }).catch(() => null);
  if (bunCheck && bunCheck.code === 0) {
    results.push({
      name: 'bun',
      status: 'OK',
      message: bunCheck.stdout.trim() || bunCheck.stderr.trim() || 'available',
    });
  } else {
    results.push({
      name: 'bun',
      status: 'FAIL',
      message: 'Bun command is not available.',
      fix: 'Install Bun and ensure it is on PATH.',
    });
  }

  const pythonCandidates: CommandSpec[] = [
    { command: 'python3', args: ['--version'] },
    { command: 'python', args: ['--version'] },
    { command: 'py', args: ['-3', '--version'] },
  ];
  let pythonMessage = '';
  let pythonOk = false;
  for (const candidate of pythonCandidates) {
    const result = await runCapture(candidate).catch(() => null);
    if (!result || result.code !== 0) continue;
    const version = parsePythonVersion(`${result.stdout}\n${result.stderr}`);
    if (!isSupportedPython(version)) continue;
    pythonMessage = `${candidate.command} ${version?.major}.${version?.minor}`;
    pythonOk = true;
    break;
  }
  results.push(
    pythonOk
      ? { name: 'python', status: 'OK', message: pythonMessage }
      : {
          name: 'python',
          status: 'FAIL',
          message: 'Python 3.10+ is not available.',
          fix: 'Install Python 3.10+ and retry.',
        },
  );

  const dockerCompose = await resolveDockerComposeSpec();
  if (!dockerCompose) {
    results.push({
      name: 'docker compose',
      status: 'FAIL',
      message: 'docker compose command was not found.',
      fix: 'Install Docker Desktop (or docker-compose) and retry.',
    });
  } else {
    results.push({
      name: 'docker compose',
      status: 'OK',
      message: `${dockerCompose.command}${dockerCompose.args.length ? ` ${dockerCompose.args.join(' ')}` : ''}`,
    });

    const ps = await runCapture({
      command: dockerCompose.command,
      args: [...dockerCompose.args, 'ps', '-q', 'db'],
    }).catch(() => null);

    const containerId = ps?.stdout?.trim() ?? '';
    if (!ps || ps.code !== 0 || containerId.length === 0) {
      results.push({
        name: 'postgres container',
        status: 'FAIL',
        message: 'db container is not running.',
        fix: 'Run: docker compose up -d db',
      });
    } else {
      const inspect = await runCapture({
        command: 'docker',
        args: ['inspect', '-f', '{{.State.Running}}', containerId],
      }).catch(() => null);
      if (inspect && inspect.code === 0 && inspect.stdout.trim() === 'true') {
        results.push({ name: 'postgres container', status: 'OK', message: `running (${containerId.slice(0, 12)})` });
      } else {
        results.push({
          name: 'postgres container',
          status: 'FAIL',
          message: 'db container is not in running state.',
          fix: 'Run: docker compose up -d db',
        });
      }
    }
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    results.push({
      name: 'DATABASE_URL',
      status: 'FAIL',
      message: 'DATABASE_URL is not set.',
      fix: 'Create .env from .env.minimal and retry.',
    });
  } else {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query('select 1');
      results.push({ name: 'DATABASE_URL connection', status: 'OK', message: 'connected' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        name: 'DATABASE_URL connection',
        status: 'FAIL',
        message,
        fix: 'Run: bun run db:init',
      });
    } finally {
      await pool.end().catch(() => {});
    }
  }

  const embedPath = resolveEmbedPath();
  if (existsSync(embedPath)) {
    results.push({ name: 'GNOSIS_EMBED_COMMAND', status: 'OK', message: embedPath });
  } else {
    results.push({
      name: 'GNOSIS_EMBED_COMMAND',
      status: 'FAIL',
      message: `${embedPath} was not found.`,
      fix: 'Run: bun run bootstrap',
    });
  }

  results.push(await checkLocalLlmHealth());

  process.stdout.write('\n');
  for (const result of results) {
    printResult(result);
  }

  const failCount = results.filter((result) => result.status === 'FAIL').length;
  const warnCount = results.filter((result) => result.status === 'WARN').length;
  process.stdout.write('\n');
  process.stdout.write(`Summary: fail=${failCount} warn=${warnCount}\n`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
