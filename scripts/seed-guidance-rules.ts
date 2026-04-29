import { and, eq, sql } from 'drizzle-orm';
import { closeDbPool, db } from '../src/db/index.js';
import { entities, vibeMemories } from '../src/db/schema.js';
import { GUIDANCE_RULE_SEEDS, type GuidanceRuleSeed } from '../src/knowledge/guidanceRuleSeeds.js';
import { generateEmbedding } from '../src/services/memory.js';
import { sha256 } from '../src/utils/crypto.js';
import { generateEntityId } from '../src/utils/entityId.js';

const SESSION_ID = 'default';
const SEED_SOURCE = 'guidance_rule_seed';

type SeedResult = {
  total: number;
  applied: number;
  dryRun: boolean;
};

function archiveKeyFor(seed: GuidanceRuleSeed): string {
  return seed.archiveKey ?? `seed:guidance-rule:${sha256(`${seed.title}\n${seed.content}`)}`;
}

function seedMetadata(seed: GuidanceRuleSeed, archiveKey: string) {
  return {
    kind: 'guidance',
    guidanceType: 'rule',
    scope: seed.scope,
    priority: seed.priority,
    title: seed.title,
    tags: [...seed.tags],
    archiveKey,
    category: seed.category,
    appliesWhen: seed.appliesWhen,
    source: SEED_SOURCE,
    seededAt: new Date().toISOString(),
  };
}

async function upsertSeed(seed: GuidanceRuleSeed): Promise<void> {
  const archiveKey = archiveKeyFor(seed);
  const embedding = await generateEmbedding(seed.content);
  const dedupeKey = `guidance:${sha256(`${archiveKey}:${seed.title}:${seed.content}`)}`;
  const metadata = seedMetadata(seed, archiveKey);

  const [memory] = await db
    .insert(vibeMemories)
    .values({
      sessionId: SESSION_ID,
      content: seed.content,
      embedding,
      dedupeKey,
      metadata,
    })
    .onConflictDoUpdate({
      target: [vibeMemories.sessionId, vibeMemories.dedupeKey],
      set: {
        content: seed.content,
        embedding,
        metadata,
      },
    })
    .returning({ id: vibeMemories.id });

  const entityId = seed.sourceIds?.entityId ?? generateEntityId('rule', seed.title);
  const existingRows = await db
    .select({ metadata: entities.metadata })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  const existingMetadata =
    existingRows[0]?.metadata && typeof existingRows[0].metadata === 'object'
      ? (existingRows[0].metadata as Record<string, unknown>)
      : {};

  await db
    .insert(entities)
    .values({
      id: entityId,
      type: 'rule',
      name: seed.title,
      description: seed.content,
      embedding,
      metadata: {
        ...existingMetadata,
        guidanceType: 'rule',
        scope: seed.scope,
        priority: seed.priority,
        tags: [...seed.tags],
        archiveKey,
        category: seed.category,
        appliesWhen: seed.appliesWhen,
        guidanceMemoryId: memory.id,
        source: SEED_SOURCE,
        seededAt: new Date().toISOString(),
      },
      confidence: seed.scope === 'always' ? 0.9 : 0.75,
      provenance: SEED_SOURCE,
      scope: seed.scope,
      freshness: new Date(),
    })
    .onConflictDoUpdate({
      target: entities.id,
      set: {
        type: sql`excluded.type`,
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        embedding: sql`excluded.embedding`,
        metadata: sql`excluded.metadata`,
        confidence: sql`GREATEST(COALESCE(${entities.confidence}, 0), excluded.confidence)`,
        provenance: sql`excluded.provenance`,
        scope: sql`excluded.scope`,
        freshness: sql`excluded.freshness`,
      },
    });
}

async function seedGuidanceRules(apply: boolean): Promise<SeedResult> {
  if (!apply) {
    return {
      total: GUIDANCE_RULE_SEEDS.length,
      applied: 0,
      dryRun: true,
    };
  }

  for (const seed of GUIDANCE_RULE_SEEDS) {
    await upsertSeed(seed);
  }

  return {
    total: GUIDANCE_RULE_SEEDS.length,
    applied: GUIDANCE_RULE_SEEDS.length,
    dryRun: false,
  };
}

async function summarizeExistingSeeds() {
  const rows = await db
    .select({
      scope: sql<string>`${vibeMemories.metadata}->>'scope'`,
      count: sql<number>`count(*)::int`,
    })
    .from(vibeMemories)
    .where(
      and(
        eq(vibeMemories.sessionId, SESSION_ID),
        sql`${vibeMemories.metadata} @> '{"kind":"guidance","guidanceType":"rule"}'::jsonb`,
      ),
    )
    .groupBy(sql`${vibeMemories.metadata}->>'scope'`);
  return rows;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const result = await seedGuidanceRules(apply);
  const existing = await summarizeExistingSeeds();
  console.log(JSON.stringify({ ...result, existing }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
