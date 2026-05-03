import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { syncState, vibeMemories } from '../db/schema.js';
import {
  type ChatMessage,
  type IngestCursor,
  ingestAntigravityLogs,
  ingestClaudeLogs,
  ingestCodexLogs,
  normalizeIngestCursor,
} from './ingest.js';
import { PgJsonbQueueRepository } from './knowflow/queue/pgJsonbRepository.js';

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

function mergeMessageMetadata(messages: ChatMessage[]): Record<string, unknown> {
  const firstMetadata = messages.find((message) => message.metadata)?.metadata ?? {};
  const sources = Array.from(
    new Set(
      messages
        .map((message) => message.metadata?.source)
        .filter((source): source is string => typeof source === 'string'),
    ),
  );
  const sessionFiles = Array.from(
    new Set(
      messages
        .map((message) => message.metadata?.sessionFile)
        .filter((file): file is string => typeof file === 'string'),
    ),
  );
  return {
    ...firstMetadata,
    sources,
    sessionFiles,
    messageCount: messages.length,
    roles: Array.from(new Set(messages.map((message) => message.role))),
    kind: 'agent_log_chunk',
    memoryPipeline: 'raw_for_synthesis',
  };
}

function buildMemorySessionId(sourceId: string, message: ChatMessage): string {
  const sessionId = message.metadata?.sessionId;
  if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
    return `${sourceId}:${sessionId.trim()}`;
  }
  const sessionFile = message.metadata?.sessionFile;
  if (typeof sessionFile === 'string' && sessionFile.trim().length > 0) {
    const digest = createHash('sha256').update(sessionFile).digest('hex').slice(0, 16);
    return `${sourceId}:file:${digest}`;
  }
  return `${sourceId}:fallback`;
}

function buildDistillationSessionId(
  sourceId: string,
  memorySessionId: string,
  message: ChatMessage,
) {
  const sessionFile = message.metadata?.sessionFile;
  if (typeof sessionFile === 'string' && sessionFile.trim().length > 0) {
    return sessionFile.trim();
  }
  return `memory:${sourceId}:${memorySessionId}`;
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
  const queue = new PgJsonbQueueRepository();
  const sources = [
    { id: 'claude_logs', label: 'Claude Code', ingest: ingestClaudeLogs },
    { id: 'antigravity_logs', label: 'Antigravity', ingest: ingestAntigravityLogs },
    { id: 'codex_logs', label: 'Codex', ingest: ingestCodexLogs },
  ];

  const summary = { imported: 0, sources: [] as string[], queuedTasks: [] as string[] };
  const insertedDistillationSessionIds = new Set<string>();
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
    if (ingestResult.warnings.length > 0) {
      console.warn(`Ingestion warnings for ${source.label}: ${ingestResult.warnings.join(' | ')}`);
    }

    const messages = ingestResult.messages.filter((message) => message.content.trim().length > 0);
    const checkpointDate = getCheckpointDate(ingestResult.maxObservedMtimeMs, since);

    if (messages.length === 0) {
      console.log(`No new logs found for ${source.label}.`);
      await upsertSyncState(source.id, Boolean(state), checkpointDate, ingestResult.cursor);
      continue;
    }

    // 3. Raw conversation chunks are saved first. Scheduled reflection/background
    // synthesis is responsible for promoting reusable knowledge into entities.
    const messagesBySession = new Map<string, ChatMessage[]>();
    for (const message of messages) {
      const memorySessionId = buildMemorySessionId(source.id, message);
      const bucket = messagesBySession.get(memorySessionId);
      if (bucket) {
        bucket.push(message);
      } else {
        messagesBySession.set(memorySessionId, [message]);
      }
    }

    // 4. Gnosis への登録 + 同期状態の更新
    const insertedMemories = { count: 0 };
    await db.transaction(async (tx) => {
      for (const [memorySessionId, sessionMessages] of messagesBySession.entries()) {
        const firstMessage = sessionMessages[0];
        if (!firstMessage) {
          continue;
        }
        const chunks = chunkMessages(sessionMessages, maxMessagesPerChunk, maxCharsPerChunk);
        const distillationSessionId = buildDistillationSessionId(
          source.id,
          memorySessionId,
          firstMessage,
        );
        for (const [index, chunk] of chunks.entries()) {
          const content = buildTranscript(chunk);
          const dedupeKey = createHash('sha256')
            .update(`${memorySessionId}\n${index}\n${content}`)
            .digest('hex');
          const inserted = await tx
            .insert(vibeMemories)
            .values({
              sessionId: memorySessionId,
              content,
              dedupeKey,
              metadata: {
                ...mergeMessageMetadata(chunk),
                source: source.label,
                sourceId: source.id,
                chunkIndex: index,
                dedupeKey,
              },
            })
            .onConflictDoNothing({
              target: [vibeMemories.sessionId, vibeMemories.dedupeKey],
            })
            .returning({ id: vibeMemories.id });

          if (inserted.length > 0) {
            insertedMemories.count += 1;
            insertedDistillationSessionIds.add(distillationSessionId);
          }
        }
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

    summary.imported += insertedMemories.count;
    summary.sources.push(source.label);
    console.log(`Successfully synced ${source.label}. (Raw memories: ${insertedMemories.count})`);
  }

  if (summary.imported > 0) {
    try {
      const synthesisTask = await queue.enqueue({
        topic: '__system__/synthesis',
        mode: 'directed',
        source: 'cron',
        requestedBy: 'sync',
        sourceGroup: 'system/synthesis',
        priority: 90,
        metadata: {
          systemTask: {
            type: 'synthesis',
            payload: { maxFailures: 0 },
          },
        },
      });
      summary.queuedTasks.push(synthesisTask.task.id);
      const embeddingTask = await queue.enqueue({
        topic: '__system__/embedding_batch',
        mode: 'directed',
        source: 'cron',
        requestedBy: 'sync',
        sourceGroup: 'system/embedding_batch',
        priority: 91,
        metadata: {
          systemTask: {
            type: 'embedding_batch',
            payload: { batchSize: 50 },
          },
        },
      });
      summary.queuedTasks.push(embeddingTask.task.id);
      for (const sessionId of insertedDistillationSessionIds) {
        const sessionTask = await queue.enqueue({
          topic: `__system__/session_distillation/${sessionId}`,
          mode: 'directed',
          source: 'cron',
          requestedBy: 'sync',
          sourceGroup: `system/session_distillation/${sessionId}`,
          priority: 92,
          metadata: {
            systemTask: {
              type: 'session_distillation',
              payload: {
                sessionId,
                force: false,
                promote: false,
                provider: 'auto',
              },
            },
          },
        });
        summary.queuedTasks.push(sessionTask.task.id);
      }
      console.log(
        `[sync] queued follow-up tasks: ${summary.queuedTasks.join(', ')} (imported=${
          summary.imported
        })`,
      );
    } catch (enqueueError) {
      console.warn('[sync] failed to enqueue follow-up tasks:', enqueueError);
    }
  }

  return summary;
}
