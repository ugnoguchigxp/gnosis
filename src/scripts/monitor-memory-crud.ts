import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { closeDbPool, db } from '../db/index.js';
import { entities, experienceLogs, relations, vibeMemories } from '../db/schema.js';
import { generateEmbedding } from '../services/memory.js';
import { sha256 } from '../utils/crypto.js';
import { generateEntityId } from '../utils/entityId.js';

type EntityPayload = {
  id?: string;
  type: string;
  name: string;
  description?: string;
  confidence?: number;
  scope?: string;
  metadata?: Record<string, unknown>;
  provenance?: string | null;
  freshness?: string | null;
};

type RelationPayload = {
  sourceId: string;
  targetId: string;
  relationType: string;
  weight?: number;
};

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

type EntityRow = typeof entities.$inferSelect;

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

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function metadataStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item, index, values) => item.length > 0 && values.indexOf(item) === index);
}

function createdAtTime(value: Date | string): number {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function mapEntityLesson(entity: EntityRow) {
  const metadata = metadataRecord(entity.metadata);

  return {
    id: entity.id,
    sessionId: metadataString(metadata, 'taskId') ?? entity.provenance ?? 'knowledge-graph',
    scenarioId:
      metadataString(metadata, 'category') ??
      metadataString(metadata, 'slug') ??
      metadataString(metadata, 'purpose') ??
      entity.type,
    attempt: 1,
    type: 'success' as LessonType,
    failureType: null,
    content: entity.description ?? entity.name,
    metadata: {
      ...metadata,
      entityId: entity.id,
      entityType: entity.type,
      displaySource: 'entities',
    },
    createdAt: entity.createdAt,
    source: 'entity' as const,
    readOnly: false,
  };
}

function mapEntityGuidance(entity: EntityRow, guidanceType: GuidanceType) {
  const metadata = metadataRecord(entity.metadata);
  const priority = metadataNumber(metadata, 'priority');

  return {
    id: entity.id,
    title: entity.name,
    content: entity.description ?? '',
    guidanceType,
    scope: entity.scope === 'always' ? 'always' : ('on_demand' as GuidanceScope),
    priority:
      priority !== undefined
        ? Math.max(0, Math.min(100, Math.trunc(priority)))
        : Math.max(0, Math.min(100, Math.round((entity.confidence ?? 0.5) * 100))),
    tags: metadataStringArray(metadata, 'tags'),
    archiveKey: metadataString(metadata, 'archiveKey') ?? null,
    createdAt: entity.createdAt,
    source: 'entity' as const,
    readOnly: false,
    entityType: entity.type,
  };
}

function guidanceTypeFromEntityType(entityType: string): GuidanceType | null {
  if (entityType === 'rule' || entityType === 'constraint') return 'rule';
  if (['procedure', 'skill', 'command_recipe', 'task'].includes(entityType)) return 'skill';
  return null;
}

async function deleteEntityWithRelations(id: string) {
  await db
    .delete(relations)
    .where(sql`${relations.sourceId} = ${id} OR ${relations.targetId} = ${id}`);
  const [deleted] = await db.delete(entities).where(eq(entities.id, id)).returning();
  return deleted;
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

  const guidanceRows = rows.map((row) => {
    const metadata = metadataRecord(row.metadata);
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
      source: 'guidance' as const,
      readOnly: false,
    };
  });

  const guidanceMemoryIds = new Set(guidanceRows.map((row) => row.id));
  const entityRows = await db
    .select()
    .from(entities)
    .where(
      guidanceType === 'rule'
        ? sql`${entities.type} = 'rule' OR (${entities.type} = 'constraint' AND (${entities.metadata}->>'guidanceMemoryId' IS NOT NULL OR ${entities.metadata}->>'guidanceType' = 'rule'))`
        : sql`${entities.type} IN ('procedure', 'skill', 'command_recipe') OR (${entities.type} = 'task' AND (${entities.metadata}->>'guidanceMemoryId' IS NOT NULL OR ${entities.metadata}->>'guidanceType' = 'skill'))`,
    )
    .orderBy(desc(entities.createdAt));

  const entityGuidanceRows = entityRows
    .filter((entity) => {
      const metadata = metadataRecord(entity.metadata);
      const guidanceMemoryId = metadataString(metadata, 'guidanceMemoryId');
      return !guidanceMemoryId || !guidanceMemoryIds.has(guidanceMemoryId);
    })
    .map((entity) => mapEntityGuidance(entity, guidanceType));

  return [...guidanceRows, ...entityGuidanceRows].sort((a, b) => {
    const priorityDelta = b.priority - a.priority;
    if (priorityDelta !== 0) return priorityDelta;
    return createdAtTime(b.createdAt) - createdAtTime(a.createdAt);
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
  const existing = isUuid(id)
    ? await db.query.vibeMemories.findFirst({
        where: eq(vibeMemories.id, id),
      })
    : null;

  if (!existing) {
    return await updateEntityGuidance(id, raw);
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
    source: 'guidance' as const,
    readOnly: false,
  };
}

async function updateEntityGuidance(id: string, raw: GuidancePayload) {
  const existing = await db.query.entities.findFirst({
    where: eq(entities.id, id),
  });
  if (!existing) {
    throw new Error(`Guidance ${id} not found`);
  }

  const existingGuidanceType = guidanceTypeFromEntityType(existing.type);
  if (!existingGuidanceType) {
    throw new Error(`Entity ${id} is not guidance`);
  }

  const input = normalizeGuidancePayload({
    ...raw,
    guidanceType: existingGuidanceType,
  });
  const metadata = metadataRecord(existing.metadata);
  const embedding = await generateEmbedding(`${input.title}\n${input.content}`);

  const [entity] = await db
    .update(entities)
    .set({
      name: input.title,
      description: input.content,
      embedding,
      metadata: {
        ...metadata,
        guidanceType: input.guidanceType,
        scope: input.scope,
        priority: input.priority,
        tags: input.tags,
        updatedFrom: 'monitor',
        updatedAt: new Date().toISOString(),
      },
      scope: input.scope,
      provenance: existing.provenance ?? 'monitor',
    })
    .where(eq(entities.id, id))
    .returning();

  return mapEntityGuidance(entity, input.guidanceType);
}

async function deleteGuidance(id: string) {
  const existing = isUuid(id)
    ? await db.query.vibeMemories.findFirst({
        where: eq(vibeMemories.id, id),
      })
    : null;
  if (!existing) {
    const entity = await db.query.entities.findFirst({
      where: eq(entities.id, id),
    });
    if (!entity || !guidanceTypeFromEntityType(entity.type)) {
      throw new Error(`Guidance ${id} not found`);
    }
    await deleteEntityWithRelations(id);
    return { success: true, id };
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
  await deleteEntityWithRelations(entityId);

  return { success: true, id };
}

async function listLessons() {
  const rows = await db.select().from(experienceLogs).orderBy(desc(experienceLogs.createdAt));
  const entityRows = await db
    .select()
    .from(entities)
    .where(inArray(entities.type, ['lesson']))
    .orderBy(desc(entities.createdAt));

  return [
    ...rows.map((row) => ({
      ...row,
      source: 'experience' as const,
      readOnly: false,
    })),
    ...entityRows.map(mapEntityLesson),
  ].sort((a, b) => createdAtTime(b.createdAt) - createdAtTime(a.createdAt));
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

  const [lesson] = isUuid(id)
    ? await db
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
        .returning()
    : [];

  if (lesson) {
    return {
      ...lesson,
      source: 'experience' as const,
      readOnly: false,
    };
  }

  return await updateEntityLesson(id, input, embedding);
}

async function updateEntityLesson(id: string, input: Required<LessonPayload>, embedding: number[]) {
  const existing = await db.query.entities.findFirst({
    where: and(eq(entities.id, id), eq(entities.type, 'lesson')),
  });
  if (!existing) {
    throw new Error(`Lesson ${id} not found`);
  }

  const metadata = metadataRecord(existing.metadata);
  const [entity] = await db
    .update(entities)
    .set({
      description: input.content,
      embedding,
      metadata: {
        ...metadata,
        taskId: input.sessionId,
        category: input.scenarioId,
        attempt: input.attempt,
        lessonType: input.type,
        failureType: input.failureType,
        updatedFrom: 'monitor',
        updatedAt: new Date().toISOString(),
      },
      provenance: existing.provenance ?? 'monitor',
    })
    .where(eq(entities.id, id))
    .returning();

  return mapEntityLesson(entity);
}

async function deleteLesson(id: string) {
  const [lesson] = isUuid(id)
    ? await db.delete(experienceLogs).where(eq(experienceLogs.id, id)).returning()
    : [];
  if (lesson) {
    return { success: true, id };
  }

  const entity = await db.query.entities.findFirst({
    where: and(eq(entities.id, id), eq(entities.type, 'lesson')),
  });
  if (!entity) {
    throw new Error(`Lesson ${id} not found`);
  }

  await deleteEntityWithRelations(id);
  return { success: true, id };
}

// --- Entities CRUD ---

async function listEntities() {
  return await db.select().from(entities).orderBy(desc(entities.createdAt)).limit(200);
}

async function createEntity(raw: EntityPayload) {
  const type = requireString(raw.type, 'type');
  const name = requireString(raw.name, 'name');
  const id = raw.id || generateEntityId(type, name);
  const description = raw.description || '';
  const freshness =
    typeof raw.freshness === 'string' && raw.freshness.trim().length > 0
      ? new Date(raw.freshness)
      : null;
  const normalizedFreshness =
    freshness && Number.isFinite(freshness.getTime()) ? freshness : undefined;
  const embedding = await generateEmbedding(`${name}\n${description}`);

  const [entity] = await db
    .insert(entities)
    .values({
      id,
      type,
      name,
      description,
      embedding,
      confidence: raw.confidence ?? 0.5,
      scope: raw.scope || 'on_demand',
      metadata: raw.metadata || {},
      provenance: raw.provenance ?? 'monitor',
      freshness: normalizedFreshness,
    })
    .returning();
  return entity;
}

async function updateEntity(id: string, raw: EntityPayload) {
  const existing = await db.query.entities.findFirst({
    where: eq(entities.id, id),
  });
  if (!existing) {
    throw new Error(`Entity ${id} not found`);
  }

  const name = raw.name || existing.name;
  const type = raw.type || existing.type;
  const expectedId = generateEntityId(type, name);
  if (expectedId !== id) {
    throw new Error(
      `Renaming or changing type would require rekeying entity ID from ${id} to ${expectedId}. Recreate the entity instead.`,
    );
  }

  const description = raw.description ?? existing.description ?? '';
  const freshness =
    typeof raw.freshness === 'string' && raw.freshness.trim().length > 0
      ? new Date(raw.freshness)
      : null;
  const normalizedFreshness =
    freshness && Number.isFinite(freshness.getTime()) ? freshness : existing.freshness;
  const embedding = await generateEmbedding(`${name}\n${description}`);

  const [entity] = await db
    .update(entities)
    .set({
      type,
      name,
      description,
      embedding,
      confidence: raw.confidence ?? existing.confidence,
      scope: raw.scope || existing.scope,
      metadata: raw.metadata || existing.metadata,
      provenance: raw.provenance ?? existing.provenance ?? 'monitor',
      freshness: normalizedFreshness,
    })
    .where(eq(entities.id, id))
    .returning();
  return entity;
}

async function deleteEntity(id: string) {
  // カスケード削除（リレーションも道連れにする）
  const deleted = await deleteEntityWithRelations(id);
  if (!deleted) {
    throw new Error(`Entity ${id} not found`);
  }
  return { success: true, id };
}

// --- Relations CRUD ---

async function listRelations() {
  return await db.select().from(relations).limit(5000);
}

async function createRelation(raw: RelationPayload) {
  const sourceId = requireString(raw.sourceId, 'sourceId');
  const targetId = requireString(raw.targetId, 'targetId');
  const relationType = requireString(raw.relationType, 'relationType');

  const [relation] = await db
    .insert(relations)
    .values({
      sourceId,
      targetId,
      relationType,
      weight: raw.weight ?? 1.0,
    })
    .onConflictDoUpdate({
      target: [relations.sourceId, relations.targetId, relations.relationType],
      set: {
        weight: raw.weight ?? 1.0,
      },
    })
    .returning();
  return relation;
}

async function deleteRelation(sourceId: string, targetId: string, type: string) {
  const [deleted] = await db
    .delete(relations)
    .where(
      and(
        eq(relations.sourceId, sourceId),
        eq(relations.targetId, targetId),
        eq(relations.relationType, type),
      ),
    )
    .returning();
  if (!deleted) {
    throw new Error('Relation not found');
  }
  return { success: true };
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

  if (resource === 'entities') {
    if (command === 'list') {
      console.log(JSON.stringify(await listEntities(), null, 2));
      return;
    }
    if (command === 'create') {
      const payload = parseJsonArg<EntityPayload>(args[2], 'entity payload');
      console.log(JSON.stringify(await createEntity(payload), null, 2));
      return;
    }
    if (command === 'update') {
      const id = requireString(args[2], 'entity id');
      const payload = parseJsonArg<EntityPayload>(args[3], 'entity payload');
      console.log(JSON.stringify(await updateEntity(id, payload), null, 2));
      return;
    }
    if (command === 'delete') {
      const id = requireString(args[2], 'entity id');
      console.log(JSON.stringify(await deleteEntity(id), null, 2));
      return;
    }
  }

  if (resource === 'relations') {
    if (command === 'list') {
      console.log(JSON.stringify(await listRelations(), null, 2));
      return;
    }
    if (command === 'create') {
      const payload = parseJsonArg<RelationPayload>(args[2], 'relation payload');
      console.log(JSON.stringify(await createRelation(payload), null, 2));
      return;
    }
    if (command === 'delete') {
      const sourceId = requireString(args[2], 'sourceId');
      const targetId = requireString(args[3], 'targetId');
      const type = requireString(args[4], 'type');
      console.log(JSON.stringify(await deleteRelation(sourceId, targetId, type), null, 2));
      return;
    }
  }

  throw new Error(
    'Unknown command. Use: guidance list|create|update|delete, lessons list|create|update|delete, entities list|create|update|delete, or relations list|create|delete',
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
