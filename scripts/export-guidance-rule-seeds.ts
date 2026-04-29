import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { closeDbPool, db } from '../src/db/index.js';
import { entities, vibeMemories } from '../src/db/schema.js';

type GuidanceRuleSeed = {
  title: string;
  content: string;
  guidanceType: 'rule';
  scope: 'always' | 'on_demand';
  priority: number;
  tags: string[];
  category?: string;
  appliesWhen?: Record<string, unknown>;
  archiveKey?: string;
  sourceIds?: {
    vibeMemoryId?: string;
    entityId?: string;
  };
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(__dirname, '../src/knowledge/guidanceRuleSeeds.ts');

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item, index, values) => item.length > 0 && values.indexOf(item) === index);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function priorityFrom(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return fallback;
}

function normalizeSeed(input: GuidanceRuleSeed): GuidanceRuleSeed {
  const appliesWhen = metadataRecord(input.appliesWhen);
  return {
    title: input.title,
    content: input.content,
    guidanceType: 'rule',
    scope: input.scope === 'always' ? 'always' : 'on_demand',
    priority: Math.max(0, Math.min(100, input.priority)),
    tags: stringArray(input.tags),
    ...(input.category ? { category: input.category } : {}),
    ...(Object.keys(appliesWhen).length > 0 ? { appliesWhen } : {}),
    ...(input.archiveKey ? { archiveKey: input.archiveKey } : {}),
    ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
  };
}

async function loadGuidanceRuleSeeds(): Promise<GuidanceRuleSeed[]> {
  const byKey = new Map<string, GuidanceRuleSeed>();
  const guidanceRows = await db
    .select({
      id: vibeMemories.id,
      content: vibeMemories.content,
      metadata: vibeMemories.metadata,
    })
    .from(vibeMemories)
    .where(
      and(
        eq(vibeMemories.sessionId, 'default'),
        sql`${vibeMemories.metadata} @> ${JSON.stringify({
          kind: 'guidance',
          guidanceType: 'rule',
        })}::jsonb`,
      ),
    );

  for (const row of guidanceRows) {
    const metadata = metadataRecord(row.metadata);
    const title = optionalString(metadata.title) ?? row.content.slice(0, 80);
    const seed = normalizeSeed({
      title,
      content: row.content,
      guidanceType: 'rule',
      scope: metadata.scope === 'always' ? 'always' : 'on_demand',
      priority: priorityFrom(metadata.priority, metadata.scope === 'always' ? 100 : 80),
      tags: stringArray(metadata.tags),
      category: optionalString(metadata.category),
      appliesWhen: metadataRecord(metadata.appliesWhen),
      archiveKey: optionalString(metadata.archiveKey),
      sourceIds: { vibeMemoryId: row.id },
    });
    byKey.set(`${seed.title}\n${seed.content}`, seed);
  }

  const entityRows = await db
    .select({
      id: entities.id,
      type: entities.type,
      name: entities.name,
      description: entities.description,
      metadata: entities.metadata,
      scope: entities.scope,
    })
    .from(entities)
    .where(inArray(entities.type, ['rule', 'constraint']));

  for (const row of entityRows) {
    const metadata = metadataRecord(row.metadata);
    const content = row.description ?? '';
    const key = `${row.name}\n${content}`;
    const existing = byKey.get(key);
    const seed = normalizeSeed({
      title: row.name,
      content,
      guidanceType: 'rule',
      scope: row.scope === 'always' ? 'always' : 'on_demand',
      priority: priorityFrom(metadata.priority, row.scope === 'always' ? 100 : 80),
      tags: stringArray(metadata.tags),
      category: optionalString(metadata.category),
      appliesWhen: metadataRecord(metadata.appliesWhen),
      archiveKey: optionalString(metadata.archiveKey),
      sourceIds: {
        ...existing?.sourceIds,
        entityId: row.id,
      },
    });
    byKey.set(key, {
      ...existing,
      ...seed,
      sourceIds: {
        ...existing?.sourceIds,
        entityId: row.id,
      },
    });
  }

  return [...byKey.values()].sort((left, right) => {
    const scopeDelta = left.scope.localeCompare(right.scope);
    if (scopeDelta !== 0) return scopeDelta;
    const priorityDelta = right.priority - left.priority;
    if (priorityDelta !== 0) return priorityDelta;
    return left.title.localeCompare(right.title);
  });
}

function renderSeeds(seeds: GuidanceRuleSeed[]): string {
  return `// Auto-generated from the local Gnosis guidance database.
// Generated on 2026-04-29. Re-apply with scripts/seed-guidance-rules.ts.

export type GuidanceRuleSeed = {
  title: string;
  content: string;
  guidanceType: 'rule';
  scope: 'always' | 'on_demand';
  priority: number;
  tags: string[];
  category?: string;
  appliesWhen?: {
    intents?: Array<'plan' | 'edit' | 'debug' | 'review' | 'finish'>;
    changeTypes?: string[];
    fileGlobs?: string[];
    technologies?: string[];
    keywords?: string[];
    severity?: 'blocking' | 'required' | 'advisory';
  };
  archiveKey?: string;
  sourceIds?: {
    vibeMemoryId?: string;
    entityId?: string;
  };
};

export const GUIDANCE_RULE_SEEDS = ${JSON.stringify(seeds, null, 2)} as const satisfies readonly GuidanceRuleSeed[];
`;
}

async function main() {
  const seeds = await loadGuidanceRuleSeeds();
  await writeFile(outputPath, renderSeeds(seeds), 'utf8');
  console.log(
    JSON.stringify(
      {
        outputPath,
        total: seeds.length,
        always: seeds.filter((seed) => seed.scope === 'always').length,
        onDemand: seeds.filter((seed) => seed.scope === 'on_demand').length,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
