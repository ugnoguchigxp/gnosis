import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { syncState, vibeMemories } from '../db/schema.js';
import { saveEntities, saveRelations } from './graph.js';
import {
  type ChatMessage,
  type IngestCursor,
  ingestAntigravityLogs,
  ingestClaudeLogs,
  normalizeIngestCursor,
} from './ingest.js';
import { type DistilledKnowledge, distillKnowledgeFromTranscript } from './llm.js';
import { generateEmbedding } from './memory.js';

const SYNC_SESSION_ID = 'sync-agent-logs';
const DEFAULT_MAX_MESSAGES_PER_CHUNK = 120;
const DEFAULT_MAX_CHARS_PER_CHUNK = 12000;

function positiveIntFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || '');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function chunkMessages(
  messages: ChatMessage[],
  maxMessages: number,
  maxChars: number,
): ChatMessage[][] {
  const chunks: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  let currentChars = 0;

  for (const message of messages) {
    const messageChars = message.content.length;
    const reachedMessageLimit = current.length >= maxMessages;
    const reachedCharLimit = current.length > 0 && currentChars + messageChars > maxChars;

    if (reachedMessageLimit || reachedCharLimit) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(message);
    currentChars += messageChars;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function mergeDistilledKnowledge(chunks: DistilledKnowledge[]): DistilledKnowledge {
  const merged: DistilledKnowledge = { memories: [], entities: [], relations: [] };
  for (const chunk of chunks) {
    merged.memories.push(...(Array.isArray(chunk.memories) ? chunk.memories : []));
    merged.entities.push(...(Array.isArray(chunk.entities) ? chunk.entities : []));
    merged.relations.push(...(Array.isArray(chunk.relations) ? chunk.relations : []));
  }
  return merged;
}

function dedupeEntities(entities: DistilledKnowledge['entities']) {
  return Array.from(
    new Map(
      entities
        .filter(
          (entity) =>
            entity &&
            typeof entity.id === 'string' &&
            typeof entity.type === 'string' &&
            typeof entity.name === 'string',
        )
        .map((entity) => [entity.id, entity]),
    ).values(),
  );
}

function dedupeRelations(relations: DistilledKnowledge['relations']) {
  return Array.from(
    new Map(
      relations
        .filter(
          (relation) =>
            relation &&
            typeof relation.sourceId === 'string' &&
            typeof relation.targetId === 'string' &&
            typeof relation.relationType === 'string',
        )
        .map((relation) => [
          `${relation.sourceId}::${relation.targetId}::${relation.relationType}`,
          relation,
        ]),
    ).values(),
  );
}

function dedupeMemories(memories: string[]) {
  return Array.from(
    new Set(memories.filter((memory) => typeof memory === 'string' && memory.trim().length > 0)),
  );
}

function getCheckpointDate(maxObservedMtimeMs: number, since?: Date): Date {
  if (Number.isFinite(maxObservedMtimeMs) && maxObservedMtimeMs > 0) {
    return new Date(maxObservedMtimeMs);
  }
  if (since) return since;
  return new Date();
}

function buildTranscript(messages: ChatMessage[]): string {
  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join('\n\n');
}

async function upsertSyncState(
  sourceId: string,
  stateExists: boolean,
  checkpointDate: Date,
  cursor: IngestCursor,
) {
  const now = new Date();
  if (!stateExists) {
    await db.insert(syncState).values({
      id: sourceId,
      lastSyncedAt: checkpointDate,
      cursor,
      updatedAt: now,
    });
    return;
  }

  await db
    .update(syncState)
    .set({ lastSyncedAt: checkpointDate, cursor, updatedAt: now })
    .where(eq(syncState.id, sourceId));
}

/**
 * 外部エージェントのログをスキャンし、新しい知識を Gnosis に同期します。
 */
export async function syncAllAgentLogs() {
  const sources = [
    { id: 'claude_logs', label: 'Claude Code', ingest: ingestClaudeLogs },
    { id: 'antigravity_logs', label: 'Antigravity', ingest: ingestAntigravityLogs },
  ];

  const summary = { imported: 0, sources: [] as string[] };
  const maxMessagesPerChunk = positiveIntFromEnv(
    'GNOSIS_SYNC_MAX_MESSAGES_PER_CHUNK',
    DEFAULT_MAX_MESSAGES_PER_CHUNK,
  );
  const maxCharsPerChunk = positiveIntFromEnv(
    'GNOSIS_SYNC_MAX_CHARS_PER_CHUNK',
    DEFAULT_MAX_CHARS_PER_CHUNK,
  );

  for (const source of sources) {
    console.log(`Checking for updates in ${source.label}...`);

    // 1. 同期状態の取得
    const [state] = await db.select().from(syncState).where(eq(syncState.id, source.id));

    const since = state ? state.lastSyncedAt : undefined;
    const cursor = normalizeIngestCursor(state?.cursor);

    // 2. ログの読み込み (前回のファイルオフセット以降)
    const ingestResult = await source.ingest(since, cursor);
    if (!ingestResult.ok) {
      console.warn(
        `Ingestion failed for ${
          source.label
        }. Skip this source without updating checkpoint. Errors: ${ingestResult.errors.join(
          ' | ',
        )}`,
      );
      continue;
    }

    const messages = ingestResult.messages.filter((message) => message.content.trim().length > 0);
    const checkpointDate = getCheckpointDate(ingestResult.maxObservedMtimeMs, since);

    if (messages.length === 0) {
      console.log(`No new logs found for ${source.label}.`);
      await upsertSyncState(source.id, Boolean(state), checkpointDate, ingestResult.cursor);
      continue;
    }

    // 3. 知識の蒸留 (LLM): 大きすぎる入力を避けるためチャンク処理
    const chunks = chunkMessages(messages, maxMessagesPerChunk, maxCharsPerChunk);
    const distilledChunks: DistilledKnowledge[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const transcript = buildTranscript(chunk);
      console.log(
        `Distilling chunk ${index + 1}/${chunks.length} from ${source.label} (${
          transcript.length
        } chars)...`,
      );
      const knowledge = await distillKnowledgeFromTranscript(transcript);
      distilledChunks.push(knowledge);
    }

    const mergedKnowledge = mergeDistilledKnowledge(distilledChunks);
    const dedupedMemories = dedupeMemories(mergedKnowledge.memories);
    const dedupedEntities = dedupeEntities(mergedKnowledge.entities);
    const dedupedRelations = dedupeRelations(mergedKnowledge.relations);

    // 4. Gnosis への登録 + 同期状態の更新
    const insertedMemories = { count: 0 };
    await db.transaction(async (tx) => {
      for (const content of dedupedMemories) {
        const dedupeKey = createHash('sha256').update(`${source.id}\n${content}`).digest('hex');
        const embedding = await generateEmbedding(content);
        const inserted = await tx
          .insert(vibeMemories)
          .values({
            sessionId: SYNC_SESSION_ID,
            content,
            embedding,
            dedupeKey,
            metadata: { source: source.label, sourceId: source.id, dedupeKey },
          })
          .onConflictDoNothing({
            target: [vibeMemories.sessionId, vibeMemories.dedupeKey],
          })
          .returning({ id: vibeMemories.id });

        if (inserted.length > 0) {
          insertedMemories.count += 1;
        }
      }

      if (dedupedEntities.length > 0) {
        await saveEntities(dedupedEntities, tx);
      }

      if (dedupedRelations.length > 0) {
        await saveRelations(dedupedRelations, tx);
      }

      const now = new Date();
      if (!state) {
        await tx.insert(syncState).values({
          id: source.id,
          lastSyncedAt: checkpointDate,
          cursor: ingestResult.cursor,
          updatedAt: now,
        });
      } else {
        await tx
          .update(syncState)
          .set({ lastSyncedAt: checkpointDate, cursor: ingestResult.cursor, updatedAt: now })
          .where(eq(syncState.id, source.id));
      }
    });

    summary.imported += insertedMemories.count + dedupedEntities.length + dedupedRelations.length;
    summary.sources.push(source.label);
    console.log(
      `Successfully synced ${source.label}. (Memories: ${insertedMemories.count}, Entities: ${dedupedEntities.length}, Relations: ${dedupedRelations.length})`,
    );
  }

  return summary;
}
