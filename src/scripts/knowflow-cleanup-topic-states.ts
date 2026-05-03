import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { entities } from '../db/schema.js';
import {
  parseArgMap,
  readBooleanFlag,
  readNumberFlag,
  readStringFlag,
} from '../services/knowflow/utils/args.js';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output.js';

const DEFAULT_LIMIT = 5000;
const DEFAULT_PREFIXES = [
  'KnowFlow frontier topic selected from %',
  'KnowFlow frontier candidate queued (%',
  'KnowFlow attempted this frontier topic but did not record enough useful knowledge.%',
];

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);
  const apply = readBooleanFlag(args, 'apply');
  const limit = Math.max(1, Math.trunc(readNumberFlag(args, 'limit') ?? DEFAULT_LIMIT));
  const prefixesRaw = readStringFlag(args, 'prefix');
  const prefixes =
    prefixesRaw && prefixesRaw.trim().length > 0
      ? prefixesRaw
          .split(',')
          .map((prefix) => prefix.trim())
          .filter((prefix) => prefix.length > 0)
      : DEFAULT_PREFIXES;

  const where = and(
    eq(entities.type, 'knowflow_topic_state'),
    or(...prefixes.map((prefix) => ilike(entities.description, prefix))),
  );

  const candidates = await db
    .select({
      id: entities.id,
      name: entities.name,
      description: entities.description,
      createdAt: entities.createdAt,
      updatedAt: entities.lastReferencedAt,
    })
    .from(entities)
    .where(where)
    .orderBy(sql`${entities.createdAt} ASC`)
    .limit(limit);

  const ids = candidates.map((row) => row.id);
  let deleted = 0;

  if (apply && ids.length > 0) {
    for (const idChunk of chunk(ids, 500)) {
      const result = await db.delete(entities).where(inArray(entities.id, idChunk));
      deleted += result.rowCount ?? 0;
    }
  }

  process.stdout.write(
    renderOutput(
      {
        mode: apply ? 'apply' : 'dry-run',
        limit,
        prefixes,
        matched: ids.length,
        deleted,
        samples: candidates.slice(0, 20).map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          createdAt: row.createdAt?.toISOString?.() ?? null,
        })),
      },
      outputFormat,
    ),
  );
};

run()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
