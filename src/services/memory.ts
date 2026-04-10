import { $ } from 'bun';
import { desc, eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { vibeMemories } from '../db/schema.js';

type DbClient = Pick<typeof db, 'insert' | 'select'>;

/**
 * テキストからベクトルを生成します
 * ユーザー環境の埋め込みコマンドを利用します
 */
export async function generateEmbedding(text: string, retries = 3): Promise<number[]> {
  const embedCmd = config.embedCommand;
  for (let i = 0; i < retries; i++) {
    try {
      const result = await $`${embedCmd} ${text}`.text();
      const vector = JSON.parse(result.trim());
      if (!Array.isArray(vector)) throw new Error('Invalid format');
      return vector;
    } catch (error) {
      if (i === retries - 1) {
        console.error('Failed to generate embedding:', error);
        throw new Error('Embedding generation failed after retries');
      }
      await new Promise((r) => setTimeout(r, 1000 * (i + 1))); // Exponential backoff
    }
  }
  throw new Error('Embedding generation failed');
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
 * セマンティック検索を実行して類似するメモリを取得します
 */
export async function searchMemory(
  sessionId: string,
  query: string,
  limit = 5,
  filter?: Record<string, unknown>,
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

  const results = await db
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

  return results;
}

/**
 * メモリを削除します
 */
export async function deleteMemory(memoryId: string, database: Pick<typeof db, 'delete'> = db) {
  await database.delete(vibeMemories).where(eq(vibeMemories.id, memoryId));
}
