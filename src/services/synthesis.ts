import { and, eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { vibeMemories } from '../db/schema.js';
import { generateEntityId } from '../utils/entityId.js';
import { saveEntities, saveRelations } from './graph.js';
import { distillKnowledgeFromTranscript } from './llm.js';

type DbLike = Pick<typeof db, 'select' | 'update'>;

export type SynthesizeKnowledgeDeps = {
  database?: DbLike;
  distill?: typeof distillKnowledgeFromTranscript;
  saveEnts?: typeof saveEntities;
  saveRels?: typeof saveRelations;
  batchSize?: number;
};

/**
 * 自己省察（Reflective Synthesis）を実行します。
 * 未処理の Vibe Memory を分析し、Knowledge Graph（エンティティとリレーション）に統合します。
 */
export async function synthesizeKnowledge(deps: SynthesizeKnowledgeDeps = {}) {
  const database = deps.database ?? db;
  const distill = deps.distill ?? distillKnowledgeFromTranscript;
  const saveEnts = deps.saveEnts ?? saveEntities;
  const saveRels = deps.saveRels ?? saveRelations;
  const batchSize = deps.batchSize ?? config.synthesisBatchSize;

  // 1. 未処理のエピソード記憶を取得（Phase 3-3: memory_type = 'episode' のみ）
  const pendingMemories = await database
    .select()
    .from(vibeMemories)
    .where(and(eq(vibeMemories.isSynthesized, false), eq(vibeMemories.memoryType, 'episode')))
    .limit(batchSize);

  if (pendingMemories.length === 0) {
    return { count: 0, message: 'No pending memories to synthesize.' };
  }

  console.log(`Synthesizing ${pendingMemories.length} memories...`);

  // 2. メモリの内容を結合して分析
  // セッションごとにまとめるとより文脈が明確になるが、一旦単純に結合
  const combinedTranscript = pendingMemories
    .map((m) => `[Session: ${m.sessionId}] ${m.content}`)
    .join('\n---\n');

  try {
    // 3. LLMで知識を蒸留 (既存の関数を流用)
    const distilled = await distill(combinedTranscript);

    // 4. グラフに反映（エピソードごとに処理して learned_from 関係を正確に紐付ける）
    for (const episode of pendingMemories) {
      const episodeEntityId = generateEntityId('episode', episode.id);
      const episodeProxy = {
        id: episodeEntityId,
        type: 'episode',
        name: `episode:${episode.id.slice(0, 8)}`,
        description: episode.content.slice(0, 200),
        metadata: { memoryId: episode.id },
        confidence: (episode.importance as number | null | undefined) ?? 0.5,
        provenance: 'synthesis',
      };
      await saveEnts([episodeProxy]);
    }

    if (distilled.entities.length > 0) {
      await saveEnts(distilled.entities);
    }

    // Phase 4-5: task / goal / constraint → learned_from → episode プロキシ
    const learnedRelations = [];
    for (const ent of distilled.entities) {
      if (['task', 'goal', 'constraint'].includes(ent.type)) {
        const sourceId = generateEntityId(ent.type, ent.name);
        for (const episode of pendingMemories) {
          const episodeEntityId = generateEntityId('episode', episode.id);
          learnedRelations.push({
            sourceId,
            targetId: episodeEntityId,
            relationType: 'learned_from',
            weight: 0.8,
          });
        }
      }
    }

    if (distilled.relations.length > 0) {
      await saveRels(distilled.relations);
    }
    if (learnedRelations.length > 0) {
      await saveRels(learnedRelations);
    }

    // 5. 処理済みフラグを更新
    const processedIds = pendingMemories.map((m) => m.id);
    await database
      .update(vibeMemories)
      .set({ isSynthesized: true })
      .where(inArray(vibeMemories.id, processedIds));

    return {
      count: pendingMemories.length,
      extractedEntities: distilled.entities.length,
      extractedRelations: distilled.relations.length,
    };
  } catch (error) {
    console.error('Synthesis failed:', error);
    throw error;
  }
}
