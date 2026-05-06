#!/usr/bin/env bun

import { closeDbPool, db } from '../db/index.js';
import { classifyQueueFailureReason } from './status-report.js';

type Bucket =
  | 'task_timeout_600000ms'
  | 'llm_pool_lock_timeout'
  | 'orphaned_or_stale'
  | ReturnType<typeof classifyQueueFailureReason>;

function classify(reason: string | null): Bucket {
  const text = (reason ?? '').toLowerCase();
  if (text.includes('task execution timed out after 600000ms')) return 'task_timeout_600000ms';
  if (text.includes('global lock timeout: llm-pool')) return 'llm_pool_lock_timeout';
  if (text.includes('orphaned running task') || text.includes('stale running task'))
    return 'orphaned_or_stale';
  return classifyQueueFailureReason(reason ?? '');
}

async function main() {
  const days = Number(process.argv[2] ?? '1');
  const windowDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 1;

  const rows = await db.execute(`
    select
      id,
      status,
      payload->>'topic' as topic,
      payload->>'errorReason' as error_reason,
      (payload->>'attempts')::int as attempts,
      created_at,
      updated_at
    from topic_tasks
    where created_at > now() - interval '${windowDays} days'
      and status in ('failed', 'deferred')
    order by updated_at desc
  `);

  const items = (rows.rows ?? rows) as Array<{
    id: string;
    status: string;
    topic: string;
    error_reason: string | null;
    attempts: number | null;
    created_at: string;
    updated_at: string;
  }>;

  const summary = new Map<Bucket, number>();
  for (const item of items) {
    const bucket = classify(item.error_reason);
    summary.set(bucket, (summary.get(bucket) ?? 0) + 1);
  }

  const payload = {
    windowDays,
    total: items.length,
    byBucket: Object.fromEntries(summary.entries()),
    sample: items.slice(0, 25).map((item) => ({
      id: item.id,
      status: item.status,
      topic: item.topic,
      attempts: item.attempts,
      bucket: classify(item.error_reason),
      errorReason: item.error_reason,
      updatedAt: item.updated_at,
    })),
  };

  console.log(JSON.stringify(payload, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  })
  .finally(async () => {
    await closeDbPool();
  });
