import { spawn } from 'node:child_process';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { vibeMemories } from '../db/schema.js';

type DbClient = Pick<typeof db, 'insert' | 'select'>;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const runEmbedCommand = (
  command: string,
  text: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [text], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settleResolve = (value: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settleReject(new Error(`Embedding command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      settleReject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        settleReject(new Error(`Embedding command failed: ${detail}`));
        return;
      }

      settleResolve({ stdout, stderr });
    });
  });

const parseEmbeddingVector = (output: string): number[] => {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    throw new Error('Embedding command returned empty output.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `Failed to parse embedding JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Embedding output must be a JSON array.');
  }

  const vector = parsed.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Embedding element at index ${index} is not a finite number.`);
    }
    return value;
  });

  if (vector.length !== config.embeddingDimension) {
    throw new Error(
      `Embedding dimension mismatch: expected=${config.embeddingDimension}, actual=${vector.length}`,
    );
  }

  return vector;
};

/**
 * テキストからベクトルを生成します
 * ユーザー環境の埋め込みコマンドを利用します
 */
export async function generateEmbedding(text: string, retries = 3): Promise<number[]> {
  let lastError: unknown;

  for (let i = 0; i < retries; i++) {
    try {
      const { stdout } = await runEmbedCommand(config.embedCommand, text, config.embedTimeoutMs);
      return parseEmbeddingVector(stdout);
    } catch (error) {
      lastError = error;
      if (i === retries - 1) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Embedding generation failed after ${retries} retries: ${message}`);
      }
      await wait(1000 * (i + 1));
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : `Unknown error: ${String(lastError)}`;
  throw new Error(`Embedding generation failed: ${message}`);
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

  if (results.length > 0) {
    const resultIds = results.map((r) => r.id);
    // 参照実績の更新 (バックグラウンドで実行しても良いが、一旦同期的に行う)
    await db
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
