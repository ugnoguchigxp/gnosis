#!/usr/bin/env bun

import { Database } from 'bun:sqlite';
import { GNOSIS_CONSTANTS } from '../constants.js';
import { closeDbPool } from '../db/index.js';
import { PgJsonbQueueRepository } from '../services/knowflow/queue/pgJsonbRepository.js';

type BackgroundTaskRow = {
  id: string;
  type: string;
  status: string;
  payload: string;
  priority: number;
};

type SystemTaskType = 'synthesis' | 'embedding_batch' | 'session_distillation';

const SYSTEM_MAPPERS: Record<
  SystemTaskType,
  {
    topicFrom: (row: BackgroundTaskRow, payload: Record<string, unknown>) => string;
    payloadFrom: (payload: Record<string, unknown>) => Record<string, unknown>;
  }
> = {
  synthesis: {
    topicFrom: () => '__system__/synthesis',
    payloadFrom: (payload) => ({
      maxFailures: typeof payload.maxFailures === 'number' ? payload.maxFailures : 0,
    }),
  },
  embedding_batch: {
    topicFrom: () => '__system__/embedding_batch',
    payloadFrom: (payload) => ({
      batchSize: typeof payload.batchSize === 'number' ? payload.batchSize : 50,
    }),
  },
  session_distillation: {
    topicFrom: (_row, payload) => {
      const sessionId =
        typeof payload.sessionId === 'string' && payload.sessionId.trim().length > 0
          ? payload.sessionId.trim()
          : 'unknown';
      return `__system__/session_distillation/${sessionId}`;
    },
    payloadFrom: (payload) => ({
      sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : '',
      force: payload.force === true,
      promote: payload.promote === true,
      provider:
        payload.provider === 'auto' ||
        payload.provider === 'deterministic' ||
        payload.provider === 'local' ||
        payload.provider === 'openai' ||
        payload.provider === 'bedrock'
          ? payload.provider
          : 'auto',
    }),
  },
};

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {}
  return {};
}

function targetPriority(type: SystemTaskType, sourcePriority: number): number {
  if (type === 'embedding_batch') return GNOSIS_CONSTANTS.EMBED_BACKGROUND_TASK_PRIORITY_DEFAULT;
  return sourcePriority > 0 ? sourcePriority : 10;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const keepSource = args.includes('--keep-source');
  const dbPathArgIndex = args.indexOf('--db');
  const dbPath = dbPathArgIndex >= 0 ? args[dbPathArgIndex + 1] : 'data/gnosis-tasks.sqlite';
  if (!dbPath) throw new Error('--db requires value');

  const bgDb = new Database(dbPath);
  const queue = new PgJsonbQueueRepository();

  const rows = bgDb
    .query(
      `
      SELECT id, type, status, payload, priority
      FROM background_tasks
      WHERE type IN ('synthesis', 'embedding_batch', 'session_distillation')
        AND status IN ('pending', 'failed', 'running')
      ORDER BY created_at ASC
    `,
    )
    .all() as BackgroundTaskRow[];

  let migrated = 0;
  let skipped = 0;
  const migratedSourceTaskIds: string[] = [];

  for (const row of rows) {
    const type = row.type as SystemTaskType;
    const mapper = SYSTEM_MAPPERS[type];
    if (!mapper) {
      skipped += 1;
      continue;
    }

    const payload = parseJsonObject(row.payload);
    const topic = mapper.topicFrom(row, payload);
    const systemPayload = mapper.payloadFrom(payload);
    if (type === 'session_distillation' && typeof systemPayload.sessionId !== 'string') {
      skipped += 1;
      continue;
    }

    if (!dryRun) {
      await queue.enqueue({
        topic,
        mode: 'directed',
        source: 'cron',
        requestedBy: 'background-queue-migration',
        sourceGroup: `migration/${type}`,
        priority: targetPriority(type, row.priority),
        metadata: {
          migratedFromBackgroundTaskId: row.id,
          systemTask: {
            type,
            payload: systemPayload,
          },
        },
      });
      migratedSourceTaskIds.push(row.id);
    }

    migrated += 1;
  }

  if (!dryRun && !keepSource && migratedSourceTaskIds.length > 0) {
    const placeholders = migratedSourceTaskIds.map(() => '?').join(', ');
    bgDb.run(
      `
      DELETE FROM background_tasks
      WHERE id IN (${placeholders})
    `,
      migratedSourceTaskIds,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        keepSource,
        scanned: rows.length,
        migrated,
        skipped,
        sourceDb: dbPath,
      },
      null,
      2,
    ),
  );
}

run()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
