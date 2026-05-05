import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { sessionDistillations, sessionKnowledgeCandidates } from '../../db/schema.js';
import type { KnowledgeCandidate, SessionSummaryStatus } from './types.js';

type SessionDistillationRecord = typeof sessionDistillations.$inferSelect;
type SessionKnowledgeCandidateRecord = typeof sessionKnowledgeCandidates.$inferSelect;

const SESSION_KNOWLEDGE_MIN_CONFIDENCE = 0.7;
const CLI_COMMAND_LIKE_PATTERN = /^\/[a-z0-9._-]+(?:\s|$)/i;
const CLI_COMMAND_INLINE_PATTERN = /\b(?:bun run|npm|pnpm|git|rg|drizzle-kit|tsc)\b/i;

function isCliCommandLike(value: string | null | undefined): boolean {
  if (!value) return false;
  return CLI_COMMAND_LIKE_PATTERN.test(value.trim());
}

function shouldHideFromSessionKnowledgeList(candidate: SessionKnowledgeCandidateRecord): boolean {
  if (candidate.confidence < SESSION_KNOWLEDGE_MIN_CONFIDENCE) return true;
  return (
    isCliCommandLike(candidate.title) ||
    isCliCommandLike(candidate.statement) ||
    CLI_COMMAND_INLINE_PATTERN.test(candidate.title) ||
    CLI_COMMAND_INLINE_PATTERN.test(candidate.statement)
  );
}

function normalizeCandidateText(value: string): string {
  return value
    .replace(/`/g, '')
    .replace(/[「」"'.,:;!?()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function dedupeSessionKnowledgeCandidateRecords(
  candidates: SessionKnowledgeCandidateRecord[],
): SessionKnowledgeCandidateRecord[] {
  const byKey = new Map<string, SessionKnowledgeCandidateRecord>();
  for (const candidate of candidates) {
    const statementKey = normalizeCandidateText(candidate.statement);
    const titleKey = normalizeCandidateText(candidate.title);
    const key = statementKey || titleKey;
    if (!key) continue;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }

    const approvalScore = (value: SessionKnowledgeCandidateRecord['approvalStatus']): number =>
      value === 'approved' ? 3 : value === 'pending' ? 2 : 1;
    const kindScore = (value: SessionKnowledgeCandidateRecord['kind']): number =>
      value === 'rule' ? 3 : value === 'lesson' ? 2 : value === 'procedure' ? 1 : 0;
    const score = (row: SessionKnowledgeCandidateRecord): number =>
      (row.keep ? 100 : 0) +
      approvalScore(row.approvalStatus) * 10 +
      row.confidence * 5 +
      kindScore(row.kind);

    if (score(candidate) > score(existing)) {
      byKey.set(key, candidate);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.turnIndex - b.turnIndex);
}

export function filterSessionKnowledgeCandidates(
  candidates: SessionKnowledgeCandidateRecord[],
): SessionKnowledgeCandidateRecord[] {
  const filtered = candidates.filter((candidate) => !shouldHideFromSessionKnowledgeList(candidate));
  return dedupeSessionKnowledgeCandidateRecords(filtered);
}

function dedupeKnowledgeCandidates(candidates: KnowledgeCandidate[]): KnowledgeCandidate[] {
  const byKey = new Map<string, KnowledgeCandidate>();
  for (const candidate of candidates) {
    const statementKey = normalizeCandidateText(candidate.statement);
    const titleKey = normalizeCandidateText(candidate.title);
    const key = statementKey || titleKey;
    if (!key) continue;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }

    const score = (row: KnowledgeCandidate): number => {
      const keepScore = row.keep ? 100 : 0;
      const kindScore =
        row.kind === 'rule' ? 3 : row.kind === 'lesson' ? 2 : row.kind === 'procedure' ? 1 : 0;
      return keepScore + row.confidence * 10 + kindScore;
    };
    if (score(candidate) > score(existing)) {
      byKey.set(key, candidate);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.turnIndex - b.turnIndex);
}

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
  const candidates = filterSessionKnowledgeCandidates(
    await getCandidatesByDistillationId(latest.id),
  );
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

export async function resetDistillationToRunning(input: {
  id: string;
  modelProvider: 'deterministic' | 'local-llm' | 'openai' | 'bedrock';
  modelName?: string;
  turnCount: number;
  messageCount: number;
  metadata?: Record<string, unknown>;
}): Promise<SessionDistillationRecord> {
  const [row] = await db
    .update(sessionDistillations)
    .set({
      status: 'running',
      modelProvider: input.modelProvider,
      modelName: input.modelName,
      turnCount: input.turnCount,
      messageCount: input.messageCount,
      keptCount: 0,
      droppedCount: 0,
      metadata: input.metadata ?? {},
      error: null,
      updatedAt: new Date(),
      completedAt: null,
    })
    .where(eq(sessionDistillations.id, input.id))
    .returning();

  if (!row) throw new Error(`Failed to reset session distillation: ${input.id}`);
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
  const deduped = dedupeKnowledgeCandidates(candidates);
  if (deduped.length === 0) return;

  await db.insert(sessionKnowledgeCandidates).values(
    deduped.map((candidate) => ({
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
