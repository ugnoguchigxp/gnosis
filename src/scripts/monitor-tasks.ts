import { desc, inArray, sql } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { topicTasks } from '../db/schema.js';
import { parseArgMap, readStringFlag } from '../services/knowflow/utils/args.js';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output.js';

type TaskEntry = {
  id: string;
  topic: string | null;
  source: string | null;
  status: string;
  priority: number;
  resultSummary: string | null;
  errorReason: string | null;
  nextRunAt: number | null;
  lockedAt: number | null;
  lockOwner: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);
  const statusFilter = readStringFlag(args, 'status');

  let query = db
    .select({
      id: topicTasks.id,
      status: topicTasks.status,
      priority: topicTasks.priority,
      nextRunAt: topicTasks.nextRunAt,
      lockedAt: topicTasks.lockedAt,
      lockOwner: topicTasks.lockOwner,
      payload: topicTasks.payload,
      createdAt: topicTasks.createdAt,
      updatedAt: topicTasks.updatedAt,
    })
    .from(topicTasks);

  if (statusFilter) {
    // biome-ignore lint/suspicious/noExplicitAny: drizzle dynamic query typing workaround
    query = query.where(sql`${topicTasks.status} = ${statusFilter}`) as any;
  }

  const rows = await query.orderBy(desc(topicTasks.updatedAt)).limit(1000);

  const tasks: TaskEntry[] = rows.map((row) => {
    const payload: Record<string, unknown> =
      typeof row.payload === 'object' && row.payload !== null
        ? (row.payload as Record<string, unknown>)
        : {};
    return {
      id: row.id,
      topic: typeof payload.topic === 'string' ? payload.topic : null,
      source: typeof payload.source === 'string' ? payload.source : null,
      status: row.status,
      priority: row.priority,
      resultSummary: typeof payload.resultSummary === 'string' ? payload.resultSummary : null,
      errorReason: typeof payload.errorReason === 'string' ? payload.errorReason : null,
      nextRunAt: row.nextRunAt ?? null,
      lockedAt: row.lockedAt ?? null,
      lockOwner: row.lockOwner ?? null,
      payload,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });

  process.stdout.write(renderOutput(tasks, outputFormat));
};

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await closeDbPool();
});
