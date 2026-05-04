#!/usr/bin/env bun

import { closeDbPool } from '../db/index.js';
import { PgJsonbQueueRepository } from '../services/knowflow/queue/pgJsonbRepository.js';
import {
  filterSessionKnowledgeCandidates,
  findLatestSessionDistillation,
  getCandidatesByDistillationId,
  getDistillationById,
  listDistillations,
} from '../services/sessionSummary/repository.js';

function buildSummaryPreview(
  candidates: Array<{
    keep: boolean;
    title: string;
    statement: string;
  }>,
): string | null {
  const lines = candidates
    .filter((candidate) => candidate.keep)
    .map((candidate) => candidate.statement.trim() || candidate.title.trim())
    .filter((line, index, list) => line.length > 0 && list.indexOf(line) === index)
    .slice(0, 3);
  if (lines.length === 0) return null;
  return lines.join('\n');
}

function normalizeSummaryText(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\s+/g, ' ').trim();
}

function tokenizeSummary(value: string): Set<string> {
  const normalized = value
    .toLowerCase()
    .replace(/[`"'.,:;!?()[\]{}<>/\\|_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return new Set();
  return new Set(normalized.split(' ').filter(Boolean));
}

function summarySimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftTokens = tokenizeSummary(left);
  const rightTokens = tokenizeSummary(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

function buildSummaryListDedupKey(row: {
  sessionKey: string;
  status: string;
  modelProvider: string | null;
  modelName: string | null;
  summaryPreview: string | null;
  keptCount: number | null;
  droppedCount: number | null;
  error: string | null;
}): string {
  const normalizedPreview = normalizeSummaryText(row.summaryPreview);
  if (normalizedPreview.length > 0) {
    return [row.sessionKey, normalizedPreview].join('|');
  }
  return [
    row.sessionKey,
    row.status,
    row.modelProvider ?? '',
    row.modelName ?? '',
    normalizedPreview,
    String(row.keptCount ?? 0),
    String(row.droppedCount ?? 0),
    row.error ?? '',
  ].join('|');
}

function dedupeSummaryList<
  T extends {
    sessionKey: string;
    status: string;
    modelProvider: string | null;
    modelName: string | null;
    summaryPreview: string | null;
    keptCount: number | null;
    droppedCount: number | null;
    error: string | null;
    createdAt: Date | string;
  },
>(rows: T[]): T[] {
  const deduped = new Map<string, T>();
  const dedupedBySession = new Map<string, T[]>();
  for (const row of rows) {
    const key = buildSummaryListDedupKey(row);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, row);
      continue;
    }
    const rowTime = new Date(row.createdAt).getTime();
    const existingTime = new Date(existing.createdAt).getTime();
    if (rowTime >= existingTime) {
      deduped.set(key, row);
    }
  }
  const exactDeduped = Array.from(deduped.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  // Near-duplicate suppression: treat >=95% similar summaries in the same session as same.
  for (const row of exactDeduped) {
    const existing = dedupedBySession.get(row.sessionKey) ?? [];
    const rowPreview = normalizeSummaryText(row.summaryPreview);
    const duplicated = existing.some((candidate) => {
      const candidatePreview = normalizeSummaryText(candidate.summaryPreview);
      if (!rowPreview || !candidatePreview) return false;
      return summarySimilarity(rowPreview, candidatePreview) >= 0.95;
    });
    if (!duplicated) {
      existing.push(row);
      dedupedBySession.set(row.sessionKey, existing);
    }
  }

  return Array.from(dedupedBySession.values())
    .flat()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

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
    const rowsWithSummary = await Promise.all(
      rows.map(async (row) => {
        const candidates = filterSessionKnowledgeCandidates(
          await getCandidatesByDistillationId(row.id),
        );
        return {
          ...row,
          summaryPreview: buildSummaryPreview(candidates),
        };
      }),
    );
    const dedupedRows = dedupeSummaryList(rowsWithSummary);
    console.log(
      asJson ? JSON.stringify(dedupedRows, null, 2) : dedupedRows.map((row) => row.id).join('\n'),
    );
    return;
  }

  if (command === 'show') {
    const distillationId = requireArg(argv, '--distillation-id');
    const record = await getDistillationById(distillationId);
    if (!record) throw new Error(`distillation not found: ${distillationId}`);
    const candidates = filterSessionKnowledgeCandidates(
      await getCandidatesByDistillationId(distillationId),
    );
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
    const candidates = filterSessionKnowledgeCandidates(
      await getCandidatesByDistillationId(record.id),
    );
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
