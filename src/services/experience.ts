import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { experienceLogs } from '../db/schema.js';
import { generateEmbedding } from './memory.js';

export interface ExperienceInput {
  sessionId: string;
  scenarioId: string;
  attempt: number;
  type: 'failure' | 'success';
  content: string;
  failureType?: string;
  metadata?: Record<string, unknown>;
}

interface FailureWithSimilarity {
  id: string;
  scenarioId: string;
  content: string;
  failureType: string | null;
  metadata: unknown;
  similarity: number;
}

interface Solution {
  id: string;
  content: string;
  metadata: unknown;
  createdAt: Date;
}

export interface ExperienceLesson {
  failure: FailureWithSimilarity;
  solutions: Solution[];
}

/**
 * 経験（失敗または成功イベント）を保存します。
 */
export async function saveExperience(input: ExperienceInput) {
  const embedding = await generateEmbedding(input.content);

  const [experience] = await db
    .insert(experienceLogs)
    .values({
      sessionId: input.sessionId,
      scenarioId: input.scenarioId,
      attempt: input.attempt,
      type: input.type,
      failureType: input.failureType,
      content: input.content,
      embedding: embedding,
      metadata: input.metadata || {},
    })
    .returning();

  return experience;
}

/**
 * 類似する失敗事例とその解決策（成功パッチ）を検索します。
 */
export async function recallExperienceLessons(
  sessionId: string,
  query: string,
  limit = 5,
): Promise<ExperienceLesson[]> {
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
  const embedding = await generateEmbedding(query);
  const embeddingStr = JSON.stringify(embedding);

  const similarity = sql<number>`1 - (${experienceLogs.embedding} <=> ${embeddingStr}::vector)`;

  // 1. クエリに類似する「失敗」イベントを検索
  const similarFailures: FailureWithSimilarity[] = await db
    .select({
      id: experienceLogs.id,
      scenarioId: experienceLogs.scenarioId,
      content: experienceLogs.content,
      failureType: experienceLogs.failureType,
      metadata: experienceLogs.metadata,
      similarity,
    })
    .from(experienceLogs)
    .where(and(eq(experienceLogs.sessionId, sessionId), eq(experienceLogs.type, 'failure')))
    .orderBy(desc(similarity))
    .limit(normalizedLimit);

  if (similarFailures.length === 0) return [];

  // 2. 検索された失敗に関連する「成功（解決策）」を紐付ける
  const lessons = await Promise.all(
    similarFailures.map(async (fail) => {
      // 同一シナリオ内での成功事例を探す
      // (将来的にはより明示的に linkedFailureIds メタデータなどで検索可能にする)
      const solutions: Solution[] = await db
        .select({
          id: experienceLogs.id,
          content: experienceLogs.content,
          metadata: experienceLogs.metadata,
          createdAt: experienceLogs.createdAt,
        })
        .from(experienceLogs)
        .where(
          and(
            eq(experienceLogs.sessionId, sessionId),
            eq(experienceLogs.scenarioId, fail.scenarioId),
            eq(experienceLogs.type, 'success'),
          ),
        )
        .orderBy(desc(experienceLogs.createdAt));

      return {
        failure: fail,
        solutions,
      };
    }),
  );

  return lessons;
}
