/**
 * エピソード記憶のストーリー化 (Phase 3)
 *
 * 同一セッションの raw メモ + experience_logs を LLM でナラティブ統合し、
 * memory_type: 'episode' の vibe_memory と entities の episode プロキシを生成する。
 */
import {
  type SpawnSyncOptionsWithStringEncoding,
  spawnSync as nodeSpawnSync,
} from 'node:child_process';
import { and, asc, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { entities, experienceLogs, vibeMemories } from '../db/schema.js';
import { generateEntityId } from '../utils/entityId.js';
import { withGlobalLock } from '../utils/lock.js';
import { generateEmbedding } from './memory.js';

export type SpawnSyncFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: { encoding: 'utf-8'; env?: NodeJS.ProcessEnv; timeout?: number },
) => { stdout: string; stderr: string; status: number | null; error?: Error };

export type ConsolidateEpisodesDeps = {
  database?: typeof db;
  spawnSync?: SpawnSyncFn;
  llmScript?: string;
  llmTimeoutMs?: number;
  withLock?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  embedText?: (text: string) => Promise<number[]>;
  minRawCount?: number;
};

const defaultSpawnSync: SpawnSyncFn = (command, args, options) =>
  nodeSpawnSync(command, args, options as SpawnSyncOptionsWithStringEncoding);

/**
 * 同一セッションの raw メモ + experience_logs をストーリー化する。
 *
 * @param sessionId - 対象セッション ID
 * @param deps - 依存性注入（テスト用）
 * @returns 生成された episode の vibe_memories.id または null（対象なし）
 */
export async function consolidateEpisodes(
  sessionId: string,
  deps: ConsolidateEpisodesDeps = {},
): Promise<{ episodeId: string; episodeEntityId: string } | null> {
  const database = deps.database ?? db;
  const spawnSync = deps.spawnSync ?? defaultSpawnSync;
  const llmScript = deps.llmScript ?? config.llmScript;
  const llmTimeoutMs = deps.llmTimeoutMs ?? config.llmTimeoutMs;
  const lockFn = deps.withLock ?? withGlobalLock;
  const embedText = deps.embedText ?? generateEmbedding;
  const minRawCount = deps.minRawCount ?? 5;

  // 1. 未処理の raw メモを取得（created_at ASC）
  const rawMemories = await database
    .select()
    .from(vibeMemories)
    .where(
      and(
        eq(vibeMemories.sessionId, sessionId),
        eq(vibeMemories.isSynthesized, false),
        eq(vibeMemories.memoryType, 'raw'),
      ),
    )
    .orderBy(asc(vibeMemories.createdAt));

  if (rawMemories.length < minRawCount) {
    return null; // 件数不足
  }

  // 2. experience_logs を取得
  const experiences = await database
    .select()
    .from(experienceLogs)
    .where(eq(experienceLogs.sessionId, sessionId));

  // 3. LLM でストーリー化
  const memoriesText = rawMemories.map((m, i) => `[${i + 1}] ${m.content}`).join('\n');
  const experiencesText =
    experiences.length > 0
      ? experiences.map((e) => `[${e.type}] ${e.content}`).join('\n')
      : '（なし）';

  const prompt = `
以下のメモと体験記録を1つのストーリーに統合してください。

【厳守事項】
1. 入力にない情報を絶対に追加しないでください
2. 以下の3要素を含む因果関係のあるナラティブにしてください:
   - 何が起きたか（状況・行動）
   - なぜそうなったか（原因・判断理由）
   - 結果どうなったか（成功/失敗・教訓）
3. パスワード、APIキー、認証トークン、個人情報は除外してください
4. 出力は以下のJSON形式のみ:

{
  "story": "ストーリー本文（200-500文字）",
  "importance": 0.5,
  "episodeAt": "出来事の中心的な時刻（ISO 8601）"
}

--- メモ一覧 ---
${memoriesText}

--- 体験記録（あれば） ---
${experiencesText}
`.trim();

  let story: string;
  let importance: number;
  let episodeAt: Date;

  try {
    const result = await lockFn('local-llm', async () =>
      spawnSync(llmScript, ['--output', 'text', '--prompt', prompt], {
        encoding: 'utf-8',
        env: { ...process.env },
        timeout:
          Number.isFinite(llmTimeoutMs) && llmTimeoutMs > 0
            ? llmTimeoutMs
            : config.llm.defaultTimeoutMs,
      }),
    );

    if (result.error || result.status !== 0) {
      console.error('Consolidation LLM error:', result.error ?? result.stderr);
      throw new Error('LLM call failed');
    }

    const output = result.stdout?.trim();
    const jsonMatch = output?.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in LLM response');

    const parsed = JSON.parse(jsonMatch[0]) as {
      story: string;
      importance: number;
      episodeAt: string;
    };
    story = parsed.story;
    importance = typeof parsed.importance === 'number' ? parsed.importance : 0.5;
    episodeAt = parsed.episodeAt ? new Date(parsed.episodeAt) : new Date();
  } catch (err) {
    console.error('Failed to consolidate episodes:', err);
    throw err;
  }

  // 4. episode vibe_memory を直接 INSERT（embedding は embedText dep を使用）
  const sourceIds = rawMemories.map((m) => m.id);
  const episodeEmbedding = await embedText(story);

  const [episode] = await database
    .insert(vibeMemories)
    .values({
      sessionId,
      content: story,
      embedding: episodeEmbedding,
      metadata: { sourceIds },
      memoryType: 'episode',
      episodeAt,
      importance,
      compressed: true,
    })
    .returning();

  // 5. episode プロキシ entity を INSERT（embedding は既に生成済みの episodeEmbedding を再利用）
  const episodeEntityId = generateEntityId('episode', episode.id);

  await database
    .insert(entities)
    .values({
      id: episodeEntityId,
      type: 'episode',
      name: `episode:${episode.id.slice(0, 8)}`,
      description: story,
      embedding: episodeEmbedding,
      metadata: { memoryId: episode.id, sessionId, sourceIds },
      confidence: importance,
      provenance: 'consolidation',
    })
    .onConflictDoNothing();

  // 6. 元の raw メモを is_synthesized = true に更新
  for (const raw of rawMemories) {
    await database
      .update(vibeMemories)
      .set({ isSynthesized: true })
      .where(eq(vibeMemories.id, raw.id));
  }

  return { episodeId: episode.id, episodeEntityId };
}
