import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { hookCandidates } from '../../db/schema.js';
import { saveExperience } from '../../services/experience.js';
import { saveEpisodeMemory } from '../../services/memory.js';

type CandidateKind = 'episode' | 'lesson';
type CandidateStatus = 'pending' | 'scored' | 'deduplicated' | 'promoted' | 'rejected';

type HookCandidateRow = typeof hookCandidates.$inferSelect;
type CandidatePayload = Record<string, unknown>;

function toRecord(value: unknown): CandidatePayload {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as CandidatePayload)
    : {};
}

function scoreCandidate(candidate: HookCandidateRow): number {
  const base = candidate.severity === 'high' ? 0.9 : candidate.severity === 'medium' ? 0.75 : 0.55;

  if (candidate.sourceEvent === 'task.failed') {
    return Math.min(1, base + 0.05);
  }

  if (candidate.sourceEvent === 'review.completed') {
    return Math.min(1, base + 0.03);
  }

  return base;
}

function resolveSessionId(candidate: HookCandidateRow, payload: CandidatePayload): string {
  const explicit = payload.sessionId;
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit.trim();
  }

  const context = toRecord(payload.context);
  const cwd = context.cwd;
  if (typeof cwd === 'string' && cwd.trim().length > 0) {
    return `hooks:${path.basename(cwd.trim())}`;
  }

  return `${config.guidance.sessionId}:hooks`;
}

function summarizeCandidate(candidate: HookCandidateRow, payload: CandidatePayload): string {
  const context = toRecord(payload.context);
  const eventPayload = toRecord(payload.eventPayload);
  const lines = [
    `candidate:${candidate.kind}`,
    `sourceEvent:${candidate.sourceEvent}`,
    `traceId:${candidate.traceId}`,
  ];

  const taskId = payload.taskId;
  if (typeof taskId === 'string' && taskId.length > 0) {
    lines.push(`taskId:${taskId}`);
  }

  const changedFiles = Array.isArray(context.changedFiles)
    ? context.changedFiles.filter((item): item is string => typeof item === 'string')
    : [];
  if (changedFiles.length > 0) {
    lines.push(`changedFiles:${changedFiles.join(', ')}`);
  }

  const changedLines = context.changedLines;
  if (typeof changedLines === 'number') {
    lines.push(`changedLines:${changedLines}`);
  }

  const riskTags = Array.isArray(context.riskTags)
    ? context.riskTags.filter((item): item is string => typeof item === 'string')
    : [];
  if (riskTags.length > 0) {
    lines.push(`riskTags:${riskTags.join(', ')}`);
  }

  const findingsCount = eventPayload.findingsCount;
  if (typeof findingsCount === 'number') {
    lines.push(`findingsCount:${findingsCount}`);
  }

  const failureReason = eventPayload.failureReason;
  if (typeof failureReason === 'string' && failureReason.length > 0) {
    lines.push(`failureReason:${failureReason}`);
  }

  return lines.join('\n');
}

async function promoteEpisodeCandidate(
  candidate: HookCandidateRow,
  payload: CandidatePayload,
): Promise<void> {
  const sessionId = resolveSessionId(candidate, payload);
  const content = summarizeCandidate(candidate, payload);
  const importance =
    candidate.severity === 'high' ? 0.85 : candidate.severity === 'medium' ? 0.7 : 0.55;

  await saveEpisodeMemory({
    sessionId,
    content,
    memoryType: 'episode',
    episodeAt: new Date(),
    importance,
    metadata: {
      traceId: candidate.traceId,
      sourceEvent: candidate.sourceEvent,
      kind: candidate.kind,
      severity: candidate.severity,
      candidateId: candidate.id,
      ...payload,
    },
  });
}

async function promoteLessonCandidate(
  candidate: HookCandidateRow,
  payload: CandidatePayload,
): Promise<void> {
  const sessionId = resolveSessionId(candidate, payload);
  const content = summarizeCandidate(candidate, payload);

  await saveExperience({
    sessionId,
    scenarioId: candidate.traceId,
    attempt: 1,
    type: 'failure',
    content,
    failureType: `hook:${candidate.sourceEvent}`,
    metadata: {
      severity: candidate.severity,
      candidateId: candidate.id,
      ...payload,
    },
  });
}

async function updateCandidateStatus(
  candidateId: string,
  status: CandidateStatus,
  score?: number,
  payloadPatch?: Record<string, unknown>,
): Promise<void> {
  const patch: {
    status: CandidateStatus;
    updatedAt: Date;
    score?: number;
    payload?: Record<string, unknown>;
  } = {
    status,
    updatedAt: new Date(),
  };

  if (score !== undefined) {
    patch.score = score;
  }

  if (payloadPatch) {
    const existing = await db
      .select({ payload: hookCandidates.payload })
      .from(hookCandidates)
      .where(eq(hookCandidates.id, candidateId))
      .limit(1);
    patch.payload = {
      ...toRecord(existing[0]?.payload),
      ...payloadPatch,
    };
  }

  await db.update(hookCandidates).set(patch).where(eq(hookCandidates.id, candidateId));
}

export async function promoteHookCandidates(limit = 20): Promise<{
  processed: number;
  promoted: number;
  rejected: number;
}> {
  const candidates = await db
    .select()
    .from(hookCandidates)
    .where(eq(hookCandidates.status, 'pending'))
    .orderBy(asc(hookCandidates.createdAt))
    .limit(limit);

  let promoted = 0;
  let rejected = 0;

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate);
    await updateCandidateStatus(candidate.id, 'scored', score);

    const payload = toRecord(candidate.payload);

    try {
      if (candidate.kind === 'episode') {
        await promoteEpisodeCandidate(candidate, payload);
      } else {
        await promoteLessonCandidate(candidate, payload);
      }

      await updateCandidateStatus(candidate.id, 'promoted', score);
      promoted += 1;
    } catch (error) {
      await updateCandidateStatus(candidate.id, 'rejected', score, {
        promotionError: error instanceof Error ? error.message : String(error),
      });
      rejected += 1;
    }
  }

  return {
    processed: candidates.length,
    promoted,
    rejected,
  };
}
