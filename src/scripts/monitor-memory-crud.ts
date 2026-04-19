import { and, desc, eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { closeDbPool, db } from '../db/index.js';
import { entities, experienceLogs, relations, vibeMemories } from '../db/schema.js';
import { generateEmbedding } from '../services/memory.js';
import { sha256 } from '../utils/crypto.js';
import { generateEntityId } from '../utils/entityId.js';

type GuidanceType = 'rule' | 'skill';
type GuidanceScope = 'always' | 'on_demand';
type LessonType = 'failure' | 'success';

type GuidancePayload = {
  title: string;
  content: string;
  guidanceType: GuidanceType;
  scope?: GuidanceScope;
  priority?: number;
  tags?: string[];
};

type LessonPayload = {
  sessionId: string;
  scenarioId: string;
  attempt?: number;
  type: LessonType;
  failureType?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
};

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing or invalid ${name}`);
  }
  return value.trim();
}

function parseJsonArg<T>(raw: string | undefined, label: string): T {
  if (!raw) {
    throw new Error(`Missing ${label}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeGuidancePayload(input: GuidancePayload): Required<GuidancePayload> {
  const guidanceType = input.guidanceType === 'skill' ? 'skill' : 'rule';
  const scope = input.scope === 'always' ? 'always' : 'on_demand';
  const priority = Number.isFinite(input.priority)
    ? Math.max(0, Math.min(100, Math.trunc(input.priority ?? 50)))
    : 50;
  const tags = Array.isArray(input.tags)
    ? input.tags
        .map((tag) => String(tag).trim())
        .filter((tag, index, values) => tag.length > 0 && values.indexOf(tag) === index)
    : [];

  return {
    title: requireString(input.title, 'title'),
    content: requireString(input.content, 'content'),
    guidanceType,
    scope,
    priority,
    tags,
  };
}

function normalizeLessonPayload(input: LessonPayload): Required<LessonPayload> {
  const type = input.type === 'success' ? 'success' : 'failure';
  const attempt =
    Number.isFinite(input.attempt) && (input.attempt ?? 0) > 0 ? Math.trunc(input.attempt ?? 1) : 1;

  return {
    sessionId: requireString(input.sessionId, 'sessionId'),
    scenarioId: requireString(input.scenarioId, 'scenarioId'),
    attempt,
    type,
    failureType:
      typeof input.failureType === 'string' && input.failureType.trim().length > 0
        ? input.failureType.trim()
        : null,
    content: requireString(input.content, 'content'),
    metadata:
      input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
        ? input.metadata
        : {},
  };
}

function guidanceEntityType(guidanceType: GuidanceType): 'constraint' | 'task' {
  return guidanceType === 'skill' ? 'task' : 'constraint';
}

function guidanceEntityId(guidanceType: GuidanceType, title: string): string {
  return generateEntityId(guidanceEntityType(guidanceType), title);
}

async function upsertGuidanceEntity(input: {
  memoryId: string;
  title: string;
  content: string;
  guidanceType: GuidanceType;
  scope: GuidanceScope;
  priority: number;
  tags: string[];
  archiveKey: string;
}) {
  const entityType = guidanceEntityType(input.guidanceType);
  const entityId = guidanceEntityId(input.guidanceType, input.title);
  const embedding = await generateEmbedding(`${input.title}\n${input.content}`);

  await db
    .insert(entities)
    .values({
      id: entityId,
      type: entityType,
      name: input.title,
      description: input.content,
      embedding,
      metadata: {
        tags: input.tags,
        archiveKey: input.archiveKey,
        priority: input.priority,
        guidanceMemoryId: input.memoryId,
        updatedFrom: 'monitor',
      },
      confidence: 0.5,
      scope: input.scope,
      provenance: 'monitor',
    })
    .onConflictDoUpdate({
      target: entities.id,
      set: {
        type: sql`excluded.type`,
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        embedding: sql`excluded.embedding`,
        metadata: sql`excluded.metadata`,
        confidence: sql`excluded.confidence`,
        scope: sql`excluded.scope`,
        provenance: sql`excluded.provenance`,
      },
    });

  return entityId;
}

async function listGuidance(guidanceType: GuidanceType) {
  const rows = await db
    .select({
      id: vibeMemories.id,
      content: vibeMemories.content,
      metadata: vibeMemories.metadata,
      createdAt: vibeMemories.createdAt,
    })
    .from(vibeMemories)
    .where(
      and(
        eq(vibeMemories.sessionId, config.guidance.sessionId),
        sql`${vibeMemories.metadata} @> ${JSON.stringify({
          kind: 'guidance',
          guidanceType,
        })}::jsonb`,
      ),
    )
    .orderBy(
      sql`COALESCE((${vibeMemories.metadata}->>'priority')::double precision, 0) DESC`,
      desc(vibeMemories.createdAt),
    );

  return rows.map((row) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      title: typeof metadata.title === 'string' ? metadata.title : 'Untitled',
      content: row.content,
      guidanceType:
        metadata.guidanceType === 'skill' || metadata.guidanceType === 'rule'
          ? metadata.guidanceType
          : guidanceType,
      scope: metadata.scope === 'always' ? 'always' : 'on_demand',
      priority:
        typeof metadata.priority === 'number' ? metadata.priority : Number(metadata.priority ?? 0),
      tags: Array.isArray(metadata.tags)
        ? metadata.tags.filter((tag) => typeof tag === 'string')
        : [],
      archiveKey: typeof metadata.archiveKey === 'string' ? metadata.archiveKey : null,
      createdAt: row.createdAt,
    };
  });
}

async function createGuidance(raw: GuidancePayload) {
  const input = normalizeGuidancePayload(raw);
  const now = new Date();
  const archiveKey = `manual:${sha256(
    `${input.guidanceType}:${input.title}:${now.toISOString()}:${input.content}`,
  )}`;
  const dedupeKey = `guidance:${sha256(`${archiveKey}:${input.title}:${input.content}`)}`;
  const embedding = await generateEmbedding(input.content);

  const [memory] = await db
    .insert(vibeMemories)
    .values({
      sessionId: config.guidance.sessionId,
      content: input.content,
      embedding,
      dedupeKey,
      metadata: {
        kind: 'guidance',
        guidanceType: input.guidanceType,
        scope: input.scope,
        priority: input.priority,
        title: input.title,
        tags: input.tags,
        archiveKey,
        updatedAt: now.toISOString(),
        source: 'monitor',
      },
    })
    .returning();

  await upsertGuidanceEntity({
    memoryId: memory.id,
    title: input.title,
    content: input.content,
    guidanceType: input.guidanceType,
    scope: input.scope,
    priority: input.priority,
    tags: input.tags,
    archiveKey,
  });

  return {
    id: memory.id,
    ...input,
    archiveKey,
    createdAt: memory.createdAt,
  };
}

async function updateGuidance(id: string, raw: GuidancePayload) {
  const existing = await db.query.vibeMemories.findFirst({
    where: eq(vibeMemories.id, id),
  });

  if (!existing) {
    throw new Error(`Guidance ${id} not found`);
  }

  const existingMetadata = (existing.metadata ?? {}) as Record<string, unknown>;
  if (existingMetadata.kind !== 'guidance') {
    throw new Error(`Memory ${id} is not guidance`);
  }

  const input = normalizeGuidancePayload({
    ...raw,
    guidanceType:
      existingMetadata.guidanceType === 'skill' || existingMetadata.guidanceType === 'rule'
        ? existingMetadata.guidanceType
        : raw.guidanceType,
  });

  const now = new Date();
  const archiveKey =
    typeof existingMetadata.archiveKey === 'string'
      ? existingMetadata.archiveKey
      : `manual:${sha256(`${input.guidanceType}:${input.title}`)}`;
  const updatedMetadata = {
    ...existingMetadata,
    kind: 'guidance',
    guidanceType: input.guidanceType,
    scope: input.scope,
    priority: input.priority,
    title: input.title,
    tags: input.tags,
    archiveKey,
    updatedAt: now.toISOString(),
    source: 'monitor',
  };
  const oldTitle =
    typeof existingMetadata.title === 'string' && existingMetadata.title.trim().length > 0
      ? existingMetadata.title
      : input.title;
  const oldEntityId = guidanceEntityId(input.guidanceType, oldTitle);
  const newEntityId = guidanceEntityId(input.guidanceType, input.title);
  const embedding = await generateEmbedding(input.content);

  await db
    .update(vibeMemories)
    .set({ content: input.content, embedding, metadata: updatedMetadata })
    .where(eq(vibeMemories.id, id));

  await upsertGuidanceEntity({
    memoryId: id,
    title: input.title,
    content: input.content,
    guidanceType: input.guidanceType,
    scope: input.scope,
    priority: input.priority,
    tags: input.tags,
    archiveKey,
  });

  if (oldEntityId !== newEntityId) {
    await db
      .delete(relations)
      .where(sql`${relations.sourceId} = ${oldEntityId} OR ${relations.targetId} = ${oldEntityId}`);
    await db.delete(entities).where(eq(entities.id, oldEntityId));
  }

  return {
    id,
    ...input,
    archiveKey,
    createdAt: existing.createdAt,
  };
}

async function deleteGuidance(id: string) {
  const existing = await db.query.vibeMemories.findFirst({
    where: eq(vibeMemories.id, id),
  });
  if (!existing) {
    throw new Error(`Guidance ${id} not found`);
  }

  const metadata = (existing.metadata ?? {}) as Record<string, unknown>;
  if (metadata.kind !== 'guidance') {
    throw new Error(`Memory ${id} is not guidance`);
  }

  const guidanceType =
    metadata.guidanceType === 'skill' || metadata.guidanceType === 'rule'
      ? metadata.guidanceType
      : 'rule';
  const title =
    typeof metadata.title === 'string' && metadata.title.trim().length > 0
      ? metadata.title
      : existing.content.slice(0, 40);
  const entityId = guidanceEntityId(guidanceType, title);

  await db.delete(vibeMemories).where(eq(vibeMemories.id, id));
  await db
    .delete(relations)
    .where(sql`${relations.sourceId} = ${entityId} OR ${relations.targetId} = ${entityId}`);
  await db.delete(entities).where(eq(entities.id, entityId));

  return { success: true, id };
}

async function listLessons() {
  const rows = await db.select().from(experienceLogs).orderBy(desc(experienceLogs.createdAt));
  return rows;
}

async function createLesson(raw: LessonPayload) {
  const input = normalizeLessonPayload(raw);
  const embedding = await generateEmbedding(input.content);

  const [lesson] = await db
    .insert(experienceLogs)
    .values({
      sessionId: input.sessionId,
      scenarioId: input.scenarioId,
      attempt: input.attempt,
      type: input.type,
      failureType: input.failureType,
      content: input.content,
      embedding,
      metadata: input.metadata,
    })
    .returning();

  return lesson;
}

async function updateLesson(id: string, raw: LessonPayload) {
  const input = normalizeLessonPayload(raw);
  const embedding = await generateEmbedding(input.content);

  const [lesson] = await db
    .update(experienceLogs)
    .set({
      sessionId: input.sessionId,
      scenarioId: input.scenarioId,
      attempt: input.attempt,
      type: input.type,
      failureType: input.failureType,
      content: input.content,
      embedding,
      metadata: input.metadata,
    })
    .where(eq(experienceLogs.id, id))
    .returning();

  if (!lesson) {
    throw new Error(`Lesson ${id} not found`);
  }

  return lesson;
}

async function deleteLesson(id: string) {
  const [lesson] = await db.delete(experienceLogs).where(eq(experienceLogs.id, id)).returning();
  if (!lesson) {
    throw new Error(`Lesson ${id} not found`);
  }
  return { success: true, id };
}

async function main() {
  const args = process.argv.slice(2);
  const resource = args[0];
  const command = args[1];

  if (resource === 'guidance') {
    if (command === 'list') {
      const guidanceType = args[2] === 'skill' ? 'skill' : 'rule';
      console.log(JSON.stringify(await listGuidance(guidanceType), null, 2));
      return;
    }

    if (command === 'create') {
      const payload = parseJsonArg<GuidancePayload>(args[2], 'guidance payload');
      console.log(JSON.stringify(await createGuidance(payload), null, 2));
      return;
    }

    if (command === 'update') {
      const id = requireString(args[2], 'guidance id');
      const payload = parseJsonArg<GuidancePayload>(args[3], 'guidance payload');
      console.log(JSON.stringify(await updateGuidance(id, payload), null, 2));
      return;
    }

    if (command === 'delete') {
      const id = requireString(args[2], 'guidance id');
      console.log(JSON.stringify(await deleteGuidance(id), null, 2));
      return;
    }
  }

  if (resource === 'lessons') {
    if (command === 'list') {
      console.log(JSON.stringify(await listLessons(), null, 2));
      return;
    }

    if (command === 'create') {
      const payload = parseJsonArg<LessonPayload>(args[2], 'lesson payload');
      console.log(JSON.stringify(await createLesson(payload), null, 2));
      return;
    }

    if (command === 'update') {
      const id = requireString(args[2], 'lesson id');
      const payload = parseJsonArg<LessonPayload>(args[3], 'lesson payload');
      console.log(JSON.stringify(await updateLesson(id, payload), null, 2));
      return;
    }

    if (command === 'delete') {
      const id = requireString(args[2], 'lesson id');
      console.log(JSON.stringify(await deleteLesson(id), null, 2));
      return;
    }
  }

  throw new Error(
    'Unknown command. Use: guidance list|create|update|delete or lessons list|create|update|delete',
  );
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
