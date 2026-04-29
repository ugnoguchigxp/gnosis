import { asc, desc, inArray, or, sql } from 'drizzle-orm';
import { runLlmTask as defaultRunLlmTask } from '../../../adapters/llm.js';
import { config } from '../../../config.js';
import { db as defaultDb } from '../../../db/index.js';
import { entities, relations } from '../../../db/schema.js';
import type { QueueRepository } from '../queue/repository.js';
import { generateTopicStateEntityId, isKnowflowTopicSuppressed } from '../state/topicState.js';

type DatabaseLike = typeof defaultDb;

const DEFAULT_SCAN_LIMIT = 300;
const EXCLUDED_TYPES = new Set(['task_trace', 'knowflow_topic_state']);
const DEFAULT_MAX_PER_COMMUNITY = 2;
const LLM_SHORTLIST_MULTIPLIER = 4;
const LLM_SHORTLIST_MIN = 20;

type RunFrontierSelection = (
  input: {
    task: 'frontier_selection';
    context: Record<string, unknown>;
    requestId?: string;
  },
  options?: { signal?: AbortSignal },
) => Promise<{
  degraded: boolean;
  output: {
    selected: Array<{
      entityId: string;
      score: number;
      reason: string;
    }>;
  };
}>;

type EntityRow = typeof entities.$inferSelect;

export type FrontierCandidate = {
  entityId: string;
  name: string;
  type: string;
  communityId?: string;
  score: number;
  deterministicScore: number;
  importanceScore: number;
  llmScore?: number;
  llmReason?: string;
  reason: string;
  relationCount: number;
  communityRank: number;
  description?: string;
};

export type SelectFrontierOptions = {
  limit?: number;
  scanLimit?: number;
  database?: DatabaseLike;
  now?: Date;
  maxPerCommunity?: number;
  useLlm?: boolean;
  runLlmTask?: RunFrontierSelection;
  signal?: AbortSignal;
};

export type EnqueueFrontierOptions = SelectFrontierOptions & {
  queueRepository: QueueRepository;
  requestedBy?: string;
};

const isFrontierEligible = (
  entity: EntityRow,
  topicStateById: Map<string, unknown>,
  now: Date,
): boolean => {
  if (EXCLUDED_TYPES.has(entity.type)) return false;

  const topicState = topicStateById.get(generateTopicStateEntityId(entity.name));
  if (
    isKnowflowTopicSuppressed(entity.metadata, now) ||
    isKnowflowTopicSuppressed(topicState, now)
  ) {
    return false;
  }

  return true;
};

const recencyScore = (date: Date | null, now: Date): number => {
  if (!date) return 0.2;
  const ageDays = Math.max(0, (now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000));
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 0.8;
  if (ageDays <= 180) return 0.5;
  return 0.25;
};

export const getFrontierImportanceScore = (type: string): number => {
  switch (type) {
    case 'risk':
      return 1;
    case 'procedure':
      return 0.95;
    case 'rule':
    case 'constraint':
      return 0.92;
    case 'decision':
      return 0.86;
    case 'lesson':
      return 0.82;
    case 'project_doc':
      return 0.65;
    case 'observation':
      return 0.55;
    case 'concept':
      return 0.4;
    default:
      return 0.5;
  }
};

const buildReason = (entity: EntityRow, relationCount: number): string => {
  const parts: string[] = [];
  const importanceScore = getFrontierImportanceScore(entity.type);
  if (importanceScore >= 0.9) parts.push(`high-value ${entity.type}`);
  if (entity.referenceCount > 0) parts.push(`referenced ${entity.referenceCount} times`);
  if (relationCount <= 1) parts.push('sparse graph neighborhood');
  if ((entity.confidence ?? 0.5) < 0.7) parts.push('low confidence');
  if (parts.length === 0) parts.push('eligible knowledge entity');
  return parts.join(', ');
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const truncateForPrompt = (
  value: string | null | undefined,
  maxLength = 420,
): string | undefined => {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
};

const selectWithCommunityLimit = (
  ranked: FrontierCandidate[],
  limit: number,
  maxPerCommunity: number,
): FrontierCandidate[] => {
  const selected: FrontierCandidate[] = [];
  const selectedByCommunity = new Map<string, number>();
  for (const candidate of ranked) {
    const communityKey = candidate.communityId ?? '__none__';
    const currentCount = selectedByCommunity.get(communityKey) ?? 0;
    if (currentCount >= maxPerCommunity) continue;
    selectedByCommunity.set(communityKey, currentCount + 1);
    selected.push({ ...candidate, communityRank: currentCount + 1 });
    if (selected.length >= limit) break;
  }
  return selected;
};

export const rerankFrontierCandidatesWithLlm = async (
  candidates: FrontierCandidate[],
  input: {
    limit: number;
    runLlmTask?: RunFrontierSelection;
    signal?: AbortSignal;
  },
): Promise<FrontierCandidate[]> => {
  if (candidates.length === 0) return [];

  const runLlmTask = input.runLlmTask ?? defaultRunLlmTask;
  const result = await runLlmTask(
    {
      task: 'frontier_selection',
      requestId: `frontier-${Date.now()}`,
      context: {
        maxTopics: input.limit,
        criteria: [
          'prioritize reusable rules, procedures, risks, decisions, lessons, and constraints',
          'prefer important but under-connected graph entities',
          'prefer entities whose uncertainty or sparse relations suggest useful follow-up research',
          'avoid broad generic concepts unless they are actionable',
        ],
        candidates: candidates.map((candidate) => ({
          entityId: candidate.entityId,
          name: candidate.name,
          type: candidate.type,
          score: candidate.score,
          deterministicScore: candidate.deterministicScore,
          importanceScore: candidate.importanceScore,
          relationCount: candidate.relationCount,
          reason: candidate.reason,
          description: candidate.description,
        })),
      },
    },
    { signal: input.signal },
  );

  if (result.degraded || result.output.selected.length === 0) {
    return candidates;
  }

  const byId = new Map(candidates.map((candidate) => [candidate.entityId, candidate]));
  const selectedIds = new Set<string>();
  const reranked: FrontierCandidate[] = [];

  for (const item of result.output.selected) {
    const candidate = byId.get(item.entityId);
    if (!candidate || selectedIds.has(item.entityId)) continue;
    selectedIds.add(item.entityId);
    const llmScore = clamp01(item.score);
    reranked.push({
      ...candidate,
      llmScore,
      llmReason: item.reason,
      score: Number((llmScore * 0.6 + candidate.deterministicScore * 0.4).toFixed(4)),
      reason: `${candidate.reason}; LLM: ${item.reason}`,
    });
  }

  for (const candidate of candidates) {
    if (!selectedIds.has(candidate.entityId)) {
      reranked.push(candidate);
    }
  }

  return reranked.sort((left, right) => right.score - left.score);
};

export const selectFrontierCandidates = async (
  options: SelectFrontierOptions = {},
): Promise<FrontierCandidate[]> => {
  const database = options.database ?? defaultDb;
  const limit = Math.max(1, Math.trunc(options.limit ?? 5));
  const scanLimit = Math.max(limit, Math.trunc(options.scanLimit ?? DEFAULT_SCAN_LIMIT));
  const maxPerCommunity = Math.max(
    1,
    Math.trunc(options.maxPerCommunity ?? DEFAULT_MAX_PER_COMMUNITY),
  );
  const now = options.now ?? new Date();
  const useLlm = options.useLlm ?? config.knowflow.frontier.llmEnabled;

  const rows = await database
    .select()
    .from(entities)
    .orderBy(desc(entities.referenceCount), desc(entities.lastReferencedAt), asc(entities.name))
    .limit(scanLimit);

  if (rows.length === 0) return [];

  const entityIds = rows.map((row) => row.id);
  const topicStateIds = rows.map((row) => generateTopicStateEntityId(row.name));
  const relationRows = await database
    .select({
      sourceId: relations.sourceId,
      targetId: relations.targetId,
    })
    .from(relations)
    .where(or(inArray(relations.sourceId, entityIds), inArray(relations.targetId, entityIds)));
  const topicStateRows = await database
    .select({
      id: entities.id,
      metadata: entities.metadata,
    })
    .from(entities)
    .where(inArray(entities.id, [...new Set(topicStateIds)]));
  const topicStateById = new Map<string, unknown>();
  for (const row of topicStateRows) {
    topicStateById.set(row.id, row.metadata);
  }

  const relationCounts = new Map<string, number>();
  for (const relation of relationRows) {
    relationCounts.set(relation.sourceId, (relationCounts.get(relation.sourceId) ?? 0) + 1);
    relationCounts.set(relation.targetId, (relationCounts.get(relation.targetId) ?? 0) + 1);
  }

  const ranked: FrontierCandidate[] = rows
    .filter((entity) => isFrontierEligible(entity, topicStateById, now))
    .map((entity) => {
      const relationCount = relationCounts.get(entity.id) ?? 0;
      const referenceScore = Math.min(1, entity.referenceCount / 5);
      const sparseGraphScore = relationCount === 0 ? 1 : relationCount === 1 ? 0.7 : 0.2;
      const confidenceGap = 1 - Math.max(0, Math.min(1, entity.confidence ?? 0.5));
      const importanceScore = getFrontierImportanceScore(entity.type);
      const score =
        referenceScore * 0.35 +
        sparseGraphScore * 0.24 +
        importanceScore * 0.22 +
        recencyScore(entity.lastReferencedAt ?? entity.createdAt, now) * 0.12 +
        confidenceGap * 0.07;
      const deterministicScore = Number(clamp01(score).toFixed(4));

      return {
        entityId: entity.id,
        name: entity.name,
        type: entity.type,
        communityId: entity.communityId ?? undefined,
        score: deterministicScore,
        deterministicScore,
        importanceScore,
        reason: buildReason(entity, relationCount),
        relationCount,
        communityRank: 0,
        description: truncateForPrompt(entity.description),
      };
    })
    .sort((left, right) => right.score - left.score);

  const shortlistLimit = Math.min(
    ranked.length,
    Math.max(LLM_SHORTLIST_MIN, limit * LLM_SHORTLIST_MULTIPLIER),
  );
  let finalRanked: FrontierCandidate[] = ranked;
  if (useLlm && shortlistLimit > 0) {
    try {
      finalRanked = await rerankFrontierCandidatesWithLlm(ranked.slice(0, shortlistLimit), {
        limit,
        runLlmTask: options.runLlmTask,
        signal: options.signal,
      });
    } catch {
      finalRanked = ranked;
    }
  }

  return selectWithCommunityLimit(finalRanked, limit, maxPerCommunity);
};

export const enqueueFrontierCandidates = async (
  options: EnqueueFrontierOptions,
): Promise<{
  candidates: FrontierCandidate[];
  enqueued: number;
  deduped: number;
}> => {
  const candidates = await selectFrontierCandidates(options);
  let enqueued = 0;
  let deduped = 0;

  for (const candidate of candidates) {
    const stateId = generateTopicStateEntityId(candidate.name);
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const result = await options.queueRepository.enqueue({
      topic: candidate.name,
      mode: 'explore',
      source: 'cron',
      priority: Math.max(1, Math.round(candidate.score * 100)),
      requestedBy: options.requestedBy ?? 'knowflow-frontier',
      sourceGroup: stateId,
      expansion: {
        seedEntityId: candidate.entityId,
        seedCommunityId: candidate.communityId,
        expansionAxis: 'frontier',
        whyResearch: candidate.reason,
      },
    });

    if (result.deduped) {
      deduped += 1;
    } else {
      enqueued += 1;
    }

    await (options.database ?? defaultDb)
      .insert(entities)
      .values({
        id: stateId,
        type: 'knowflow_topic_state',
        name: candidate.name,
        description: `KnowFlow frontier topic selected from ${candidate.type} ${candidate.entityId}: ${candidate.reason}`,
        communityId: candidate.communityId,
        metadata: {
          kind: 'knowflow_frontier_topic',
          source: 'knowflow',
          seedEntityId: candidate.entityId,
          reason: candidate.reason,
          score: candidate.score,
          communityRank: candidate.communityRank,
          knowflowStatus: 'queued',
          lastKnowflowQueuedAt: nowIso,
          lastKnowflowTaskId: result.task.id,
        },
        confidence: Math.max(0.1, Math.min(1, candidate.score)),
        provenance: 'knowflow',
        scope: 'on_demand',
        freshness: now,
      })
      .onConflictDoUpdate({
        target: entities.id,
        set: {
          description: sql`excluded.description`,
          communityId: sql`COALESCE(${entities.communityId}, excluded.community_id)`,
          metadata: sql`${entities.metadata} || excluded.metadata`,
          confidence: sql`GREATEST(COALESCE(${entities.confidence}, 0), excluded.confidence)`,
          provenance: sql`excluded.provenance`,
          freshness: sql`excluded.freshness`,
        },
      });

    if (candidate.entityId !== stateId) {
      await (options.database ?? defaultDb)
        .insert(relations)
        .values({
          sourceId: candidate.entityId,
          targetId: stateId,
          relationType: 'expands',
          weight: candidate.score,
          confidence: candidate.score,
          sourceTask: result.task.id,
          provenance: 'knowflow',
        })
        .onConflictDoNothing();
    }
  }

  return { candidates, enqueued, deduped };
};
