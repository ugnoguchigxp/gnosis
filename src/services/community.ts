import { inArray } from 'drizzle-orm';
import louvain from 'graphology-communities-louvain';
import { db } from '../db/index.js';
import { communities, entities, type relations } from '../db/schema.js';
import { buildGraph } from './graph.js';
import { summarizeCommunity } from './llm.js';

/**
 * グラフ全体をスキャンし、コミュニティ（知識の塊）を再構築します。
 */
export async function buildCommunities() {
  console.log('Starting community detection...');

  // 1. グラフの構築 (共通関数を使用)
  const graph = await buildGraph();
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

  console.log(`Detected ${Object.keys(groups).length} communities.`);

  // 4. 旧コミュニティ情報のクリア (シンプルな実装として全削除)
  // 実運用では差分更新が望ましいが、第1版は一括再構築とする
  await db.delete(communities);

  // 5. 各グループに対して要約を生成し、保存
  for (const [idx, entityIds] of Object.entries(groups)) {
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
    const { name, summary } = await summarizeCommunity(contextText);

    // コミュニティの保存
    const [newCommunity] = await db
      .insert(communities)
      .values({
        name,
        summary,
        metadata: { entityCount: entityIds.length },
      })
      .returning();

    // エンティティに communityId を紐付け
    await db
      .update(entities)
      .set({ communityId: newCommunity.id })
      .where(inArray(entities.id, entityIds));

    console.log(`Community "${name}" built with ${entityIds.length} entities.`);
  }

  return {
    message: 'Communities rebuilt successfully.',
    count: Object.keys(groups).length,
  };
}
