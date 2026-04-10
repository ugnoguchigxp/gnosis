import { db } from '../db/index.js';
import { entities, relations } from '../db/schema.js';
import { eq, or, and, sql } from 'drizzle-orm';

export interface EntityInput {
  id: string;
  type: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface RelationInput {
  sourceId: string;
  targetId: string;
  relationType: string;
  weight?: string;
}

/**
 * エンティティ群を保存または更新します
 */
export async function saveEntities(inputs: EntityInput[]) {
  if (inputs.length === 0) return;
  await db
    .insert(entities)
    .values(inputs)
    .onConflictDoUpdate({
      target: entities.id,
      set: {
        type: sql`excluded.type`,
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        metadata: sql`excluded.metadata`,
      },
    });
}

/**
 * リレーションを保存します
 */
export async function saveRelations(inputs: RelationInput[]) {
  if (inputs.length === 0) return;
  await db.insert(relations).values(inputs);
}

/**
 * 特定のエンティティに関連する1ホップのグラフコンテキストを取得します
 */
export async function queryGraphContext(entityId: string) {
  // 出ていくリレーションとその先のエンティティ
  const outgoing = await db
    .select({
      relation: relations,
      target: entities,
    })
    .from(relations)
    .where(eq(relations.sourceId, entityId))
    .innerJoin(entities, eq(relations.targetId, entities.id));

  // 入ってくるリレーションとその元のエンティティ
  const incoming = await db
    .select({
      relation: relations,
      source: entities,
    })
    .from(relations)
    .where(eq(relations.targetId, entityId))
    .innerJoin(entities, eq(relations.sourceId, entities.id));

  return {
    entityId,
    outgoing: outgoing.map((o) => ({ relation: o.relation.relationType, target: o.target })),
    incoming: incoming.map((r) => ({ relation: r.relation.relationType, source: r.source })),
  };
}

/**
 * 既存のエンティティ情報を部分更新します
 */
export async function updateEntity(id: string, updates: Partial<Omit<EntityInput, 'id'>>) {
  await db.update(entities).set(updates).where(eq(entities.id, id));
}

/**
 * 古い・誤ったリレーションを削除します
 */
export async function deleteRelation(sourceId: string, targetId: string, relationType: string) {
  await db
    .delete(relations)
    .where(
      and(
        eq(relations.sourceId, sourceId),
        eq(relations.targetId, targetId),
        eq(relations.relationType, relationType),
      ),
    );
}
