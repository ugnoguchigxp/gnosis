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
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { entities, experienceLogs, relations, vibeMemories } from '../db/schema.js';
import { generateEntityId } from '../utils/entityId.js';
import { withGlobalLock } from '../utils/lock.js';
import { getGuidanceContext } from './guidance/search.js';
import { generateEmbedding, searchMemoriesByType } from './memory.js';
import { runPromptWithMemoryLoopRouter } from './memoryLoopLlmRouter.js';

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
  withSemaphore?: <T>(name: string, concurrency: number, fn: () => Promise<T>) => Promise<T>;
  embedText?: (text: string) => Promise<number[]>;
  minRawCount?: number;
  sourceTask?: string;
  getGuidance?: typeof getGuidanceContext;
  searchEpisodes?: typeof searchMemoriesByType;
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
  const llmScript = deps.llmScript;
  const llmTimeoutMs = deps.llmTimeoutMs ?? config.llmTimeoutMs;
  const lockFn = deps.withLock ?? withGlobalLock;
  const embedText = deps.embedText ?? generateEmbedding;
  const minRawCount = deps.minRawCount ?? 5;
  const sourceTask = deps.sourceTask;
  const maxRawCount = 30; // 1回あたりの最大メモ件数

  // 1. 未処理の raw メモを取得（created_at ASC）
  const queryCriteria = [
    eq(vibeMemories.sessionId, sessionId),
    eq(vibeMemories.isSynthesized, false),
    eq(vibeMemories.memoryType, 'raw'),
  ];

  if (sourceTask) {
    queryCriteria.push(eq(vibeMemories.sourceTask, sourceTask));
  } else {
    queryCriteria.push(sql`${vibeMemories.sourceTask} IS NULL`);
  }

  let rawMemories = await database
    .select()
    .from(vibeMemories)
    .where(and(...queryCriteria))
    .orderBy(asc(vibeMemories.createdAt))
    .limit(maxRawCount);

  if (rawMemories.length < minRawCount) {
    return null; // 件数不足
  }

  // Time Gap Heuristic (sourceTask がない場合、60分以上の空きでセグメントを区切る)
  if (!sourceTask) {
    const SEGMENT_GAP_MS = 60 * 60 * 1000;
    let cutIdx = -1;
    for (let i = 1; i < rawMemories.length; i++) {
      const prevTime = rawMemories[i - 1].createdAt.getTime();
      const currTime = rawMemories[i].createdAt.getTime();
      if (currTime - prevTime > SEGMENT_GAP_MS) {
        cutIdx = i;
        break;
      }
    }

    if (cutIdx !== -1) {
      // 区切られた後の件数が minRawCount を下回る場合は、一旦そこまでで処理を打ち切る
      rawMemories = rawMemories.slice(0, cutIdx);
      if (rawMemories.length < minRawCount) {
        return null;
      }
    }
  }

  // 2. experience_logs を取得 (sessionId が一致するもの。sourceTaskがあれば絞り込む)
  const expCriteria = [eq(experienceLogs.sessionId, sessionId)];
  const experiences = await database
    .select()
    .from(experienceLogs)
    .where(and(...expCriteria));

  // 3. 追加コンテキスト取得 (教訓、スキル、ルール、手続き)

  // (1) 手続き (Procedures): sourceTask (通常はGoal ID) に紐づくステップを取得
  let proceduresText = '（なし）';
  if (sourceTask) {
    const steps = await database
      .select({
        name: entities.name,
        description: entities.description,
      })
      .from(relations)
      .innerJoin(entities, eq(entities.id, relations.targetId))
      .where(and(eq(relations.sourceId, sourceTask), eq(relations.relationType, 'has_step')));

    if (steps.length > 0) {
      proceduresText = steps
        .map((s) => `- ${s.name}: ${s.description?.slice(0, 100)}...`)
        .join('\n');
    }
  }

  // (2) ルール & SKILL: guidance registry から現在の作業内容に合うものを検索
  const memoriesText = rawMemories.map((m, i) => `[${i + 1}] ${m.content}`).join('\n');
  const getGuidance = deps.getGuidance ?? getGuidanceContext;
  const guidanceContextText = await getGuidance(memoriesText);
  const rulesAndSkillsText = guidanceContextText || '（なし）';

  // (3) 教訓 (Lessons): 今回のセッションでの成功/失敗、または過去の類似した教訓
  const experiencesText =
    experiences.length > 0
      ? experiences.map((e) => `[${e.type}] ${e.content}`).join('\n')
      : '（なし）';

  // (4) 類似エピソード検索
  const searchEpisodes = deps.searchEpisodes ?? searchMemoriesByType;
  const searchQuery = `${memoriesText}\n${experiencesText}`.slice(0, 2000);
  const similarEpisodes = await searchEpisodes(searchQuery, 'episode', 3, database);
  const similarEpisodesText =
    similarEpisodes.length > 0
      ? similarEpisodes
          .map((e) => `ID: ${e.id}\n内容: ${e.content}\n類似度: ${e.similarity?.toFixed(3)}`)
          .join('\n\n')
      : '（なし）';

  // 4. LLM でストーリー化
  const taskContext = sourceTask ? `【対象タスク: ${sourceTask}】\n` : '';

  const prompt = `
${taskContext}以下の作業メモ、体験記録、関連するルールや手続きを1つのストーリーに統合してください。
これらは同一の論理的な作業単位（タスク）に関する記録です。

【重要：重複チェックとアクション選定】
入力された「類似ストーリー一覧」を確認し、今回の内容が既存のストーリーと重複していないか、あるいは既存のものを改善すべきか判断してください。

以下のいずれかのアクションを選択してください：
- "create": 既存のものと内容が大きく異なり、新しいストーリーとして保存すべき場合
- "update": 既存のストーリーに新しい情報を統合・修正して上書き・改変すべき場合
- "skip": 既存のストーリーで既に十分カバーされており、新しく記録する必要がない場合

【厳守事項】
1. 入力にない情報を絶対に追加しないでください（推測は避ける）
2. 以下の3要素を含む因果関係のあるナラティブにしてください:
   - 何が起きたか（状況・行動）
   - なぜそうなったか（原因・判断理由・参照したルールや手法）
   - 結果どうなったか（成功/失敗・得られた教訓）
3. パスワード、APIキー、認証トークン、個人情報は除外してください
4. 出力は以下のJSON形式のみ:

{
  "action": "create" | "update" | "skip",
  "targetEpisodeId": "update の場合、対象とする既存ストーリーの ID（それ以外は null）",
  "story": "ストーリー本文（200-500文字。create/update の場合必須。update の場合は既存の内容に今回の事実を適切にマージ・改変した後の全文を記述すること）",
  "importance": 0.5,
  "episodeAt": "出来事の中心的な時刻（ISO 8601）",
  "reason": "アクションを選択した理由（簡潔に）"
}

--- メモ一覧 ---
${memoriesText}

--- 計画されていた手続き（参考） ---
${proceduresText}

--- 適用されたガイドライン（ルール/SKILL） ---
${rulesAndSkillsText}

--- 今回の体験記録（成功/失敗） ---
${experiencesText}

--- 類似ストーリー一覧（重複チェック用） ---
${similarEpisodesText}
`.trim();

  let story: string;
  let importance: number;
  let episodeAt: Date;

  try {
    const routed = await runPromptWithMemoryLoopRouter(
      {
        prompt,
        taskKind: 'consolidation',
        llmScript,
        llmTimeoutMs:
          Number.isFinite(llmTimeoutMs) && llmTimeoutMs > 0
            ? llmTimeoutMs
            : config.llm.defaultTimeoutMs,
      },
      {
        spawnSync,
        withLock: lockFn,
        withSemaphore: deps.withSemaphore,
      },
    );
    const output = routed.output;
    const jsonMatch = output?.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      const rawSnippet = output?.length > 500 ? `${output.slice(0, 500)}...` : output;
      console.error('Raw LLM output (no JSON found):', rawSnippet);
      throw new Error(`No JSON in LLM response. Raw output: ${rawSnippet}`);
    }

    let parsed = JSON.parse(jsonMatch[0]);

    // CLI からのラッパー JSON (main.py 等) の場合は中の 'response' フィールドを取り出す
    if (parsed && typeof parsed === 'object' && 'response' in parsed) {
      const response = String(parsed.response);
      if (response.includes('回答を生成できませんでした。')) {
        throw new Error('LLM failed to generate a response (local engine error)');
      }
      const innerJsonMatch = response.match(/\{[\s\S]*\}/);
      if (innerJsonMatch) {
        parsed = JSON.parse(innerJsonMatch[0]);
      } else {
        // もしレスポンスの中にさらに JSON がなければ、そのまま使う（またはエラーにする）
        // ここではフォールバックとしてパース済みオブジェクトをそのまま使う
      }
    }

    story = parsed.story;
    importance = typeof parsed.importance === 'number' ? parsed.importance : 0.5;
    episodeAt = parsed.episodeAt ? new Date(parsed.episodeAt) : new Date();

    const action = parsed.action || 'create';
    const targetEpisodeId = parsed.targetEpisodeId;

    if (action === 'skip') {
      console.log(`[Consolidation] Skipping episode creation. Reason: ${parsed.reason}`);
      // raw メモを処理済みにする
      for (const raw of rawMemories) {
        await database
          .update(vibeMemories)
          .set({ isSynthesized: true })
          .where(eq(vibeMemories.id, raw.id));
      }
      return null;
    }

    if (action === 'update' && targetEpisodeId) {
      console.log(
        `[Consolidation] Updating existing episode ${targetEpisodeId}. Reason: ${parsed.reason}`,
      );
      const episodeEmbedding = await embedText(story);

      // vibe_memories 更新
      await database
        .update(vibeMemories)
        .set({
          content: story,
          embedding: episodeEmbedding,
          importance,
          episodeAt,
        })
        .where(eq(vibeMemories.id, targetEpisodeId));

      // entities 更新 (episode プロキシ)
      await database
        .update(entities)
        .set({
          description: story,
          embedding: episodeEmbedding,
          confidence: importance,
        })
        .where(sql`metadata->>'memoryId' = ${targetEpisodeId}`);

      // raw メモを処理済みにする
      for (const raw of rawMemories) {
        await database
          .update(vibeMemories)
          .set({ isSynthesized: true })
          .where(eq(vibeMemories.id, raw.id));
      }

      return {
        episodeId: targetEpisodeId,
        episodeEntityId: `episode:${targetEpisodeId.slice(0, 8)}`,
      };
    }

    if (!story) {
      console.error('Parsed result missing story field:', parsed);
      throw new Error('LLM output missing required story field');
    }
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
      sourceTask,
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
