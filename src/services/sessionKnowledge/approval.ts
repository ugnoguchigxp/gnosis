import { recordTaskNote } from '../agentFirst.js';
import {
  approveCandidate,
  getCandidateById,
  markCandidateRecorded,
  rejectCandidate,
} from '../sessionSummary/repository.js';

function mapKind(
  kind: string,
):
  | 'rule'
  | 'procedure'
  | 'lesson'
  | 'observation'
  | 'reference'
  | 'risk'
  | 'command_recipe'
  | 'decision'
  | 'project_doc'
  | 'skill' {
  if (kind === 'rule' || kind === 'procedure' || kind === 'lesson') return kind;
  return 'observation';
}

export async function approveSessionKnowledgeCandidate(candidateId: string) {
  const updated = await approveCandidate(candidateId);
  if (!updated) throw new Error(`candidate not found: ${candidateId}`);
  return updated;
}

export async function rejectSessionKnowledgeCandidate(candidateId: string, reason: string) {
  const updated = await rejectCandidate(candidateId, reason);
  if (!updated) throw new Error(`candidate not found: ${candidateId}`);
  return updated;
}

export async function recordSessionKnowledgeCandidate(candidateId: string) {
  const candidate = await getCandidateById(candidateId);
  if (!candidate) throw new Error(`candidate not found: ${candidateId}`);
  if (candidate.approvalStatus !== 'approved') {
    throw new Error(`candidate must be approved before record: ${candidateId}`);
  }

  const evidence = Array.isArray(candidate.evidence)
    ? candidate.evidence
        .filter((item) => item && typeof item === 'object')
        .slice(0, 8)
        .map((item) => {
          const record = item as Record<string, unknown>;
          return {
            type: typeof record.kind === 'string' ? record.kind : 'session_evidence',
            value: typeof record.text === 'string' ? record.text : JSON.stringify(record),
          };
        })
    : [];

  const note = await recordTaskNote({
    content: `${candidate.title}\n\n${candidate.statement}`.trim(),
    title: candidate.title,
    kind: mapKind(candidate.kind),
    confidence: candidate.confidence ?? undefined,
    evidence,
    source: 'task',
    metadata: {
      source: 'session_knowledge',
      candidateId: candidate.id,
      distillationId: candidate.distillationId,
      turnIndex: candidate.turnIndex,
    },
  });

  if (!note.saved || !note.entityId) {
    await markCandidateRecorded(candidateId, {
      promotedNoteId: null,
      recordError: 'record_task_note returned saved=false',
    });
    throw new Error('record_task_note returned saved=false');
  }

  await markCandidateRecorded(candidateId, {
    promotedNoteId: note.entityId,
    recordError: null,
  });

  return {
    candidateId,
    promotedNoteId: note.entityId,
    saved: note.saved,
  };
}
