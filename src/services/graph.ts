import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { entities, relations } from '../db/schema.js';
import { generateEmbedding } from './memory.js';

type DbClient = Pick<typeof db, 'insert' | 'select' | 'update' | 'delete' | 'execute'>;

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
export async function saveEntities(inputs: EntityInput[], database: DbClient = db) {
  if (inputs.length === 0) return;
  const inputsWithVector = await Promise.all(
    inputs.map(async (input) => {
      const textToEmbed = `${input.name} ${input.description || ''}`.trim();
      const vector = await generateEmbedding(textToEmbed);
      return { ...input, embedding: vector };
    }),
  );

  await database
    .insert(entities)
    .values(inputsWithVector)
    .onConflictDoUpdate({
      target: entities.id,
      set: {
        type: sql`excluded.type`,
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        embedding: sql`excluded.embedding`,
        metadata: sql`excluded.metadata`,
      },
    });
}

/**
 * リレーションを保存します
 */
export async function saveRelations(inputs: RelationInput[], database: DbClient = db) {
  if (inputs.length === 0) return;
  for (const input of inputs) {
    await database.execute(sql`
      insert into relations (source_id, target_id, relation_type, weight)
      select ${input.sourceId}, ${input.targetId}, ${input.relationType}, ${input.weight ?? null}
      where not exists (
        select 1
        from relations
        where source_id = ${input.sourceId}
          and target_id = ${input.targetId}
          and relation_type = ${input.relationType}
      )
    `);
  }
}

/**
 * 指定のエンティティを中心とした、最大「多段ホップ」までのグラフコンテキストを返します。
 * (BFSによる再帰探索)
 */
export async function queryGraphContext(
  entityId: string,
  maxDepth = 2,
  maxNodes = 20,
  database: DbClient = db,
) {
  const visited = new Set<string>();
  const nodesContext = [];
  const queue = [{ id: entityId, depth: 0 }];

  while (queue.length > 0 && nodesContext.length < maxNodes) {
    const current = queue.shift();
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);

    // 出ていくリレーション
    const outgoing = await database
      .select({ relation: relations, target: entities })
      .from(relations)
      .where(eq(relations.sourceId, current.id))
      .innerJoin(entities, eq(relations.targetId, entities.id))
      .limit(maxNodes);

    // 入ってくるリレーション
    const incoming = await database
      .select({ relation: relations, source: entities })
      .from(relations)
      .where(eq(relations.targetId, current.id))
      .innerJoin(entities, eq(relations.sourceId, entities.id))
      .limit(maxNodes);

    nodesContext.push({
      entityId: current.id,
      outgoing: outgoing.map((o) => ({ relation: o.relation.relationType, target: o.target })),
      incoming: incoming.map((r) => ({ relation: r.relation.relationType, source: r.source })),
    });

    if (current.depth < maxDepth) {
      for (const edge of outgoing) {
        if (!visited.has(edge.target.id))
          queue.push({ id: edge.target.id, depth: current.depth + 1 });
      }
      for (const edge of incoming) {
        if (!visited.has(edge.source.id))
          queue.push({ id: edge.source.id, depth: current.depth + 1 });
      }
    }
  }

  return nodesContext;
}

/**
 * 検索クエリ（自然言語）から最も近いエンティティを一つ見つけてそのIDを返します
 */
export async function searchEntityByQuery(
  query: string,
  database: Pick<typeof db, 'select'> = db,
): Promise<string | null> {
  const embedding = await generateEmbedding(query);
  const embeddingStr = JSON.stringify(embedding);

  const similarity = sql`1 - (${entities.embedding} <=> ${embeddingStr}::vector)`;

  const results = await database
    .select({ id: entities.id, similarity })
    .from(entities)
    // biome-ignore lint/suspicious/noExplicitAny: drizzle helper
    .orderBy((fields: any) => sql`${fields.similarity} DESC`)
    .limit(1);

  return results.length > 0 ? results[0].id : null;
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
