/**
 * 手続き記憶サービス (Phase 4 + Phase 5)
 *
 * - queryProcedure: goal テキスト → 順序付き task + constraints + episodes
 * - updateConfidence: 実行結果による confidence スコア更新
 * - recordOutcome: フィードバックループ（confidence 更新 + エピソード記録 + 改善提案）
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { entities, relations, vibeMemories } from '../db/schema.js';
import { generateEntityId } from '../utils/entityId.js';
import { saveEntities, saveRelations } from './graph.js';
import { generateEmbedding } from './memory.js';

type DbClient = typeof db;

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export type ConfidenceEvent =
  | 'followed_success'
  | 'followed_failure'
  | 'ignored_success'
  | 'ignored_failure';

export type TaskResult = {
  taskId: string;
  followed: boolean;
  succeeded: boolean;
  note?: string;
};

export type ImprovementType = 'modify_task' | 'add_task' | 'add_precondition' | 'add_constraint';

export type Improvement = {
  type: ImprovementType;
  targetTaskId?: string;
  suggestion: string;
};

export type QueryProcedureDeps = {
  database?: DbClient;
  embed?: (text: string) => Promise<number[]>;
};

export type RecordOutcomeDeps = {
  database?: DbClient;
  embed?: (text: string) => Promise<number[]>;
};

// ---------------------------------------------------------------------------
// updateConfidence
// ---------------------------------------------------------------------------

/**
 * confidence スコアを実行結果イベントに基づいて更新する。
 * クランプ: [0.0, 1.0]
 */
export function updateConfidence(current: number, event: ConfidenceEvent): number {
  let delta: number;
  switch (event) {
    case 'followed_success':
      delta = 0.1 * (1 - current);
      break;
    case 'followed_failure':
      delta = -0.15 * current;
      break;
    case 'ignored_success':
      delta = -0.05;
      break;
    case 'ignored_failure':
      delta = 0.05;
      break;
  }
  return Math.max(0.0, Math.min(1.0, current + delta));
}

// ---------------------------------------------------------------------------
// queryProcedure
// ---------------------------------------------------------------------------

type ProcedureTask = {
  id: string;
  name: string;
  description: string;
  confidence: number;
  order: number;
  episodes: Array<{ id: string; story: string }>;
};

type ProcedureConstraint = {
  id: string;
  name: string;
  description: string;
};

export type ProcedureResult = {
  goal: { id: string; name: string; description: string };
  tasks: ProcedureTask[];
  constraints: ProcedureConstraint[];
};

/**
 * goal テキストから関連する task / constraint / episode を取得し、
 * トポロジカルソートされた手続き記憶を返す。
 */
export async function queryProcedure(
  goalText: string,
  contextText?: string,
  deps: QueryProcedureDeps = {},
): Promise<ProcedureResult | null> {
  const database = deps.database ?? db;
  const embed = deps.embed ?? generateEmbedding;

  // 1. goal 検索: embedding 類似度 TOP 1
  const goalEmbedding = await embed(goalText);
  const embStr = JSON.stringify(goalEmbedding);
  const similarity = sql<number>`1 - (${entities.embedding} <=> ${embStr}::vector)`;

  const goalCandidates = await database
    .select({
      id: entities.id,
      name: entities.name,
      description: entities.description,
      confidence: entities.confidence,
      similarity,
    })
    .from(entities)
    .where(eq(entities.type, 'goal'))
    .orderBy(desc(similarity))
    .limit(3);

  if (goalCandidates.length === 0) return null;

  let goalEntity = goalCandidates[0];

  // 類似度が低い場合は name 部分一致でフォールバック
  if ((goalEntity.similarity ?? 0) < 0.8) {
    const nameFallback = await database
      .select({
        id: entities.id,
        name: entities.name,
        description: entities.description,
        confidence: entities.confidence,
      })
      .from(entities)
      .where(and(eq(entities.type, 'goal'), sql`${entities.name} ILIKE ${`%${goalText}%`}`))
      .limit(1);
    if (nameFallback.length > 0) goalEntity = { ...nameFallback[0], similarity: 0 };
  }

  // 2. has_step 関係を辿り task を収集（最大3ホップ）
  const taskIds = new Set<string>();
  const toVisit = [goalEntity.id];
  for (let hop = 0; hop < 3 && toVisit.length > 0; hop++) {
    const current = toVisit.splice(0, toVisit.length);
    const steps = await database
      .select({ targetId: relations.targetId })
      .from(relations)
      .where(and(inArray(relations.sourceId, current), eq(relations.relationType, 'has_step')));
    for (const { targetId } of steps) {
      if (!taskIds.has(targetId)) {
        taskIds.add(targetId);
        toVisit.push(targetId);
      }
    }
  }

  if (taskIds.size === 0) {
    return {
      goal: { id: goalEntity.id, name: goalEntity.name, description: goalEntity.description ?? '' },
      tasks: [],
      constraints: [],
    };
  }

  // 3. context フィルタ（指定されていれば）
  let filteredTaskIds = [...taskIds];
  if (contextText) {
    const ctxEmbedding = await embed(contextText);
    const ctxStr = JSON.stringify(ctxEmbedding);
    const ctxSimilarity = sql<number>`1 - (${entities.embedding} <=> ${ctxStr}::vector)`;
    // when 関係で紐づく context エンティティとの類似度チェック
    const whenRelations = await database
      .select({ sourceId: relations.sourceId, targetId: relations.targetId, ctxSimilarity })
      .from(relations)
      .innerJoin(entities, eq(entities.id, relations.sourceId))
      .where(
        and(
          eq(relations.relationType, 'when'),
          inArray(relations.targetId, filteredTaskIds),
          eq(entities.type, 'context'),
        ),
      );
    // context エンティティと入力 context の類似度が低いタスクは除外
    const lowContextTasks = new Set<string>();
    for (const rel of whenRelations) {
      if ((rel.ctxSimilarity ?? 0) < 0.7) lowContextTasks.add(rel.targetId);
    }
    filteredTaskIds = filteredTaskIds.filter((id) => !lowContextTasks.has(id));
  }

  // 4. task エンティティ取得
  const taskEntities =
    filteredTaskIds.length > 0
      ? await database.select().from(entities).where(inArray(entities.id, filteredTaskIds))
      : [];

  // 5. constraint 収集 (prohibits 関係)
  const constraintRelations =
    filteredTaskIds.length > 0
      ? await database
          .select({ sourceId: relations.sourceId })
          .from(relations)
          .where(
            and(
              inArray(relations.targetId, filteredTaskIds),
              eq(relations.relationType, 'prohibits'),
            ),
          )
      : [];
  const constraintIds = [...new Set(constraintRelations.map((r) => r.sourceId))];
  const constraintEntities =
    constraintIds.length > 0
      ? await database.select().from(entities).where(inArray(entities.id, constraintIds))
      : [];

  // 6. episode 収集 (learned_from 関係)
  const episodeRelations =
    filteredTaskIds.length > 0
      ? await database
          .select({ sourceId: relations.sourceId, targetId: relations.targetId })
          .from(relations)
          .where(
            and(
              inArray(relations.sourceId, filteredTaskIds),
              eq(relations.relationType, 'learned_from'),
            ),
          )
      : [];
  const episodeEntityIds = [...new Set(episodeRelations.map((r) => r.targetId))];
  const episodeEntities =
    episodeEntityIds.length > 0
      ? await database.select().from(entities).where(inArray(entities.id, episodeEntityIds))
      : [];

  // episode プロキシ → vibe_memories.story マッピング
  const episodeStories = new Map<string, string>();
  for (const ep of episodeEntities) {
    const memoryId = (ep.metadata as Record<string, unknown>)?.memoryId as string | undefined;
    if (memoryId) {
      const [mem] = await database
        .select({ content: vibeMemories.content })
        .from(vibeMemories)
        .where(eq(vibeMemories.id, memoryId));
      if (mem) episodeStories.set(ep.id, mem.content);
    } else {
      episodeStories.set(ep.id, ep.description ?? '');
    }
  }

  // 7. トポロジカルソート (precondition / follows 関係から DAG 構築)
  const orderMap = new Map<string, number>();
  const precondRelations =
    filteredTaskIds.length > 0
      ? await database
          .select({ sourceId: relations.sourceId, targetId: relations.targetId })
          .from(relations)
          .where(
            and(
              inArray(relations.sourceId, filteredTaskIds),
              inArray(relations.relationType, ['precondition', 'follows']),
            ),
          )
      : [];

  // 簡易トポロジカルソート: in-degree 順
  const inDegree = new Map<string, number>(filteredTaskIds.map((id) => [id, 0]));
  for (const { targetId } of precondRelations) {
    if (inDegree.has(targetId)) inDegree.set(targetId, (inDegree.get(targetId) ?? 0) + 1);
  }
  const sorted = [...inDegree.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  sorted.forEach((id, i) => orderMap.set(id, i));

  // 8. tasks 組み立て
  const tasks: ProcedureTask[] = taskEntities.map((te) => {
    const conf = (te.confidence as number | null | undefined) ?? 0.5;
    const taskEpisodeIds = episodeRelations
      .filter((r) => r.sourceId === te.id)
      .map((r) => r.targetId);
    const episodes = taskEpisodeIds.map((epId) => ({
      id: epId,
      story: episodeStories.get(epId) ?? '',
    }));

    return {
      id: te.id,
      name: te.name,
      description: te.description ?? '',
      confidence: conf,
      order: orderMap.get(te.id) ?? 999,
      episodes,
    };
  });

  // confidence < 0.3 を末尾に分離
  const mainTasks = tasks.filter((t) => t.confidence >= 0.3).sort((a, b) => a.order - b.order);
  const lowTasks = tasks.filter((t) => t.confidence < 0.3).map((t) => ({ ...t, order: 9999 }));

  return {
    goal: { id: goalEntity.id, name: goalEntity.name, description: goalEntity.description ?? '' },
    tasks: [...mainTasks, ...lowTasks],
    constraints: constraintEntities.map((ce) => ({
      id: ce.id,
      name: ce.name,
      description: ce.description ?? '',
    })),
  };
}

// ---------------------------------------------------------------------------
// recordOutcome (Phase 5)
// ---------------------------------------------------------------------------

/**
 * 実行結果を記録し、confidence を更新 + エピソードを記録 + 改善提案を適用する。
 */
export async function recordOutcome(
  input: {
    goalId: string;
    sessionId: string;
    taskResults: TaskResult[];
    improvements?: Improvement[];
  },
  deps: RecordOutcomeDeps = {},
): Promise<{ updated: number; episodeId: string | null }> {
  const database = deps.database ?? db;
  const embed = deps.embed ?? generateEmbedding;

  let updatedCount = 0;

  // 1. confidence 更新
  for (const tr of input.taskResults) {
    const [ent] = await database
      .select({ confidence: entities.confidence })
      .from(entities)
      .where(eq(entities.id, tr.taskId));
    if (!ent) continue;

    const current = (ent.confidence as number | null | undefined) ?? 0.5;
    let event: ConfidenceEvent;
    if (tr.followed && tr.succeeded) event = 'followed_success';
    else if (tr.followed && !tr.succeeded) event = 'followed_failure';
    else if (!tr.followed && tr.succeeded) event = 'ignored_success';
    else event = 'ignored_failure';

    const newConf = updateConfidence(current, event);
    await database
      .update(entities)
      .set({ confidence: newConf, freshness: new Date(), lastReferencedAt: new Date() })
      .where(eq(entities.id, tr.taskId));
    updatedCount++;
  }

  // 2. エピソード記録
  const storyLines = input.taskResults.map(
    (tr) =>
      `[task:${tr.taskId}] followed=${tr.followed}, succeeded=${tr.succeeded}${
        tr.note ? ` | ${tr.note}` : ''
      }`,
  );
  const storyContent = `goal:${input.goalId}\n${storyLines.join('\n')}`;

  let episodeId: string | null = null;
  try {
    const embedding = await embed(storyContent);
    const [episode] = await database
      .insert(vibeMemories)
      .values({
        sessionId: input.sessionId,
        content: storyContent,
        embedding,
        metadata: { goalId: input.goalId, sourceTaskIds: input.taskResults.map((t) => t.taskId) },
        memoryType: 'episode',
        episodeAt: new Date(),
        importance: 0.6,
        compressed: false,
      })
      .returning();
    episodeId = episode.id;

    // episode プロキシ entity
    const episodeEntityId = generateEntityId('episode', episode.id);
    await saveEntities(
      [
        {
          id: episodeEntityId,
          type: 'episode',
          name: `outcome:${episode.id.slice(0, 8)}`,
          description: storyContent.slice(0, 200),
          metadata: { memoryId: episode.id },
          confidence: 0.6,
          provenance: 'record_outcome',
        },
      ],
      database,
      async () => embedding,
    );

    // 各タスクに learned_from 関係を追加
    const learnedRelations = input.taskResults.map((tr) => ({
      sourceId: tr.taskId,
      targetId: episodeEntityId,
      relationType: 'learned_from',
      weight: 0.8,
    }));
    await saveRelations(learnedRelations, database);
  } catch (err) {
    console.error('Failed to record episode:', err);
  }

  // 3. 改善提案の適用
  if (input.improvements) {
    for (const imp of input.improvements) {
      switch (imp.type) {
        case 'modify_task':
          if (imp.targetTaskId) {
            await database
              .update(entities)
              .set({ description: imp.suggestion })
              .where(eq(entities.id, imp.targetTaskId));
          }
          break;
        case 'add_task': {
          const newId = generateEntityId('task', imp.suggestion);
          await saveEntities(
            [
              {
                id: newId,
                type: 'task',
                name: imp.suggestion,
                description: imp.suggestion,
                confidence: 0.3,
                provenance: 'record_outcome',
              },
            ],
            database,
            async () => await embed(imp.suggestion),
          );
          // goal → new task に has_step 関係を追加
          await saveRelations(
            [{ sourceId: input.goalId, targetId: newId, relationType: 'has_step', weight: 0.5 }],
            database,
          );
          break;
        }
        case 'add_precondition':
          if (imp.targetTaskId) {
            const newId = generateEntityId('task', imp.suggestion);
            await saveEntities(
              [
                {
                  id: newId,
                  type: 'task',
                  name: imp.suggestion,
                  description: imp.suggestion,
                  confidence: 0.3,
                  provenance: 'record_outcome',
                },
              ],
              database,
              async () => await embed(imp.suggestion),
            );
            await saveRelations(
              [
                {
                  sourceId: imp.targetTaskId,
                  targetId: newId,
                  relationType: 'precondition',
                  weight: 0.5,
                },
              ],
              database,
            );
          }
          break;
        case 'add_constraint': {
          const newId = generateEntityId('constraint', imp.suggestion);
          await saveEntities(
            [
              {
                id: newId,
                type: 'constraint',
                name: imp.suggestion,
                description: imp.suggestion,
                confidence: 0.3,
                provenance: 'record_outcome',
              },
            ],
            database,
            async () => await embed(imp.suggestion),
          );
          if (imp.targetTaskId) {
            await saveRelations(
              [
                {
                  sourceId: newId,
                  targetId: imp.targetTaskId,
                  relationType: 'prohibits',
                  weight: 0.8,
                },
              ],
              database,
            );
          }
          break;
        }
      }
    }
  }

  return { updated: updatedCount, episodeId };
}
