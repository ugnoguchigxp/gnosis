import { synthesizeKnowledge } from '../../synthesis.js';

/**
 * 自己省察（Synthesis）タスク。
 * 集約されたエピソード記憶（ストーリー）から知識（エンティティ・リレーション）を抽出し、
 * 知識グラフを自動更新します。
 */
export async function synthesisTask(): Promise<void> {
  try {
    const result = await synthesizeKnowledge();
    if (result.count > 0) {
      console.error(
        `[SynthesisTask] Processed ${result.count} memories. Extracted ${result.extractedEntities} entities and ${result.extractedRelations} relations.`,
      );
    }
  } catch (err) {
    console.error('[SynthesisTask] Failed:', err);
  }
}
