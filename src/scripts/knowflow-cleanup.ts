import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { entities } from '../db/schema.js';
import { parseArgMap, readBooleanFlag } from '../services/knowflow/utils/args.js';

const PLACEHOLDER = 'Extracted from plain-text emergent topic output.';
const FOLLOWUP_PREFIX = 'KnowFlow follow-up topic discovered from';
const ATTEMPTED_PREFIX =
  'KnowFlow attempted this frontier topic but did not record enough useful knowledge.';
const PIPELINE_FAILED_PREFIX = 'KF_PIPELINE_FAILED';
const NO_KNOWLEDGE_PREFIX = 'KF_NO_KNOWLEDGE';
const SYSTEM_TOOL_PARSE_FAILURE_PREFIX =
  '[System] Tool call or think block was generated but failed to parse.';

type EntityRow = {
  id: string;
  type: string;
  name: string;
  description: string | null;
  metadata: unknown;
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const deletionWhere = () =>
  and(
    or(eq(entities.type, 'concept'), eq(entities.type, 'knowflow_topic_state')),
    or(
      eq(entities.description, PLACEHOLDER),
      sql`${entities.name} = ${entities.description}`,
      sql`(${entities.metadata} ->> 'whyResearch') = ${PLACEHOLDER}`,
      sql`${entities.description} LIKE ${`${FOLLOWUP_PREFIX}%`}`,
      sql`${entities.description} LIKE ${`${ATTEMPTED_PREFIX}%`}`,
      sql`${entities.description} LIKE ${`${PIPELINE_FAILED_PREFIX}%`}`,
      sql`${entities.description} LIKE ${`${NO_KNOWLEDGE_PREFIX}%`}`,
      sql`${entities.description} LIKE ${`${SYSTEM_TOOL_PARSE_FAILURE_PREFIX}%`}`,
    ),
  );

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const apply = readBooleanFlag(args, 'apply');
  const dryRun = readBooleanFlag(args, 'dry-run');
  const unsupported = Object.keys(args).filter((key) => key !== 'apply' && key !== 'dry-run');
  if (unsupported.length > 0) {
    throw new Error(`Unsupported option(s): ${unsupported.map((key) => `--${key}`).join(', ')}`);
  }
  if (apply && dryRun) {
    throw new Error('Use either --apply or --dry-run, not both.');
  }

  const candidates: EntityRow[] = await db
    .select({
      id: entities.id,
      type: entities.type,
      name: entities.name,
      description: entities.description,
      metadata: entities.metadata,
    })
    .from(entities)
    .where(deletionWhere())
    .orderBy(sql`${entities.createdAt} ASC`);

  let deleted = 0;
  if (apply && candidates.length > 0) {
    for (const rows of chunk(candidates, 500)) {
      const ids = rows.map((row) => row.id);
      const result = await db.delete(entities).where(inArray(entities.id, ids)).returning({
        id: entities.id,
      });
      deleted += result.length;
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        matched: candidates.length,
        deleted,
        deletionCriteria: [
          'name_equals_description',
          `description_equals:${PLACEHOLDER}`,
          'metadata_whyResearch_equals_placeholder',
          `description_prefix:${FOLLOWUP_PREFIX}`,
          `description_prefix:${ATTEMPTED_PREFIX}`,
          `description_prefix:${PIPELINE_FAILED_PREFIX}`,
          `description_prefix:${NO_KNOWLEDGE_PREFIX}`,
          `description_prefix:${SYSTEM_TOOL_PARSE_FAILURE_PREFIX}`,
        ],
        samples: candidates.slice(0, 20).map((row) => ({
          id: row.id,
          type: row.type,
          name: row.name,
          description: row.description,
          whyResearch:
            typeof (row.metadata as Record<string, unknown> | null)?.whyResearch === 'string'
              ? ((row.metadata as Record<string, unknown>).whyResearch as string)
              : null,
        })),
      },
      null,
      2,
    )}\n`,
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
