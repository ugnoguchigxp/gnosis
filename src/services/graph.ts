import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { communities, entities, relations } from '../db/schema.js';
import { extractEntitiesFromText } from './llm.js';
import { generateEmbedding } from './memory.js';

type DbClient = Pick<typeof db, 'insert' | 'select' | 'update' | 'delete' | 'execute'>;
type EmbeddingGenerator = (text: string) => Promise<number[]>;

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
  weight?: number | string;
}

/**
 * エンティティ群を保存または更新します。
 * 保存前に意味的な類似度をチェックし、既存のエンティティと重複（類似度 > 0.94）している場合は警告をログ出力します。
 */
export async function saveEntities(
  inputs: EntityInput[],
  database: DbClient = db,
  embeddingGenerator: EmbeddingGenerator = generateEmbedding,
) {
  if (inputs.length === 0) return;

  const inputsWithVector = await Promise.all(
    inputs.map(async (input) => {
      const textToEmbed = `${input.name} ${input.description || ''}`.trim();
      const vector = await embeddingGenerator(textToEmbed);
      return { ...input, embedding: vector };
    }),
  );

  // 類似エンティティのチェック (重複排除のヒント)
  for (const input of inputsWithVector) {
    const embeddingStr = JSON.stringify(input.embedding);
    const similarity = sql<number>`1 - (${entities.embedding} <=> ${embeddingStr}::vector)`;

    const [similar] = await database
      .select({ id: entities.id, name: entities.name, similarity })
      .from(entities)
      .where(sql`${entities.id} != ${input.id} AND ${entities.embedding} IS NOT NULL`) // 自分自身は除外
      .orderBy(desc(similarity))
      .limit(1);

    if (similar && similar.similarity > 0.94) {
      console.warn(
        `[Deduplication Hint] New entity "${input.name}" (${
          input.id
        }) is highly similar to existing entity "${similar.name}" (${
          similar.id
        }) (Similarity: ${similar.similarity.toFixed(3)}). Consider merging them.`,
      );
    }
  }

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
    const numericWeight =
      input.weight === undefined
        ? null
        : typeof input.weight === 'number'
          ? input.weight
          : Number(input.weight);

    await database.execute(sql`
      insert into relations (source_id, target_id, relation_type, weight)
      select ${input.sourceId}, ${input.targetId}, ${input.relationType}, ${
        Number.isFinite(numericWeight) ? numericWeight : null
      }
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
 * 指定されたエンティティを中心とした、周辺のグラフ構造（知識コンテキスト）を取得します
 * 階層関係 (is_a, part_of) と、所属するコミュニティの要約を含めます。
 */
export async function queryGraphContext(entityId: string, maxDepth = 2, maxNodes = 20) {
  const visited = new Set<string>();
  const queue: { id: string; depth: number }[] = [{ id: entityId, depth: 0 }];
  const resultEntities: (typeof entities.$inferSelect)[] = [];
  const resultRelations: (typeof relations.$inferSelect)[] = [];
  let communitySummary: (typeof communities.$inferSelect)[] = [];

  // 起点エンティティの取得とコミュニティ情報の確認
  const [startEntity] = await db.select().from(entities).where(eq(entities.id, entityId));
  if (!startEntity) return { entities: [], relations: [], communities: [] };

  if (startEntity.communityId) {
    communitySummary = await db
      .select()
      .from(communities)
      .where(eq(communities.id, startEntity.communityId));
  }

  while (queue.length > 0 && visited.size < maxNodes) {
    const current = queue.shift();
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);

    // エンティティ情報の取得
    const [entity] = await db.select().from(entities).where(eq(entities.id, current.id));
    if (entity) resultEntities.push(entity);

    if (current.depth >= maxDepth) continue;

    // 隣接ノードとリレーションの取得
    const outgoing = await db.select().from(relations).where(eq(relations.sourceId, current.id));
    const incoming = await db.select().from(relations).where(eq(relations.targetId, current.id));

    for (const rel of [...outgoing, ...incoming]) {
      if (!resultRelations.find((r) => r.id === rel.id)) {
        resultRelations.push(rel);
      }
      const nextId = rel.sourceId === current.id ? rel.targetId : rel.sourceId;
      if (!visited.has(nextId)) {
        queue.push({ id: nextId, depth: current.depth + 1 });
      }
    }
  }

  return {
    entities: resultEntities,
    relations: resultRelations,
    communities: communitySummary,
  };
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
    .where(sql`${entities.embedding} IS NOT NULL`)
    // biome-ignore lint/suspicious/noExplicitAny: drizzle helper
    .orderBy((fields: any) => sql`${fields.similarity} DESC`)
    .limit(1);

  return results.length > 0 ? results[0].id : null;
}

/**
 * ID 完全一致でエンティティを探して存在確認します
 */
export async function findEntityById(
  entityId: string,
  database: Pick<typeof db, 'select'> = db,
): Promise<string | null> {
  const [entity] = await database
    .select({ id: entities.id })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);

  return entity?.id ?? null;
}

/**
 * 検索クエリ（自然言語）から関連する複数のエンティティ候補を返します (digest_text用)
 */
export async function searchEntitiesByText(
  query: string,
  limit = 5,
  database: Pick<typeof db, 'select'> = db,
) {
  const embedding = await generateEmbedding(query);
  const embeddingStr = JSON.stringify(embedding);

  const similarity = sql<number>`1 - (${entities.embedding} <=> ${embeddingStr}::vector)`;

  const results = await database
    .select({
      id: entities.id,
      name: entities.name,
      type: entities.type,
      description: entities.description,
      similarity,
    })
    .from(entities)
    .where(sql`${entities.embedding} IS NOT NULL`)
    .orderBy((fields) => desc(fields.similarity))
    .limit(limit);

  return results;
}

/**
 * テキストからエンティティを抽出し、既存のグラフデータと紐付けて返します (高度な Digestion)
 */
export async function digestTextIntelligence(text: string, limit = 5, similarityThreshold = 0.8) {
  // 1. LLM でエンティティを抽出
  const extracted = await extractEntitiesFromText(text);
  const extractedLimited = extracted.slice(0, limit);

  // 2. 抽出された各エンティティについて既存ノードを探す
  const results = await Promise.all(
    extractedLimited.map(async (ext) => {
      // 名前と説明をセットにして検索クエリにする
      const query = `${ext.name} ${ext.description}`;
      const candidates = await searchEntitiesByText(query, limit);

      return {
        extracted: ext,
        existingCandidates: candidates
          .filter((c) => c.similarity > similarityThreshold)
          .slice(0, limit),
      };
    }),
  );

  return results;
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
