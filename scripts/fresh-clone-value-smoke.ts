#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordQualityGate } from './lib/quality-gates.js';
import { COLORS, runCommand } from './lib/quality.js';

type StepResult = {
  name: string;
  command: string;
  durationMs: number;
  code: number;
  stdout?: string;
  stderr?: string;
};

type SmokeArtifact = {
  generatedAt: string;
  sourceRepo: string;
  cloneDir: string;
  totalDurationMs: number;
  maxDurationMs: number;
  passed: boolean;
  failureReason: string | null;
  skippedOptionalSteps: string[];
  stepDurations: Record<string, number>;
  steps: StepResult[];
  environment: {
    platform: string;
    bun: string;
    nodeEnv: string | null;
    scrubbedEnvKeys: string[];
  };
};

export type GitNameStatusRecord = {
  status: string;
  path: string;
  oldPath?: string;
};

const ROOT_DIR = process.cwd();
const BUN = process.env.GNOSIS_BUN_COMMAND || process.argv[0] || 'bun';
const ARTIFACT_PATH = path.join(ROOT_DIR, 'logs', 'fresh-clone-value-smoke.json');
const MAX_VALUE_ARRIVAL_MS = 300_000;
const SCRUBBED_ENV_KEYS = [
  'DATABASE_URL',
  'GNOSIS_EMBED_COMMAND',
  'GNOSIS_LLM_SCRIPT',
  'GNOSIS_GEMMA4_SCRIPT',
  'GNOSIS_BONSAI_SCRIPT',
  'GNOSIS_OPENAI_SCRIPT',
  'GNOSIS_BEDROCK_SCRIPT',
  'GNOSIS_AGENTIC_SEARCH_LOG_FILE',
  'GNOSIS_LLM_USAGE_LOG_FILE',
];

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

async function runStep(
  name: string,
  command: string,
  args: string[],
  cwd: string,
): Promise<StepResult> {
  process.stdout.write(`${COLORS.cyan}>>> [fresh-clone:value] ${name}${COLORS.reset}\n`);
  const startedAt = Date.now();
  const result = await runCommand(command, args, {
    capture: true,
    passthrough: true,
    env: freshCloneEnv(),
    cwd,
  });
  const durationMs = Date.now() - startedAt;
  return {
    name,
    command: [command, ...args].join(' '),
    durationMs,
    code: result.code,
    stdout: result.stdout.slice(-4000),
    stderr: result.stderr.slice(-4000),
  };
}

function freshCloneEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GNOSIS_NO_WORKERS: 'true',
  };
  for (const key of SCRUBBED_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

async function writeArtifact(artifact: SmokeArtifact): Promise<void> {
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
}

function splitNullList(raw: string): string[] {
  return raw.split('\0').filter((item) => item.length > 0);
}

export function parseGitNameStatusZ(raw: string): GitNameStatusRecord[] {
  const tokens = splitNullList(raw);
  const records: GitNameStatusRecord[] = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++] ?? '';
    if (!status) continue;

    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (!oldPath || !newPath) {
        throw new Error(`Malformed git name-status record for status ${status}`);
      }
      records.push({ status, oldPath, path: newPath });
      continue;
    }

    const relativePath = tokens[index++];
    if (!relativePath) {
      throw new Error(`Malformed git name-status record for status ${status}`);
    }
    records.push({ status, path: relativePath });
  }
  return records;
}

async function copyWorktreeFile(relativePath: string, cloneDir: string): Promise<void> {
  const sourcePath = path.join(ROOT_DIR, relativePath);
  const targetPath = path.join(cloneDir, relativePath);
  if (!existsSync(sourcePath)) return;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}

async function overlayCurrentWorktree(cloneDir: string): Promise<StepResult> {
  const startedAt = Date.now();
  const changed = await runCommand(
    'git',
    ['diff', '--name-status', '--find-renames', '-z', 'HEAD'],
    {
      capture: true,
      passthrough: false,
      cwd: ROOT_DIR,
    },
  );
  const untracked = await runCommand('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    capture: true,
    passthrough: false,
    cwd: ROOT_DIR,
  });
  if (changed.code !== 0 || untracked.code !== 0) {
    return {
      name: 'worktree overlay',
      command:
        'git diff --name-status --find-renames -z HEAD && git ls-files --others --exclude-standard -z',
      durationMs: Date.now() - startedAt,
      code: changed.code !== 0 ? changed.code : untracked.code,
      stdout: `${changed.stdout}${untracked.stdout}`.slice(-4000),
      stderr: `${changed.stderr}${untracked.stderr}`.slice(-4000),
    };
  }

  let changedRecords: GitNameStatusRecord[] = [];
  try {
    changedRecords = parseGitNameStatusZ(changed.stdout);
  } catch (error) {
    return {
      name: 'worktree overlay',
      command: 'parse git diff --name-status -z output',
      durationMs: Date.now() - startedAt,
      code: 1,
      stdout: changed.stdout.slice(-4000),
      stderr: error instanceof Error ? error.message : String(error),
    };
  }

  for (const record of changedRecords) {
    if (record.oldPath && record.status.startsWith('R')) {
      const oldTargetPath = path.join(cloneDir, record.oldPath);
      await rm(oldTargetPath, { force: true }).catch(() => {});
    }
    const targetPath = path.join(cloneDir, record.path);
    if (record.status.startsWith('D')) {
      await rm(targetPath, { force: true }).catch(() => {});
      continue;
    }
    await copyWorktreeFile(record.path, cloneDir);
  }

  for (const relativePath of splitNullList(untracked.stdout)) {
    await copyWorktreeFile(relativePath, cloneDir);
  }

  return {
    name: 'worktree overlay',
    command: 'overlay current git worktree changes',
    durationMs: Date.now() - startedAt,
    code: 0,
    stdout: `trackedEntries=${changedRecords.length} untracked=${
      splitNullList(untracked.stdout).length
    }`,
    stderr: '',
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const keepClone = hasFlag('--keep-clone');
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'gnosis-fresh-clone-'));
  const cloneDir = path.join(tmpRoot, 'gnosis');
  const steps: StepResult[] = [];
  const stepDurations: Record<string, number> = {};
  let failureReason: string | null = null;

  try {
    const sourceUrl = pathToFileURL(ROOT_DIR).toString();
    steps.push(
      await runStep('git clone', 'git', ['clone', '--depth', '1', sourceUrl, cloneDir], tmpRoot),
    );
    steps.push(await overlayCurrentWorktree(cloneDir));
    for (const step of steps) {
      stepDurations[step.name] = step.durationMs;
      if (step.code !== 0) {
        throw new Error(`${step.name} failed with exit code ${step.code}`);
      }
    }

    const clonePackage = path.join(cloneDir, 'package.json');
    if (!existsSync(clonePackage)) {
      throw new Error('fresh clone did not contain package.json');
    }

    for (const step of [
      ['bun install', BUN, ['install', '--frozen-lockfile']] as const,
      ['bootstrap', BUN, ['run', 'bootstrap']] as const,
      ['doctor', BUN, ['run', 'doctor']] as const,
      ['onboarding smoke', BUN, ['run', 'onboarding:smoke']] as const,
    ]) {
      const result = await runStep(step[0], step[1], [...step[2]], cloneDir);
      steps.push(result);
      stepDurations[result.name] = result.durationMs;
      if (result.code !== 0) {
        throw new Error(`${result.name} failed with exit code ${result.code}`);
      }
    }
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
  } finally {
    const totalDurationMs = Date.now() - startedAt;
    if (failureReason === null && totalDurationMs > MAX_VALUE_ARRIVAL_MS) {
      failureReason = `fresh clone value smoke exceeded ${MAX_VALUE_ARRIVAL_MS}ms value-arrival limit`;
    }
    const artifact: SmokeArtifact = {
      generatedAt: new Date().toISOString(),
      sourceRepo: ROOT_DIR,
      cloneDir,
      totalDurationMs,
      maxDurationMs: MAX_VALUE_ARRIVAL_MS,
      passed: failureReason === null,
      failureReason,
      skippedOptionalSteps: ['cloud-review', 'local-llm'],
      stepDurations,
      steps,
      environment: {
        platform: process.platform,
        bun: BUN,
        nodeEnv: process.env.NODE_ENV ?? null,
        scrubbedEnvKeys: SCRUBBED_ENV_KEYS,
      },
    };
    await writeArtifact(artifact);
    recordQualityGate(
      'freshCloneValueSmoke',
      artifact.passed ? 'passed' : 'failed',
      artifact.passed
        ? `fresh clone value smoke passed (${artifact.totalDurationMs}ms)`
        : failureReason ?? 'fresh clone value smoke failed',
    );
    if (!keepClone) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }

    if (artifact.passed) {
      process.stdout.write(
        `${COLORS.green}fresh-clone:value-smoke passed (${artifact.totalDurationMs}ms)${COLORS.reset}\n`,
      );
    } else {
      process.stderr.write(
        `${COLORS.red}fresh-clone:value-smoke failed: ${failureReason}${COLORS.reset}\n`,
      );
      process.exitCode = 1;
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    recordQualityGate('freshCloneValueSmoke', 'failed', message);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
