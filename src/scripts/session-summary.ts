#!/usr/bin/env bun

import { closeDbPool } from '../db/index.js';
import { scheduler } from '../services/background/scheduler.js';
import {
  findLatestSessionDistillation,
  getCandidatesByDistillationId,
  getDistillationById,
  listDistillations,
} from '../services/sessionSummary/repository.js';

function getArg(argv: string[], key: string): string | undefined {
  const index = argv.indexOf(key);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function requireArg(argv: string[], key: string): string {
  const value = getArg(argv, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function toBool(argv: string[], key: string): boolean {
  return argv.includes(key);
}

function toOptionalPriority(argv: string[]): number | undefined {
  const raw = getArg(argv, '--priority');
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error('--priority must be a number');
  return Math.trunc(parsed);
}

async function run(argv: string[]) {
  const command = argv[0];
  const asJson = argv.includes('--json');

  if (command === 'enqueue') {
    const sessionId = requireArg(argv, '--session-id');
    const provider = getArg(argv, '--provider') as
      | 'auto'
      | 'deterministic'
      | 'local'
      | 'openai'
      | 'bedrock'
      | undefined;
    const priority = toOptionalPriority(argv);
    const taskId = `session-distillation:${sessionId}`;
    const force = toBool(argv, '--force');
    const promote = toBool(argv, '--promote');
    await scheduler.enqueue(
      'session_distillation',
      { sessionId, force, promote, provider: provider ?? 'auto' },
      {
        id: taskId,
        priority: priority ?? 30,
      },
    );

    const payload = {
      taskId,
      sessionId,
      status: 'pending',
      queued: true,
      force,
      promote,
      provider: provider ?? 'auto',
    };
    console.log(asJson ? JSON.stringify(payload, null, 2) : `queued: ${taskId}`);
    return;
  }

  if (command === 'list') {
    const rows = await listDistillations();
    console.log(asJson ? JSON.stringify(rows, null, 2) : rows.map((row) => row.id).join('\n'));
    return;
  }

  if (command === 'show') {
    const distillationId = requireArg(argv, '--distillation-id');
    const record = await getDistillationById(distillationId);
    if (!record) throw new Error(`distillation not found: ${distillationId}`);
    const candidates = await getCandidatesByDistillationId(distillationId);
    console.log(
      asJson ? JSON.stringify({ record, candidates }, null, 2) : `${record.id} ${record.status}`,
    );
    return;
  }

  if (command === 'status') {
    const sessionId = requireArg(argv, '--session-id');
    const record = await findLatestSessionDistillation(sessionId);
    if (!record) {
      console.log(asJson ? JSON.stringify(null, null, 2) : 'not_found');
      return;
    }
    const candidates = await getCandidatesByDistillationId(record.id);
    console.log(
      asJson
        ? JSON.stringify({ record, candidates }, null, 2)
        : `${record.status} keep=${record.keptCount} drop=${record.droppedCount}`,
    );
    return;
  }

  throw new Error(
    'Usage: bun src/scripts/session-summary.ts <enqueue|list|show|status> [--session-id <id>] [--distillation-id <id>] [--json]',
  );
}

if (import.meta.main) {
  run(process.argv.slice(2))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    })
    .finally(async () => {
      await closeDbPool();
    });
}
