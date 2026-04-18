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

export type QueryProcedureOptions = {
  context?: string;
  project?: string;
  domains?: string[];
  languages?: string[];
  frameworks?: string[];
  environment?: string;
  repo?: string;
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
  episodes: Array<{ id: string; story: string; isSuccess: boolean }>;
  isGoldenPath: boolean;
};

type ProcedureConstraint = {
  id: string;
  name: string;
  description: string;
  severity: 'warning' | 'info';
};

export type ProcedureResult = {
  goal: { id: string; name: string; description: string };
  tasks: ProcedureTask[];
  constraints: ProcedureConstraint[];
};

type NormalizedApplicabilityFilters = {
  projects: string[];
  domains: string[];
  languages: string[];
  frameworks: string[];
  environments: string[];
  repos: string[];
};

const normalizeToken = (value: string): string => value.trim().toLowerCase();

const normalizeFilterList = (values?: string[]): string[] =>
  (values ?? []).map(normalizeToken).filter((v) => v.length > 0);

function resolveProcedureOptions(contextOrOptions?: string | QueryProcedureOptions): {
  contextText?: string;
  filters: NormalizedApplicabilityFilters;
} {
  const options: QueryProcedureOptions =
    typeof contextOrOptions === 'string' || contextOrOptions === undefined
      ? { context: contextOrOptions }
      : contextOrOptions;

  return {
    contextText: options.context,
    filters: {
      projects: normalizeFilterList(options.project ? [options.project] : undefined),
      domains: normalizeFilterList(options.domains),
      languages: normalizeFilterList(options.languages),
      frameworks: normalizeFilterList(options.frameworks),
      environments: normalizeFilterList(options.environment ? [options.environment] : undefined),
      repos: normalizeFilterList(options.repo ? [options.repo] : undefined),
    },
  };
}

const hasApplicabilityFilters = (filters: NormalizedApplicabilityFilters): boolean =>
  filters.projects.length > 0 ||
  filters.domains.length > 0 ||
  filters.languages.length > 0 ||
  filters.frameworks.length > 0 ||
  filters.environments.length > 0 ||
  filters.repos.length > 0;

const normalizeMetadataList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? normalizeToken(item) : ''))
    .filter((v) => v.length > 0);
};

function matchesApplicabilityFilter(
  metadata: unknown,
  filters: NormalizedApplicabilityFilters,
): { matched: boolean; reason?: string } {
  if (!hasApplicabilityFilters(filters)) return { matched: true };
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return { matched: true };

  const applicability = (metadata as { applicability?: unknown }).applicability;
  if (!applicability || typeof applicability !== 'object' || Array.isArray(applicability)) {
    return { matched: true };
  }

  const app = applicability as Record<string, unknown>;
  const checks: Array<{ key: keyof NormalizedApplicabilityFilters; metadataKey: string }> = [
    { key: 'projects', metadataKey: 'projects' },
    { key: 'domains', metadataKey: 'domains' },
    { key: 'languages', metadataKey: 'languages' },
    { key: 'frameworks', metadataKey: 'frameworks' },
    { key: 'environments', metadataKey: 'environments' },
    { key: 'repos', metadataKey: 'repos' },
  ];

  for (const { key, metadataKey } of checks) {
    const requested = filters[key];
    if (requested.length === 0) continue;
    const candidate = normalizeMetadataList(app[metadataKey]);
    if (candidate.length === 0) continue; // 未指定は「広く適用可能」とみなす
    const hasIntersection = requested.some((value) => candidate.includes(value));
    if (!hasIntersection) {
      return { matched: false, reason: `applicability.${metadataKey} mismatch` };
    }
  }

  return { matched: true };
}

/**
 * goal テキストから関連する task / constraint / episode を取得し、
 * 成功確率（Confidence）に基づいて重み付けされた手続き記憶を返す。
 */
export async function queryProcedure(
  goalText: string,
  contextOrOptions?: string | QueryProcedureOptions,
  deps: QueryProcedureDeps = {},
): Promise<ProcedureResult | null> {
  const database = deps.database ?? db;
  const embed = deps.embed ?? generateEmbedding;
  const { contextText, filters } = resolveProcedureOptions(contextOrOptions);

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
  let taskEntities =
    filteredTaskIds.length > 0
      ? await database.select().from(entities).where(inArray(entities.id, filteredTaskIds))
      : [];

  if (hasApplicabilityFilters(filters)) {
    taskEntities = taskEntities.filter((task) => {
      const matched = matchesApplicabilityFilter(task.metadata, filters);
      if (!matched.matched) {
        console.debug(
          `[queryProcedure] task filtered out id=${task.id} name=${task.name} reason=${
            matched.reason ?? 'unknown'
          }`,
        );
      }
      return matched.matched;
    });
    filteredTaskIds = taskEntities.map((task) => task.id);
  }

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
  const episodeInfos = new Map<string, { story: string; isSuccess: boolean }>();
  for (const ep of episodeEntities) {
    const memoryId = (ep.metadata as Record<string, unknown>)?.memoryId as string | undefined;
    if (memoryId) {
      const [mem] = await database
        .select({ content: vibeMemories.content, metadata: vibeMemories.metadata })
        .from(vibeMemories)
        .where(eq(vibeMemories.id, memoryId));
      if (mem) {
        // メタデータまたは内容から成否を判定
        const isSuccess = (mem.metadata as any)?.succeeded === true || mem.content.includes('succeeded=true');
        episodeInfos.set(ep.id, { story: mem.content, isSuccess });
      }
    } else {
      episodeInfos.set(ep.id, { story: ep.description ?? '', isSuccess: true });
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
    const episodes = taskEpisodeIds.map((epId) => {
      const info = episodeInfos.get(epId);
      return {
        id: epId,
        story: info?.story ?? '',
        isSuccess: info?.isSuccess ?? true,
      };
    });

    return {
      id: te.id,
      name: te.name,
      description: te.description ?? '',
      confidence: conf,
      order: orderMap.get(te.id) ?? 999,
      episodes,
      isGoldenPath: conf >= 0.7,
    };
  });

  // Confidence スコアに基づく最終分類・ソート
  const highConfidenceTasks = tasks.filter((t) => t.confidence >= 0.7).sort((a, b) => a.order - b.order);
  const normalTasks = tasks.filter((t) => t.confidence >= 0.3 && t.confidence < 0.7).sort((a, b) => a.order - b.order);
  const lowConfidenceTasks = tasks.filter((t) => t.confidence < 0.3).map((t) => ({ ...t, order: 9999 }));

  return {
    goal: { id: goalEntity.id, name: goalEntity.name, description: goalEntity.description ?? '' },
    tasks: [...highConfidenceTasks, ...normalTasks, ...lowConfidenceTasks],
    constraints: constraintEntities.map((ce) => ({
      id: ce.id,
      name: ce.name,
      description: ce.description ?? '',
      severity: (ce.confidence ?? 1.0) < 0.3 ? 'warning' : 'info',
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
        sourceTask: input.goalId,
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
