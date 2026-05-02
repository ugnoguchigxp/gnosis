import { recordTaskNote } from '../agentFirst.js';
import type { KnowledgeCandidate } from './types.js';

type PromotableKind = 'lesson' | 'rule' | 'procedure';

function isPromotableKind(kind: KnowledgeCandidate['kind']): kind is PromotableKind {
  return kind === 'lesson' || kind === 'rule' || kind === 'procedure';
}

export async function promoteCandidates(candidates: KnowledgeCandidate[]): Promise<{
  promotedCount: number;
  candidates: KnowledgeCandidate[];
}> {
  const updated: KnowledgeCandidate[] = [];
  let promotedCount = 0;

  for (const candidate of candidates) {
    if (!candidate.keep || !isPromotableKind(candidate.kind)) {
      updated.push(candidate);
      continue;
    }

    const result = await recordTaskNote({
      content: candidate.statement,
      title: candidate.title,
      kind: candidate.kind,
      source: 'task',
      confidence: candidate.confidence,
      tags: ['session-distillation'],
      metadata: {
        keepReason: candidate.keepReason,
        turnIndex: candidate.turnIndex,
      },
    });

    promotedCount += result.saved ? 1 : 0;
    updated.push({ ...candidate, promotedNoteId: result.entityId ?? undefined });
  }

  return { promotedCount, candidates: updated };
}
