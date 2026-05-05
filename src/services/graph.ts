import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import Graph from 'graphology';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { communities, entities, relations } from '../db/schema.js';
import { NotFoundError } from '../domain/errors.js';
import { EntityInputSchema, RelationInputSchema } from '../domain/schemas.js';
import type { EntityInput, RelationInput } from '../domain/schemas.js';
import { generateEntityId } from '../utils/entityId.js';
import { extractEntitiesFromText, judgeAndMergeEntities } from './llm.js';
import { generateEmbedding } from './memory.js';

/**
 * データベースの情報から graphology のグラフインスタンスを構築します。
 */
export async function buildGraph(database: DbClient = db) {
  const allEntities = await database.select().from(entities);
  const allRelations = await database.select().from(relations);

  const graph = new Graph();
  for (const entity of allEntities) {
    if (!graph.hasNode(entity.id)) {
      graph.addNode(entity.id, { ...entity });
    }
  }
  for (const rel of allRelations) {
    if (graph.hasNode(rel.sourceId) && graph.hasNode(rel.targetId)) {
      graph.addEdge(rel.sourceId, rel.targetId, { ...rel });
    }
  }
  return graph;
}

type DbClient = Pick<typeof db, 'insert' | 'select' | 'update' | 'delete' | 'execute'>;
type EmbeddingGenerator = (text: string) => Promise<number[]>;
type EntityMergeJudge = typeof judgeAndMergeEntities;

type SaveEntitiesDeps = {
  judgeAndMerge?: EntityMergeJudge;
};

type FindPathDeps = {
  findEntityById?: typeof findEntityById;
  searchEntityByQuery?: typeof searchEntityByQuery;
  buildGraph?: typeof buildGraph;
};

type SearchEntitiesDeps = {
  embeddingGenerator?: EmbeddingGenerator;
};

/**
 * エンティティ群を保存または更新します。
 * 保存前に意味的な類似度をチェックし、既存のエンティティと重複（類似度 > config.dedupeThreshold）している場合は
 * LLM を用いて自動的にマージ（名寄せ）を試みます。
 */
export async function saveEntities(
  rawInputs: EntityInput[],
  database: DbClient = db,
  embeddingGenerator: EmbeddingGenerator = generateEmbedding,
  deps: SaveEntitiesDeps = {},
) {
  // id がない場合は type + name から決定的に生成する
  const inputs = rawInputs.map((raw) => {
    const parsed = EntityInputSchema.parse(raw);
    const id = parsed.id ?? generateEntityId(parsed.type, parsed.name);
    return { ...parsed, id };
  });
  if (inputs.length === 0) return;

  const processedInputs: Array<{
    id: string;
    type: string;
    name: string;
    description?: string;
    metadata?: Record<string, unknown>;
    embedding: number[];
    confidence?: number;
    provenance?: string;
    scope?: string;
    freshness?: Date;
  }> = [];

  for (const input of inputs) {
    const textToEmbed = `${input.name} ${input.description || ''}`.trim();
    const vector = await embeddingGenerator(textToEmbed);
    const embeddingStr = JSON.stringify(vector);
    const similarity = sql<number>`1 - (${entities.embedding} <=> ${embeddingStr}::vector)`;

    // 類似エンティティの検索
    const [similar] = await database
      .select({
        id: entities.id,
        name: entities.name,
        type: entities.type,
        description: entities.description,
        similarity,
      })
      .from(entities)
      .where(sql`${entities.id} != ${input.id} AND ${entities.embedding} IS NOT NULL`)
      .orderBy(desc(similarity))
      .limit(1);

    let finalInput = { ...input, embedding: vector };

    if (similar && similar.similarity > config.graph.similarityThreshold) {
      console.info(
        `[Deduplication] High similarity detected: "${input.name}" vs "${
          similar.name
        }" (${similar.similarity.toFixed(3)})`,
      );

      const mergeJudge = deps.judgeAndMerge ?? judgeAndMergeEntities;
      // LLM による同一性判定とマージ
      const decision = await mergeJudge(
        { name: input.name, type: input.type, description: input.description || '' },
        { name: similar.name, type: similar.type, description: similar.description || '' },
      );

      if (decision.shouldMerge && decision.merged) {
        console.info(
          `[Deduplication] Merging "${input.name}" into existing entity "${similar.name}"`,
        );

        // 既存の ID を使用して上書き（マージ後の情報に更新）
        const mergedText = `${decision.merged.name} ${decision.merged.description}`;
        const mergedEmbedding = await embeddingGenerator(mergedText);

        finalInput = {
          ...input,
          id: similar.id, // 既存の ID を継承
          name: decision.merged.name,
          type: decision.merged.type,
          description: decision.merged.description,
          embedding: mergedEmbedding,
          metadata: {
            ...(input.metadata || {}),
            mergedFrom: [input.id, similar.id],
            autoMergedAt: new Date().toISOString(),
          },
        };
      }
    }
    processedInputs.push(finalInput);
  }

  if (processedInputs.length === 0) return;

  await database
    .insert(entities)
    .values(processedInputs)
    .onConflictDoUpdate({
      target: entities.id,
      set: {
        type: sql`excluded.type`,
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        embedding: sql`excluded.embedding`,
        metadata: sql`excluded.metadata`,
        confidence: sql`COALESCE(excluded.confidence, ${entities.confidence})`,
        scope: sql`COALESCE(excluded.scope, ${entities.scope})`,
        provenance: sql`COALESCE(excluded.provenance, ${entities.provenance})`,
        freshness: sql`COALESCE(excluded.freshness, ${entities.freshness})`,
      },
    });
}

/**
 * リレーションを保存します。
 * `sourceId`/`targetId` 形式（既存）と `sourceType/sourceName`/`targetType/targetName` 形式の両方を受け付けます。
 */
export async function saveRelations(rawInputs: RelationInput[], database: DbClient = db) {
  const inputs = rawInputs.map((raw) => {
    const parsed = RelationInputSchema.parse(raw);
    // name ベース形式を id ベースに変換
    if ('sourceName' in parsed) {
      return {
        sourceId: generateEntityId(parsed.sourceType, parsed.sourceName),
        targetId: generateEntityId(parsed.targetType, parsed.targetName),
        relationType: parsed.relationType,
        weight: parsed.weight,
      };
    }
    return parsed;
  });
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
export async function queryGraphContext(
  entityId: string,
  maxDepth = 2,
  maxNodes = 20,
  database: DbClient = db,
) {
  const visited = new Set<string>();
  const queue: { id: string; depth: number }[] = [{ id: entityId, depth: 0 }];
  const resultEntities: (typeof entities.$inferSelect)[] = [];
  const resultRelations: (typeof relations.$inferSelect)[] = [];
  let communitySummary: (typeof communities.$inferSelect)[] = [];
  const dbClient = database as typeof db; // casting for full functionality if needed

  // 起点エンティティの取得とコミュニティ情報の確認
  const [startEntity] = await dbClient.select().from(entities).where(eq(entities.id, entityId));
  if (!startEntity) return { entities: [], relations: [], communities: [] };

  if (startEntity.communityId) {
    communitySummary = await dbClient
      .select()
      .from(communities)
      .where(eq(communities.id, startEntity.communityId));
  }

  while (queue.length > 0 && visited.size < maxNodes) {
    const current = queue.shift();
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);

    // エンティティ情報の取得
    const [entity] = await dbClient.select().from(entities).where(eq(entities.id, current.id));
    if (entity) resultEntities.push(entity);

    if (current.depth >= maxDepth) continue;

    // 隣接ノードとリレーションの取得
    const outgoing = await dbClient
      .select()
      .from(relations)
      .where(eq(relations.sourceId, current.id));
    const incoming = await dbClient
      .select()
      .from(relations)
      .where(eq(relations.targetId, current.id));

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

  if (resultEntities.length > 0) {
    const entityIds = resultEntities.map((e) => e.id);
    await dbClient
      .update(entities)
      .set({
        referenceCount: sql`${entities.referenceCount} + 1`,
        lastReferencedAt: new Date(),
      })
      .where(inArray(entities.id, entityIds));
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
  const embedding = await generateEmbedding(query, { type: 'query', priority: 'high' });
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
  database: Pick<typeof db, 'select' | 'update'> = db,
  deps: SearchEntitiesDeps = {},
) {
  const embedding =
    deps.embeddingGenerator !== undefined
      ? await deps.embeddingGenerator(query)
      : await generateEmbedding(query, { type: 'query', priority: 'high' });
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

  if (results.length > 0) {
    const entityIds = results.map((r) => r.id);
    await database
      .update(entities)
      .set({
        referenceCount: sql`${entities.referenceCount} + 1`,
        lastReferencedAt: new Date(),
      })
      .where(inArray(entities.id, entityIds));
  }

  return results;
}

type DigestDeps = {
  extractor?: (text: string) => Promise<EntityInput[]>;
  searcher?: (
    query: string,
    limit: number,
  ) => Promise<Awaited<ReturnType<typeof searchEntitiesByText>>>;
};

/**
 * テキストからエンティティを抽出し、既存のグラフデータと紐付けて返します (高度な Digestion)
 */
export async function digestTextIntelligence(
  text: string,
  limit = 5,
  similarityThreshold = config.graph.similarityThreshold,
  deps: DigestDeps = {},
) {
  const extractor = deps.extractor ?? extractEntitiesFromText;
  const searcher = deps.searcher ?? ((q, l) => searchEntitiesByText(q, l));

  // 1. LLM でエンティティを抽出
  const extracted = await extractor(text);
  const extractedLimited = extracted.slice(0, limit);

  // 2. 抽出された各エンティティについて既存ノードを探す
  const results = await Promise.all(
    extractedLimited.map(async (ext) => {
      // 名前と説明をセットにして検索クエリにする
      const query = `${ext.name} ${ext.description}`;
      const candidates = await searcher(query, limit);

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
export async function updateEntity(
  id: string,
  updates: Partial<Omit<EntityInput, 'id'>>,
  database: DbClient = db,
) {
  await database.update(entities).set(updates).where(eq(entities.id, id));
}

/**
 * 古い・誤ったリレーションを削除します
 */
export async function deleteRelation(
  sourceId: string,
  targetId: string,
  relationType: string,
  database: DbClient = db,
) {
  await database
    .delete(relations)
    .where(
      and(
        eq(relations.sourceId, sourceId),
        eq(relations.targetId, targetId),
        eq(relations.relationType, relationType),
      ),
    );
}

/**
 * 2つのエンティティ間のつながり（最短経路）を探索します。
 * 入力が文字列の場合は、ベクトル検索で最適なエンティティを特定してから探索を開始します。
 */
export async function findPathBetweenEntities(
  queryA: string,
  queryB: string,
  database: DbClient = db,
  deps: FindPathDeps = {},
) {
  const findById = deps.findEntityById ?? findEntityById;
  const searchByQuery = deps.searchEntityByQuery ?? searchEntityByQuery;
  const buildGraphFromDb = deps.buildGraph ?? buildGraph;

  const idA = await findById(queryA, database).then(
    async (id) => id || (await searchByQuery(queryA, database)),
  );
  const idB = await findById(queryB, database).then(
    async (id) => id || (await searchByQuery(queryB, database)),
  );

  if (!idA || !idB) {
    throw new NotFoundError('entity', `queryA="${queryA}" or queryB="${queryB}"`);
  }

  if (idA === idB) {
    const [e] = await database.select().from(entities).where(eq(entities.id, idA));
    return { entities: [e], relations: [] };
  }

  const graph = await buildGraphFromDb(database);
  const maxHops = config.maxPathHops;

  // BFS による最短経路探索
  const queue: { id: string; path: string[]; relations: (typeof relations.$inferSelect)[] }[] = [
    { id: idA, path: [idA], relations: [] },
  ];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    if (current.path.length > maxHops) continue;

    if (current.id === idB) {
      // 経路上のエンティティ詳細を取得
      const entitiesInPath = await database
        .select()
        .from(entities)
        .where(inArray(entities.id, current.path));

      // 順序を保つためにソート
      const sortedEntities = current.path
        .map((id) => entitiesInPath.find((e) => e.id === id))
        .filter((e): e is typeof entities.$inferSelect => !!e);

      return {
        entities: sortedEntities,
        relations: current.relations,
      };
    }

    visited.add(current.id);

    // 隣接ノードを取得
    const neighbors = graph.neighbors(current.id);
    for (const neighborId of neighbors) {
      if (!visited.has(neighborId)) {
        const edge = graph.edge(current.id, neighborId);
        const edgeData = graph.getEdgeAttributes(edge);
        queue.push({
          id: neighborId,
          path: [...current.path, neighborId],
          relations: [...current.relations, edgeData as typeof relations.$inferSelect],
        });
      }
    }
  }

  return { message: 'No path found within the allowed number of hops.', maxHops };
}
