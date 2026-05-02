#!/usr/bin/env bun

import { closeDbPool } from '../db/index.js';
import { PgJsonbQueueRepository } from '../services/knowflow/queue/pgJsonbRepository.js';
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
    const queue = new PgJsonbQueueRepository();
    const sessionId = requireArg(argv, '--session-id');
    const provider = getArg(argv, '--provider') as
      | 'auto'
      | 'deterministic'
      | 'local'
      | 'openai'
      | 'bedrock'
      | undefined;
    const priority = toOptionalPriority(argv);
    const force = toBool(argv, '--force');
    const promote = toBool(argv, '--promote');
    const enqueued = await queue.enqueue({
      topic: `__system__/session_distillation/${sessionId}`,
      mode: 'directed',
      source: 'monitor',
      requestedBy: 'session-summary',
      sourceGroup: `session-distillation/${sessionId}`,
      priority: priority ?? 30,
      metadata: {
        systemTask: {
          type: 'session_distillation',
          payload: {
            sessionId,
            force,
            promote,
            provider: provider ?? 'auto',
          },
        },
      },
    });

    const payload = {
      taskId: enqueued.task.id,
      sessionId,
      status: 'pending',
      queued: !enqueued.deduped,
      deduped: enqueued.deduped,
      force,
      promote,
      provider: provider ?? 'auto',
    };
    console.log(asJson ? JSON.stringify(payload, null, 2) : `queued: ${payload.taskId}`);
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
