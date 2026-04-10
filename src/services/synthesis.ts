import { eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { vibeMemories } from '../db/schema.js';
import { saveEntities, saveRelations } from './graph.js';
import { distillKnowledgeFromTranscript } from './llm.js';

/**
 * 自己省察（Reflective Synthesis）を実行します。
 * 未処理の Vibe Memory を分析し、Knowledge Graph（エンティティとリレーション）に統合します。
 */
export async function synthesizeKnowledge() {
  const batchSize = config.synthesisBatchSize;

  // 1. 未処理のメモリを取得
  const pendingMemories = await db
    .select()
    .from(vibeMemories)
    .where(eq(vibeMemories.isSynthesized, false))
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
    const distilled = await distillKnowledgeFromTranscript(combinedTranscript);

    // 4. グラフに反映
    if (distilled.entities.length > 0) {
      await saveEntities(distilled.entities);
    }
    if (distilled.relations.length > 0) {
      await saveRelations(distilled.relations);
    }

    // 5. 処理済みフラグを更新
    const processedIds = pendingMemories.map((m) => m.id);
    await db
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
