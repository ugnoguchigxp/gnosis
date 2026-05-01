import { desc, sql } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import {
  knowledgeClaims,
  knowledgeRelations,
  knowledgeSources,
  knowledgeTopics,
} from '../db/schema.js';
import { parseArgMap } from '../services/knowflow/utils/args.js';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output.js';

type TopicSummary = {
  id: string;
  canonicalTopic: string;
  confidence: number;
  coverage: number;
  updatedAt: string;
  claimCount: number;
  relationCount: number;
  sourceCount: number;
  staleSourceCount: number;
  duplicateSourceUrlCount: number;
  sourceMissing: boolean;
};

type AggregateCountRow = { topic_id?: string; count?: number | string };
type DuplicateCountRow = { topic_id?: string; duplicate_count?: number | string };

const asNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

const columnExists = async (table: string, column: string): Promise<boolean> => {
  const result = await db.execute(
    sql`
      SELECT EXISTS(
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ${table}
          AND column_name = ${column}
      ) AS exists
    `,
  );
  const row = result.rows[0] as { exists?: boolean } | undefined;
  return row?.exists === true;
};

const countByTopic = async (
  table: string,
  countExpr = 'count(*)::int',
): Promise<Map<string, number>> => {
  try {
    const result = await db.execute(
      sql.raw(
        `SELECT topic_id, ${countExpr} AS count
         FROM ${table}
         GROUP BY topic_id`,
      ),
    );
    const map = new Map<string, number>();
    for (const row of result.rows as AggregateCountRow[]) {
      if (typeof row.topic_id === 'string') {
        map.set(row.topic_id, asNumber(row.count ?? 0));
      }
    }
    return map;
  } catch {
    return new Map<string, number>();
  }
};

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);

  const topicRows = await db
    .select({
      id: knowledgeTopics.id,
      canonicalTopic: knowledgeTopics.canonicalTopic,
      confidence: knowledgeTopics.confidence,
      coverage: knowledgeTopics.coverage,
      updatedAt: knowledgeTopics.updatedAt,
    })
    .from(knowledgeTopics)
    .orderBy(desc(knowledgeTopics.updatedAt))
    .limit(1000);

  const relationsTopicIdExists = await columnExists('knowledge_relations', 'topic_id');
  const [claimCountMap, relationCountMap, sourceCountMap, staleSourceCountMap] = await Promise.all([
    countByTopic('knowledge_claims'),
    relationsTopicIdExists
      ? countByTopic('knowledge_relations')
      : Promise.resolve(new Map<string, number>()),
    countByTopic('knowledge_sources'),
    countByTopic(
      'knowledge_sources',
      `count(*) FILTER (WHERE fetched_at < extract(epoch from now() - interval '30 days') * 1000)::int`,
    ),
  ]);

  const output: TopicSummary[] = topicRows.map((row) => {
    const claimCount = claimCountMap.get(row.id) ?? 0;
    const relationCount = relationCountMap.get(row.id) ?? 0;
    const sourceCount = sourceCountMap.get(row.id) ?? 0;
    return {
      id: row.id,
      canonicalTopic: row.canonicalTopic,
      confidence: row.confidence,
      coverage: row.coverage,
      updatedAt: row.updatedAt.toISOString(),
      claimCount,
      relationCount,
      sourceCount,
      staleSourceCount: staleSourceCountMap.get(row.id) ?? 0,
      duplicateSourceUrlCount: 0,
      sourceMissing: sourceCount === 0 && (claimCount > 0 || relationCount > 0),
    };
  });

  let duplicateRows: DuplicateCountRow[] = [];
  try {
    const duplicateResult = await db.execute(
      sql.raw(`
      SELECT topic_id, count(*)::int AS duplicate_count
      FROM (
        SELECT topic_id, url
        FROM knowledge_sources
        GROUP BY topic_id, url
        HAVING count(*) > 1
      ) d
      GROUP BY topic_id
    `),
    );
    duplicateRows = duplicateResult.rows as DuplicateCountRow[];
  } catch {
    duplicateRows = [];
  }
  const duplicateMap = new Map<string, number>();
  for (const row of duplicateRows) {
    if (typeof row.topic_id === 'string') {
      duplicateMap.set(row.topic_id, asNumber(row.duplicate_count ?? 0));
    }
  }
  for (const row of output) {
    row.duplicateSourceUrlCount = duplicateMap.get(row.id) ?? 0;
  }

  process.stdout.write(renderOutput(output, outputFormat));
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
