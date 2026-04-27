import { synthesizeKnowledge } from '../../synthesis.js';

export type SynthesisTaskOptions = {
  maxFailures?: number;
};

export type SynthesisTaskResult = {
  processedMemories: number;
  extractedEntities: number;
  extractedRelations: number;
  failedCount: number;
};

/**
 * 自己省察（Synthesis）タスク。
 * 未処理の raw 記憶から知識（エンティティ・リレーション）を抽出し、
 * 知識グラフを自動更新します。
 */
export async function synthesisTask(
  options: SynthesisTaskOptions = {},
): Promise<SynthesisTaskResult> {
  const maxFailures = Math.max(0, Math.trunc(options.maxFailures ?? 0));

  try {
    const result = await synthesizeKnowledge();
    if (result.count > 0) {
      console.error(
        `[SynthesisTask] Processed ${result.count} memories. Extracted ${result.extractedEntities} entities and ${result.extractedRelations} relations.`,
      );
    }
    return {
      processedMemories: result.count,
      extractedEntities: result.extractedEntities ?? 0,
      extractedRelations: result.extractedRelations ?? 0,
      failedCount: 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[SynthesisTask] Failed:', err);

    const failedCount = 1;
    if (failedCount > maxFailures) {
      throw new Error(
        `[SynthesisTask] failedCount=${failedCount} exceeded maxFailures=${maxFailures}. ${message}`,
      );
    }

    return {
      processedMemories: 0,
      extractedEntities: 0,
      extractedRelations: 0,
      failedCount,
    };
  }
}
