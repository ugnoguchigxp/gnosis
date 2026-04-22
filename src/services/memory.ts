import { desc, eq, inArray, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { vibeMemories } from '../db/schema.js';
import { GnosisError } from '../domain/errors.js';
import { VibeMemoryInputSchema } from '../domain/schemas.js';
import { sleep } from '../utils/time.js';

type DbClient = Pick<typeof db, 'insert' | 'select' | 'update' | 'delete'>;

import { runLlmProcess } from './llm/spawnControl.js';

const runEmbedCommand = async (
  command: string,
  text: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> => {
  const result = await runLlmProcess(command, ['--', text], {
    timeout: timeoutMs,
  });
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr };
};

const parseEmbeddingVector = (output: string): number[] => {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    throw new GnosisError('Embedding command returned empty output.', 'EMBED_EMPTY');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new GnosisError(
      `Failed to parse embedding JSON: ${error instanceof Error ? error.message : String(error)}`,
      'EMBED_PARSE',
    );
  }

  if (!Array.isArray(parsed)) {
    throw new GnosisError('Embedding output must be a JSON array.', 'EMBED_FORMAT');
  }

  const vector = parsed.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new GnosisError(
        `Embedding element at index ${index} is not a finite number.`,
        'EMBED_FORMAT',
      );
    }
    return value;
  });

  if (vector.length !== config.embeddingDimension) {
    throw new GnosisError(
      `Embedding dimension mismatch: expected=${config.embeddingDimension}, actual=${vector.length}`,
      'EMBED_DIM',
    );
  }

  return vector;
};

import { withGlobalSemaphore } from '../utils/lock.js';

/**
 * テキストからベクトルを生成します
 * ユーザー環境の埋め込みコマンドを利用します
 */
export async function generateEmbedding(
  text: string,
  retries = config.memory.retries,
): Promise<number[]> {
  let lastError: unknown;

  for (let i = 0; i < retries; i++) {
    try {
      // システム全体の重い処理（LLM/Embedding）の並行実行を制限
      return await withGlobalSemaphore('llm-pool', config.llm.concurrencyLimit, async () => {
        const { stdout } = await runEmbedCommand(config.embedCommand, text, config.embedTimeoutMs);
        return parseEmbeddingVector(stdout);
      });
    } catch (error) {
      lastError = error;
      if (i === retries - 1) {
        const message = error instanceof Error ? error.message : String(error);
        throw new GnosisError(
          `Embedding generation failed after ${retries} retries: ${message}`,
          'EMBED_FAILED',
        );
      }
      await sleep(config.memory.retryWaitMultiplier * (i + 1));
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : `Unknown error: ${String(lastError)}`;
  throw new GnosisError(`Embedding generation failed: ${message}`, 'EMBED_FAILED');
}
/**
 * メモリを保存します
 */
export async function saveMemory(
  sessionId: string,
  content: string,
  metadata: Record<string, unknown> = {},
  database: DbClient = db,
) {
  VibeMemoryInputSchema.parse({ sessionId, content, metadata });
  const embedding = await generateEmbedding(content);

  const [memory] = await database
    .insert(vibeMemories)
    .values({
      sessionId,
      content,
      embedding,
      metadata,
    })
    .returning();

  return memory;
}

/**
 * エピソード記憶（ストーリー化済みメモ）を保存します。
 * memory_type, importance, episodeAt などの Phase 2 追加フィールドに対応します。
 */
export async function saveEpisodeMemory(
  input: {
    sessionId: string;
    content: string;
    metadata?: Record<string, unknown>;
    memoryType?: 'raw' | 'episode';
    episodeAt?: Date;
    sourceTask?: string;
    importance?: number;
    compressed?: boolean;
  },
  database: DbClient = db,
) {
  const embedding = await generateEmbedding(input.content);

  const [memory] = await database
    .insert(vibeMemories)
    .values({
      sessionId: input.sessionId,
      content: input.content,
      embedding,
      metadata: input.metadata ?? {},
      memoryType: input.memoryType ?? 'raw',
      episodeAt: input.episodeAt,
      sourceTask: input.sourceTask,
      importance: input.importance ?? 0.5,
      compressed: input.compressed ?? false,
    })
    .returning();

  return memory;
}

/**
 * セマンティック検索を実行して類似するメモリを取得します
 */
/**
 * 特定のメモリ種別でセマンティック検索を実行します（セッション横断可）
 */
export async function searchMemoriesByType(
  query: string,
  memoryType: 'raw' | 'episode',
  limit = 5,
  database: DbClient = db,
) {
  const embedding = await generateEmbedding(query);
  const embeddingStr = JSON.stringify(embedding);
  const similarity = sql`1 - (${vibeMemories.embedding} <=> ${embeddingStr}::vector)`;

  const results = await database
    .select({
      id: vibeMemories.id,
      content: vibeMemories.content,
      metadata: vibeMemories.metadata,
      createdAt: vibeMemories.createdAt,
      sessionId: vibeMemories.sessionId,
      similarity: similarity.mapWith(Number),
    })
    .from(vibeMemories)
    .where(eq(vibeMemories.memoryType, memoryType))
    .orderBy((fields) => desc(fields.similarity))
    .limit(limit);

  return results;
}

export async function searchMemory(
  sessionId: string,
  query: string,
  limit = 5,
  filter?: Record<string, unknown>,
  database: DbClient = db,
) {
  const embedding = await generateEmbedding(query);
  const embeddingStr = JSON.stringify(embedding);

  // コサイン類似度 (pgvector の '<=>' 演算子を利用) を使用して近傍検索を行います
  // similarity = 1 - (embedding <=> target), ASCソートで最も近いものを取得
  const similarity = sql`1 - (${vibeMemories.embedding} <=> ${embeddingStr}::vector)`;

  const whereClause =
    filter && Object.keys(filter).length > 0
      ? sql`${vibeMemories.sessionId} = ${sessionId} AND ${
          vibeMemories.metadata
        } @> ${JSON.stringify(filter)}::jsonb`
      : sql`${vibeMemories.sessionId} = ${sessionId}`;

  const results = await database
    .select({
      id: vibeMemories.id,
      content: vibeMemories.content,
      metadata: vibeMemories.metadata,
      createdAt: vibeMemories.createdAt,
      similarity: similarity,
    })
    .from(vibeMemories)
    .where(whereClause)
    .orderBy((fields) => desc(fields.similarity))
    .limit(limit);

  if (results.length > 0) {
    const resultIds = results.map((r) => r.id);
    // 参照実績の更新 (バックグラウンドで実行しても良いが、一旦同期的に行う)
    await database
      .update(vibeMemories)
      .set({
        referenceCount: sql`${vibeMemories.referenceCount} + 1`,
        lastReferencedAt: new Date(),
      })
      .where(inArray(vibeMemories.id, resultIds));
  }

  return results;
}

/**
 * メタデータ条件でメモリを一覧取得します（埋め込み生成は行いません）。
 */
export async function listMemoriesByMetadata(
  sessionId: string,
  filter: Record<string, unknown>,
  limit = 5,
  options: {
    sortByPriority?: boolean;
  } = {},
  database: DbClient = db,
) {
  const safeLimit = Math.max(1, Math.trunc(limit));
  const whereClause =
    filter && Object.keys(filter).length > 0
      ? sql`${vibeMemories.sessionId} = ${sessionId} AND ${
          vibeMemories.metadata
        } @> ${JSON.stringify(filter)}::jsonb`
      : sql`${vibeMemories.sessionId} = ${sessionId}`;

  const orderByClause = options.sortByPriority
    ? [
        sql`COALESCE((${vibeMemories.metadata}->>'priority')::double precision, 0) DESC`,
        desc(vibeMemories.createdAt),
      ]
    : [desc(vibeMemories.createdAt)];

  const results = await database
    .select({
      id: vibeMemories.id,
      content: vibeMemories.content,
      metadata: vibeMemories.metadata,
      createdAt: vibeMemories.createdAt,
    })
    .from(vibeMemories)
    .where(whereClause)
    .orderBy(...orderByClause)
    .limit(safeLimit);

  if (results.length > 0) {
    const resultIds = results.map((r) => r.id);
    await database
      .update(vibeMemories)
      .set({
        referenceCount: sql`${vibeMemories.referenceCount} + 1`,
        lastReferencedAt: new Date(),
      })
      .where(inArray(vibeMemories.id, resultIds));
  }

  return results;
}

/**
 * メモリを削除します
 */
export async function deleteMemory(memoryId: string, database: Pick<typeof db, 'delete'> = db) {
  await database.delete(vibeMemories).where(eq(vibeMemories.id, memoryId));
}
