import { and, eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { vibeMemories } from '../db/schema.js';
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

const isRecoverableDistillError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /LLM distillation command failed/i.test(message) ||
    /parse/i.test(message) ||
    /empty llm response/i.test(message)
  );
};

/**
 * 自己省察（Reflective Synthesis）を実行します。
 * 未処理の raw Vibe Memory を分析し、Knowledge Graph（エンティティとリレーション）に統合します。
 */
export async function synthesizeKnowledge(deps: SynthesizeKnowledgeDeps = {}) {
  const database = deps.database ?? db;
  const distill = deps.distill ?? distillKnowledgeFromTranscript;
  const saveEnts = deps.saveEnts ?? saveEntities;
  const saveRels = deps.saveRels ?? saveRelations;
  const batchSize = deps.batchSize ?? config.synthesisBatchSize;

  // 1. 未処理の raw 記憶を取得
  const pendingMemories = await database
    .select()
    .from(vibeMemories)
    .where(and(eq(vibeMemories.isSynthesized, false), eq(vibeMemories.memoryType, 'raw')))
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
    console.info(
      `[Synthesis] distill_start batch=${pendingMemories.length} transcriptChars=${combinedTranscript.length} note=distillation_does_not_use_search_or_fetch`,
    );
    // 3. LLMで知識を蒸留 (既存の関数を流用)
    const distilled = await distill(combinedTranscript);

    // 4. 抽出された知識をグラフに反映
    if (distilled.entities.length > 0) {
      await saveEnts(distilled.entities);
    }

    if (distilled.relations.length > 0) {
      await saveRels(distilled.relations);
    }

    // 5. 処理済みフラグを更新
    // 抽出0件の場合は生メモリを残し、次回に再試行できるようにする。
    if (distilled.entities.length === 0 && distilled.relations.length === 0) {
      console.warn(
        `[Synthesis] no_extractable_knowledge batch=${pendingMemories.length} transcriptChars=${combinedTranscript.length}`,
      );
      return {
        count: 0,
        extractedEntities: 0,
        extractedRelations: 0,
        message: 'No extractable knowledge produced by distillation. Raw memories kept.',
      };
    }

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
    const message = error instanceof Error ? error.message : String(error);
    if (isRecoverableDistillError(error)) {
      console.warn(
        `[Synthesis] recoverable_distill_error message=${message} action=keep_raw_memories_and_finish_without_defer`,
      );
      return {
        count: 0,
        extractedEntities: 0,
        extractedRelations: 0,
        message: `Recoverable distillation error: ${message}`,
      };
    }
    console.error(`[Synthesis] failed message=${message}`);
    throw error;
  }
}
