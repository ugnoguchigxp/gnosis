import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { vibeMemories } from '../db/schema.js';
import { GnosisError } from '../domain/errors.js';
import { VibeMemoryInputSchema } from '../domain/schemas.js';
import { withGlobalSemaphore } from '../utils/lock.js';
import { sleep } from '../utils/time.js';

type DbClient = Pick<typeof db, 'insert' | 'select' | 'update' | 'delete'>;

export type EmbeddingTextType = 'query' | 'passage';
export type EmbeddingPriority = 'high' | 'normal' | 'low';

export type GenerateEmbeddingOptions = {
  type?: EmbeddingTextType;
  priority?: EmbeddingPriority;
  timeoutMs?: number;
};

const prioritySemaphoreName = (priority: EmbeddingPriority): string =>
  priority === 'high'
    ? 'embedding-high-pool'
    : priority === 'low'
      ? 'embedding-background-pool'
      : 'embedding-normal-pool';

const priorityConcurrency = (priority: EmbeddingPriority): number => {
  const embeddingConfig = config.embedding;
  if (priority === 'high') return embeddingConfig?.highConcurrency ?? 8;
  if (priority === 'low') return embeddingConfig?.backgroundConcurrency ?? 1;
  return embeddingConfig?.normalConcurrency ?? 2;
};

const backgroundChunkSize = (): number => config.embedding?.backgroundChunkSize ?? 8;

const normalizeEmbeddingOptions = (
  options: GenerateEmbeddingOptions = {},
): Required<GenerateEmbeddingOptions> => ({
  type: options.type ?? 'passage',
  priority: options.priority ?? 'normal',
  timeoutMs: options.timeoutMs ?? config.embedTimeoutMs,
});

const runCommand = async (
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Embedding command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || `Embedding command exited with status ${code}`));
    });
  });

const runEmbedCommand = async (
  command: string,
  text: string,
  type: EmbeddingTextType,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> =>
  runCommand(command, ['--type', type, '--', text], timeoutMs);

const resolveBatchEmbedCommand = (): string | undefined => {
  const candidate = path.join(path.dirname(config.embedCommand), 'e5embed');
  return existsSync(candidate) ? candidate : undefined;
};

const runBatchEmbedCommand = async (
  texts: string[],
  type: EmbeddingTextType,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> => {
  const batchCommand = resolveBatchEmbedCommand();
  if (!batchCommand) {
    const rows: number[][] = [];
    for (const text of texts) {
      const { stdout } = await runEmbedCommand(config.embedCommand, text, type, timeoutMs);
      rows.push(parseEmbeddingVectorFromJson(JSON.parse(stdout.trim())));
    }
    return { stdout: JSON.stringify(rows), stderr: '' };
  }

  return runCommand(
    batchCommand,
    ['--type', type, ...texts.flatMap((text) => ['--text', text])],
    timeoutMs,
  );
};

const parseEmbeddingVectorFromJson = (parsed: unknown): number[] => {
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

  return parseEmbeddingVectorFromJson(parsed);
};

const parseEmbeddingBatch = (output: string): number[][] => {
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
    throw new GnosisError('Embedding batch output must be a JSON array.', 'EMBED_FORMAT');
  }

  return parsed.map((item) => {
    if (item && typeof item === 'object' && !Array.isArray(item) && 'embedding' in item) {
      return parseEmbeddingVectorFromJson((item as { embedding: unknown }).embedding);
    }
    return parseEmbeddingVectorFromJson(item);
  });
};

const requestDaemonEmbeddings = async (
  texts: string[],
  options: Required<GenerateEmbeddingOptions>,
): Promise<number[][] | undefined> => {
  const daemonUrl = config.embedding?.daemonUrl;
  if (!daemonUrl) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.embedding?.daemonTimeoutMs ?? options.timeoutMs,
  );

  try {
    const response = await fetch(new URL('/embed', daemonUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        texts,
        type: options.type,
        priority: options.priority,
        normalize: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Embedding daemon HTTP ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as { embeddings?: unknown };
    if (!Array.isArray(payload.embeddings)) {
      throw new GnosisError('Embedding daemon response missing embeddings.', 'EMBED_FORMAT');
    }
    return payload.embeddings.map(parseEmbeddingVectorFromJson);
  } finally {
    clearTimeout(timeout);
  }
};

async function generateEmbeddingsWithoutSemaphore(
  texts: string[],
  options: Required<GenerateEmbeddingOptions>,
): Promise<number[][]> {
  try {
    const daemonResult = await requestDaemonEmbeddings(texts, options);
    if (daemonResult) return daemonResult;
  } catch (error) {
    console.error(
      `[Embedding] daemon unavailable; falling back to CLI (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }

  if (texts.length === 1) {
    const { stdout } = await runEmbedCommand(
      config.embedCommand,
      texts[0] ?? '',
      options.type,
      options.timeoutMs,
    );
    return [parseEmbeddingVector(stdout)];
  }

  const { stdout } = await runBatchEmbedCommand(texts, options.type, options.timeoutMs);
  return parseEmbeddingBatch(stdout);
}

async function generateEmbeddingsOnce(
  texts: string[],
  options: Required<GenerateEmbeddingOptions>,
): Promise<number[][]> {
  return await withGlobalSemaphore(
    prioritySemaphoreName(options.priority),
    priorityConcurrency(options.priority),
    async () => {
      if (options.priority === 'low' && texts.length > backgroundChunkSize()) {
        const embeddings: number[][] = [];
        const chunkSize = backgroundChunkSize();
        for (let index = 0; index < texts.length; index += chunkSize) {
          const chunk = texts.slice(index, index + chunkSize);
          const chunkEmbeddings = await generateEmbeddingsWithoutSemaphore(chunk, options);
          embeddings.push(...chunkEmbeddings);
        }
        return embeddings;
      }

      return generateEmbeddingsWithoutSemaphore(texts, options);
    },
    options.timeoutMs,
  );
}

export async function generateEmbeddings(
  texts: string[],
  options: GenerateEmbeddingOptions = {},
  retries = config.memory.retries,
): Promise<number[][]> {
  const cleanTexts = texts.map((text) => text.trim());
  if (cleanTexts.length === 0) return [];
  const emptyIndex = cleanTexts.findIndex((text) => text.length === 0);
  if (emptyIndex >= 0) {
    throw new GnosisError(`Embedding text at index ${emptyIndex} is empty.`, 'EMBED_EMPTY');
  }

  const resolvedOptions = normalizeEmbeddingOptions(options);
  let lastError: unknown;

  for (let i = 0; i < retries; i++) {
    try {
      const embeddings = await generateEmbeddingsOnce(cleanTexts, resolvedOptions);
      if (embeddings.length !== cleanTexts.length) {
        throw new GnosisError(
          `Embedding batch size mismatch: requested=${cleanTexts.length}, returned=${embeddings.length}`,
          'EMBED_FORMAT',
        );
      }
      return embeddings;
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
 * テキストからベクトルを生成します
 * ユーザー環境の埋め込みコマンドを利用します
 */
export async function generateEmbedding(
  text: string,
  retriesOrOptions: number | GenerateEmbeddingOptions = config.memory.retries,
  options: GenerateEmbeddingOptions = {},
): Promise<number[]> {
  const retries = typeof retriesOrOptions === 'number' ? retriesOrOptions : config.memory.retries;
  const resolvedOptions = typeof retriesOrOptions === 'number' ? options : retriesOrOptions;
  const embeddings = await generateEmbeddings([text], resolvedOptions, retries);
  const embedding = embeddings[0];
  if (!embedding) {
    throw new GnosisError('Embedding generation returned no vector.', 'EMBED_EMPTY');
  }
  return embedding;
}
/**
 * メモリを保存します
 */
export async function saveMemory(
  sessionId: string,
  content: string,
  metadata: Record<string, unknown> = {},
  database: DbClient = db,
  options: { embedding?: number[] } = {},
) {
  VibeMemoryInputSchema.parse({ sessionId, content, metadata });
  const embedding = options.embedding ?? (await generateEmbedding(content));

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
 * 追加メタデータ付きメモを保存します。
 * memory_type, importance などの Phase 2 追加フィールドに対応します。
 */
export async function saveMemoryWithOptions(
  input: {
    sessionId: string;
    content: string;
    metadata?: Record<string, unknown>;
    memoryType?: 'raw';
    sourceTask?: string;
    importance?: number;
    compressed?: boolean;
    embedding?: number[];
  },
  database: DbClient = db,
) {
  const embedding = input.embedding ?? (await generateEmbedding(input.content));

  const [memory] = await database
    .insert(vibeMemories)
    .values({
      sessionId: input.sessionId,
      content: input.content,
      embedding,
      metadata: input.metadata ?? {},
      memoryType: input.memoryType ?? 'raw',
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
  memoryType: 'raw',
  limit = 5,
  database: DbClient = db,
) {
  const vectorReady = await database
    .select({ id: vibeMemories.id })
    .from(vibeMemories)
    .where(
      sql`${vibeMemories.memoryType} = ${memoryType} AND ${vibeMemories.embedding} IS NOT NULL`,
    )
    .limit(1);

  if (vectorReady.length === 0) {
    const tsquery = sql`plainto_tsquery('simple', ${query})`;
    const tsvector = sql`to_tsvector('simple', ${vibeMemories.content})`;
    const rank = sql<number>`ts_rank_cd(${tsvector}, ${tsquery})`;

    const lexicalHits = await database
      .select({
        id: vibeMemories.id,
        content: vibeMemories.content,
        metadata: vibeMemories.metadata,
        createdAt: vibeMemories.createdAt,
        sessionId: vibeMemories.sessionId,
        similarity: rank.mapWith(Number),
      })
      .from(vibeMemories)
      .where(sql`${vibeMemories.memoryType} = ${memoryType} AND ${tsvector} @@ ${tsquery}`)
      .orderBy(sql`${rank} DESC`, desc(vibeMemories.createdAt))
      .limit(limit);

    if (lexicalHits.length > 0) return lexicalHits;

    return database
      .select({
        id: vibeMemories.id,
        content: vibeMemories.content,
        metadata: vibeMemories.metadata,
        createdAt: vibeMemories.createdAt,
        sessionId: vibeMemories.sessionId,
        similarity: sql<number>`0`,
      })
      .from(vibeMemories)
      .where(eq(vibeMemories.memoryType, memoryType))
      .orderBy(desc(vibeMemories.createdAt))
      .limit(limit);
  }

  const embedding = await generateEmbedding(query, { type: 'query', priority: 'high' });
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
  const embedding = await generateEmbedding(query, { type: 'query', priority: 'high' });
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
