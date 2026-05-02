import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { sessionDistillations, sessionKnowledgeCandidates } from '../../db/schema.js';
import type { KnowledgeCandidate, SessionSummaryStatus } from './types.js';

type SessionDistillationRecord = typeof sessionDistillations.$inferSelect;

export async function findLatestSessionDistillation(sessionKey: string) {
  const rows = await db
    .select()
    .from(sessionDistillations)
    .where(eq(sessionDistillations.sessionKey, sessionKey))
    .orderBy(desc(sessionDistillations.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function listDistillations(limit = 50) {
  return db
    .select()
    .from(sessionDistillations)
    .orderBy(desc(sessionDistillations.createdAt))
    .limit(limit);
}

export async function getDistillationById(id: string) {
  const rows = await db
    .select()
    .from(sessionDistillations)
    .where(eq(sessionDistillations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getCandidatesByDistillationId(distillationId: string) {
  return db
    .select()
    .from(sessionKnowledgeCandidates)
    .where(eq(sessionKnowledgeCandidates.distillationId, distillationId))
    .orderBy(asc(sessionKnowledgeCandidates.turnIndex));
}

export async function getCandidateById(candidateId: string) {
  const rows = await db
    .select()
    .from(sessionKnowledgeCandidates)
    .where(eq(sessionKnowledgeCandidates.id, candidateId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listCandidatesBySession(sessionKey: string) {
  const latest = await findLatestSessionDistillation(sessionKey);
  if (!latest)
    return {
      distillation: null,
      candidates: [] as (typeof sessionKnowledgeCandidates.$inferSelect)[],
    };
  const candidates = await getCandidatesByDistillationId(latest.id);
  return { distillation: latest, candidates };
}

export async function findDistillationByHash(
  sessionKey: string,
  transcriptHash: string,
  promptVersion: string,
) {
  const rows = await db
    .select()
    .from(sessionDistillations)
    .where(
      and(
        eq(sessionDistillations.sessionKey, sessionKey),
        eq(sessionDistillations.transcriptHash, transcriptHash),
        eq(sessionDistillations.promptVersion, promptVersion),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createRunningDistillation(input: {
  sessionKey: string;
  transcriptHash: string;
  promptVersion: string;
  modelProvider: 'deterministic' | 'local-llm' | 'openai' | 'bedrock';
  modelName?: string;
  turnCount: number;
  messageCount: number;
  metadata?: Record<string, unknown>;
}): Promise<SessionDistillationRecord> {
  const [row] = await db
    .insert(sessionDistillations)
    .values({
      sessionKey: input.sessionKey,
      transcriptHash: input.transcriptHash,
      promptVersion: input.promptVersion,
      status: 'running',
      modelProvider: input.modelProvider,
      modelName: input.modelName,
      turnCount: input.turnCount,
      messageCount: input.messageCount,
      metadata: input.metadata ?? {},
      keptCount: 0,
      droppedCount: 0,
    })
    .returning();

  if (!row) throw new Error('Failed to create session distillation');
  return row;
}

export async function replaceKnowledgeCandidates(
  distillationId: string,
  candidates: KnowledgeCandidate[],
) {
  await db
    .delete(sessionKnowledgeCandidates)
    .where(eq(sessionKnowledgeCandidates.distillationId, distillationId));
  if (candidates.length === 0) return;

  await db.insert(sessionKnowledgeCandidates).values(
    candidates.map((candidate) => ({
      distillationId,
      turnIndex: candidate.turnIndex,
      kind: candidate.kind,
      title: candidate.title,
      statement: candidate.statement,
      keep: candidate.keep,
      keepReason: candidate.keepReason,
      evidence: candidate.evidence,
      actions: candidate.actions,
      confidence: candidate.confidence,
      status: candidate.status,
      promotedNoteId: candidate.promotedNoteId,
    })),
  );
}

export async function markDistillationStatus(
  distillationId: string,
  input: {
    status: SessionSummaryStatus;
    keptCount?: number;
    droppedCount?: number;
    error?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const now = new Date();
  await db
    .update(sessionDistillations)
    .set({
      status: input.status,
      keptCount: input.keptCount,
      droppedCount: input.droppedCount,
      error: input.error,
      metadata: input.metadata,
      updatedAt: now,
      completedAt: input.status === 'running' || input.status === 'pending' ? null : now,
    })
    .where(eq(sessionDistillations.id, distillationId));
}

export async function approveCandidate(candidateId: string) {
  const now = new Date();
  const [updated] = await db
    .update(sessionKnowledgeCandidates)
    .set({
      approvalStatus: 'approved',
      rejectionReason: null,
      approvedAt: now,
      rejectedAt: null,
      updatedAt: now,
    })
    .where(eq(sessionKnowledgeCandidates.id, candidateId))
    .returning();
  return updated ?? null;
}

export async function rejectCandidate(candidateId: string, reason: string) {
  const now = new Date();
  const [updated] = await db
    .update(sessionKnowledgeCandidates)
    .set({
      approvalStatus: 'rejected',
      rejectionReason: reason,
      rejectedAt: now,
      updatedAt: now,
    })
    .where(eq(sessionKnowledgeCandidates.id, candidateId))
    .returning();
  return updated ?? null;
}

export async function markCandidateRecorded(
  candidateId: string,
  input: { promotedNoteId?: string | null; recordError?: string | null },
) {
  const now = new Date();
  const [updated] = await db
    .update(sessionKnowledgeCandidates)
    .set({
      promotedNoteId: input.promotedNoteId ?? null,
      recordError: input.recordError ?? null,
      updatedAt: now,
    })
    .where(eq(sessionKnowledgeCandidates.id, candidateId))
    .returning();
  return updated ?? null;
}
