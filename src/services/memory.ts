import { desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { vibeMemories } from '../db/schema.js';
import { $ } from 'bun';

/**
 * テキストから 384次元のベクトルを生成します
 * ユーザー環境の `../embedding` で提供されている `~/.local/bin/embed` コマンドを利用します
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    // ~/.local/bin/embed が使える前提。失敗した場合はパス変更を検討してください。
    // \`embed\` は JSON 配列を出力するためテキストとして取得してパースします
    const result = await $`~/.local/bin/embed ${text}`.text();
    return JSON.parse(result.trim());
  } catch (error) {
    console.error('Failed to generate embedding:', error);
    throw new Error('Embedding generation failed');
  }
}

/**
 * メモリを保存します
 */
export async function saveMemory(
  sessionId: string,
  content: string,
  metadata: Record<string, unknown> = {},
) {
  const embedding = await generateEmbedding(content);

  const [memory] = await db
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
export async function searchMemory(sessionId: string, query: string, limit = 5) {
  const embedding = await generateEmbedding(query);
  const embeddingStr = JSON.stringify(embedding);

  // コサイン類似度 (pgvector の '<=>' 演算子を利用) を使用して近傍検索を行います
  // similarity = 1 - (embedding <=> target), ASCソートで最も近いものを取得
  const similarity = sql`1 - (${vibeMemories.embedding} <=> ${embeddingStr}::vector)`;

  const results = await db
    .select({
      id: vibeMemories.id,
      content: vibeMemories.content,
      metadata: vibeMemories.metadata,
      createdAt: vibeMemories.createdAt,
      similarity: similarity,
    })
    .from(vibeMemories)
    .where(sql`${vibeMemories.sessionId} = ${sessionId}`)
    .orderBy((fields) => desc(fields.similarity))
    .limit(limit);

  return results;
}
