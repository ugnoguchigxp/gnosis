import { inArray } from 'drizzle-orm';
import louvain from 'graphology-communities-louvain';
import { db } from '../db/index.js';
import { communities, entities, type relations } from '../db/schema.js';
import { CommunityRebuildResultSchema } from '../domain/schemas.js';
import type { CommunityRebuildResult } from '../domain/schemas.js';
import { buildGraph } from './graph.js';
import { summarizeCommunity } from './llm.js';

type DbClient = Pick<typeof db, 'delete' | 'insert' | 'update'>;

export type BuildCommunitiesDeps = {
  database?: DbClient;
  graphBuilder?: () => ReturnType<typeof buildGraph>;
  summarize?: (context: string) => Promise<{ name: string; summary: string }>;
  logger?: (message: string) => void;
};

/**
 * グラフ全体をスキャンし、コミュニティ（知識の塊）を再構築します。
 */
export async function buildCommunities(
  deps: BuildCommunitiesDeps = {},
): Promise<CommunityRebuildResult | { message: string }> {
  const database = deps.database ?? db;
  const graphBuilder = deps.graphBuilder ?? buildGraph;
  const summarize = deps.summarize ?? summarizeCommunity;
  const logger = deps.logger ?? ((msg: string) => console.log(msg));

  logger('Starting community detection...');

  // 1. グラフの構築 (共通関数を使用)
  const graph = await graphBuilder();
  const allEntities = graph
    .nodes()
    .map((id) => graph.getNodeAttributes(id) as typeof entities.$inferSelect);
  const allRelations = graph
    .edges()
    .map((id) => graph.getEdgeAttributes(id) as typeof relations.$inferSelect);

  if (allEntities.length === 0) {
    return { message: 'No entities found to group.' };
  }

  // 3. Louvain アルゴリズムによるコミュニティ検知
  const communityMapping = louvain(graph);

  // コミュニティごとにエンティティをグループ化
  const groups: Record<string, string[]> = {};
  for (const [entityId, communityId] of Object.entries(communityMapping)) {
    const cId = String(communityId);
    if (!groups[cId]) groups[cId] = [];
    groups[cId].push(entityId);
  }

  logger(`Detected ${Object.keys(groups).length} communities.`);

  // 4. 旧コミュニティ情報のクリア (シンプルな実装として全削除)
  // 実運用では差分更新が望ましいが、第1版は一括再構築とする
  await database.delete(communities);

  // 5. 各グループに対して要約を生成し、保存
  for (const [, entityIds] of Object.entries(groups)) {
    // このコミュニティに含まれるエンティティとリレーションの情報を抽出
    const groupEntities = allEntities.filter((e) => entityIds.includes(e.id));
    const groupRelations = allRelations.filter(
      (r) => entityIds.includes(r.sourceId) || entityIds.includes(r.targetId),
    );

    const contextText = `
Entities:
${groupEntities.map((e) => `- ${e.name} (${e.type}): ${e.description || ''}`).join('\n')}

Relations:
${groupRelations.map((r) => `- ${r.sourceId} --[${r.relationType}]--> ${r.targetId}`).join('\n')}
`.trim();

    // LLM で要約
    const { name, summary } = await summarize(contextText);

    // コミュニティの保存
    const [newCommunity] = await database
      .insert(communities)
      .values({
        name,
        summary,
        metadata: { entityCount: entityIds.length },
      })
      .returning();

    // エンティティに communityId を紐付け
    await database
      .update(entities)
      .set({ communityId: newCommunity.id })
      .where(inArray(entities.id, entityIds));

    logger(`Community "${name}" built with ${entityIds.length} entities.`);
  }

  const result = {
    message: 'Communities rebuilt successfully.',
    count: Object.keys(groups).length,
  };

  return CommunityRebuildResultSchema.parse(result);
}
