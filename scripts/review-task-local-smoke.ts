#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDbPool } from '../src/db/index.js';
import { runReviewTaskForMcp } from '../src/mcp/tools/agentFirst.js';
import { COLORS, loadLocalEnv } from './lib/quality.js';

type ReviewTaskLocalSmokeArtifact = {
  generatedAt: string;
  command: string;
  provider: 'local';
  targetType: string;
  target: Record<string, unknown>;
  status: string;
  passed: boolean;
  durationMs: number;
  maxDurationMs: number;
  consecutiveOkRuns: number;
  reason: string | null;
  llmPoolLock?: LlmPoolLockEvidence | null;
  result: unknown;
};

type LlmPoolLockEvidence = {
  lockFile: string;
  pid: number | null;
  ageMs: number;
  alive: boolean;
};

const ROOT_DIR = process.cwd();
const ARTIFACT_PATH = path.join(ROOT_DIR, 'logs', 'review-task-local-smoke.json');
const MAX_DURATION_MS = 300_000;
const ACTIVE_LOCK_FAIL_FAST_AGE_MS = 30_000;

function readFlagValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

async function writeArtifact(artifact: ReviewTaskLocalSmokeArtifact): Promise<void> {
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
}

function readLlmPoolLock(): LlmPoolLockEvidence | null {
  const lockFile = path.join(tmpdir(), 'gnosis-llm-pool-0.lock');
  if (!existsSync(lockFile)) return null;
  const ageMs = Date.now() - statSync(lockFile).mtimeMs;
  const rawPid = Number.parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
  const pid = Number.isNaN(rawPid) ? null : rawPid;
  let alive = false;
  if (pid !== null) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  return { lockFile, pid, ageMs, alive };
}

async function readPreviousConsecutiveOkRuns(documentPath: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(ARTIFACT_PATH, 'utf8')) as Record<string, unknown>;
    if (parsed.status !== 'ok') return 0;
    if (parsed.passed === false) return 0;
    if (typeof parsed.durationMs !== 'number' || parsed.durationMs > MAX_DURATION_MS) return 0;
    const target =
      typeof parsed.target === 'object' && parsed.target !== null && !Array.isArray(parsed.target)
        ? (parsed.target as Record<string, unknown>)
        : {};
    if (target.documentPath !== documentPath) return 0;
    return typeof parsed.consecutiveOkRuns === 'number' ? parsed.consecutiveOkRuns : 1;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  loadLocalEnv(path.join(ROOT_DIR, '.env'));
  const documentPath = readFlagValue('--document-path') ?? 'docs/project-value-improvement-plan.md';
  const startedAt = Date.now();
  const llmPoolLock = readLlmPoolLock();
  if (llmPoolLock?.alive && llmPoolLock.ageMs > ACTIVE_LOCK_FAIL_FAST_AGE_MS) {
    const reason = `llm-pool is occupied by PID ${llmPoolLock.pid} for ${Math.round(
      llmPoolLock.ageMs / 1000,
    )}s; local review smoke cannot prove five-minute completion`;
    await writeArtifact({
      generatedAt: new Date().toISOString(),
      command: `bun run review:local-smoke -- --document-path ${documentPath}`,
      provider: 'local',
      targetType: 'implementation_plan',
      target: { documentPath },
      status: 'blocked',
      passed: false,
      durationMs: Date.now() - startedAt,
      maxDurationMs: MAX_DURATION_MS,
      consecutiveOkRuns: 0,
      reason,
      llmPoolLock,
      result: null,
    });
    process.stderr.write(`${COLORS.yellow}${reason}${COLORS.reset}\n`);
    process.exitCode = 1;
    return;
  }
  const result = await runReviewTaskForMcp({
    provider: 'local',
    targetType: 'implementation_plan',
    target: { documentPath },
    repoPath: ROOT_DIR,
    knowledgePolicy: 'best_effort',
    goal: 'Local provider smoke for project value evidence.',
  });
  const durationMs = Date.now() - startedAt;
  const resultRecord =
    typeof result === 'object' && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  const status = typeof resultRecord.status === 'string' ? resultRecord.status : 'unknown';
  const diagnostics =
    typeof resultRecord.diagnostics === 'object' && resultRecord.diagnostics !== null
      ? (resultRecord.diagnostics as Record<string, unknown>)
      : {};
  const degradedReasons = Array.isArray(diagnostics.degradedReasons)
    ? diagnostics.degradedReasons.join(',')
    : null;
  const reason =
    typeof diagnostics.errorMessage === 'string'
      ? diagnostics.errorMessage
      : degradedReasons || null;
  const withinMaxDuration = durationMs <= MAX_DURATION_MS;
  const passed = status === 'ok' && withinMaxDuration;
  const previousConsecutiveOkRuns = await readPreviousConsecutiveOkRuns(documentPath);
  const consecutiveOkRuns = passed ? previousConsecutiveOkRuns + 1 : 0;
  const smokeReason =
    !withinMaxDuration && status === 'ok'
      ? `local review exceeded ${MAX_DURATION_MS}ms value-evidence limit`
      : reason;

  await writeArtifact({
    generatedAt: new Date().toISOString(),
    command: `bun run review:local-smoke -- --document-path ${documentPath}`,
    provider: 'local',
    targetType: 'implementation_plan',
    target: { documentPath },
    status,
    passed,
    durationMs,
    maxDurationMs: MAX_DURATION_MS,
    consecutiveOkRuns,
    reason: smokeReason,
    llmPoolLock,
    result,
  });

  const color = passed ? COLORS.green : COLORS.yellow;
  process.stdout.write(
    `${color}review:local-smoke status=${status} passed=${passed} durationMs=${durationMs}${COLORS.reset}\n`,
  );
  if (!passed) {
    process.exitCode = 1;
  }
}

main()
  .catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    await writeArtifact({
      generatedAt: new Date().toISOString(),
      command: 'bun run review:local-smoke',
      provider: 'local',
      targetType: 'implementation_plan',
      target: {},
      status: 'failed',
      passed: false,
      durationMs: 0,
      maxDurationMs: MAX_DURATION_MS,
      consecutiveOkRuns: 0,
      reason: message,
      llmPoolLock: readLlmPoolLock(),
      result: null,
    });
    process.stderr.write(`${COLORS.red}${message}${COLORS.reset}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
