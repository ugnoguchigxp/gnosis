import { createHash } from 'node:crypto';
import { getSessionDetail } from '../../scripts/monitor-sessions.js';
import { buildDeterministicCandidates } from './candidate.js';
import { buildDeterministicEvidenceAndActions } from './evidence.js';
import { refineCandidatesWithLlm } from './llm.js';
import { promoteCandidates } from './promotion.js';
import { SESSION_DISTILLATION_PROMPT_VERSION } from './prompt.js';
import {
  createRunningDistillation,
  findDistillationByHash,
  markDistillationStatus,
  replaceKnowledgeCandidates,
} from './repository.js';
import { splitSessionTurns, toSessionMessageInputs } from './segmenter.js';
import type { DistillSessionResult, KnowledgeCandidate } from './types.js';

function hashTranscript(
  messages: Array<{ id?: string; role: string; content: string; createdAt?: string }>,
): string {
  const stable = messages.map((m) => [m.id ?? '', m.role, m.createdAt ?? '', m.content]).join('\n');
  return createHash('sha256').update(stable).digest('hex');
}

export async function distillSessionKnowledge(input: {
  sessionId: string;
  force?: boolean;
  dryRun?: boolean;
  provider?: 'auto' | 'deterministic' | 'local' | 'openai' | 'bedrock';
  promote?: boolean;
}): Promise<DistillSessionResult> {
  const detail = await getSessionDetail(input.sessionId);
  const messageInputs = toSessionMessageInputs(detail.messages);
  const transcriptHash = hashTranscript(messageInputs);
  const promptVersion = SESSION_DISTILLATION_PROMPT_VERSION;
  const provider = input.provider ?? 'auto';
  const modelProvider =
    provider === 'openai' || provider === 'bedrock'
      ? provider
      : provider === 'deterministic'
        ? 'deterministic'
        : 'local-llm';

  const existing = await findDistillationByHash(detail.summary.id, transcriptHash, promptVersion);
  if (existing && existing.status === 'succeeded' && !input.force) {
    return {
      distillationId: existing.id,
      sessionKey: existing.sessionKey,
      status: 'succeeded',
      turnCount: existing.turnCount,
      messageCount: existing.messageCount,
      keptCount: existing.keptCount,
      droppedCount: existing.droppedCount,
      promotedCount: 0,
      modelProvider:
        (existing.modelProvider as DistillSessionResult['modelProvider']) ?? 'deterministic',
      modelName: existing.modelName ?? undefined,
      candidates: [],
    };
  }

  const turns = splitSessionTurns(messageInputs).map(buildDeterministicEvidenceAndActions);

  let allCandidates: KnowledgeCandidate[] = [];
  for (const turn of turns) {
    const deterministic = buildDeterministicCandidates(turn);
    if (provider === 'deterministic') {
      allCandidates = allCandidates.concat(deterministic);
      continue;
    }
    const refined = await refineCandidatesWithLlm(turn, deterministic);
    allCandidates = allCandidates.concat(refined.candidates);
  }

  let promotedCount = 0;
  if (input.promote) {
    const promoted = await promoteCandidates(allCandidates);
    allCandidates = promoted.candidates;
    promotedCount = promoted.promotedCount;
  }

  const keptCount = allCandidates.filter((candidate) => candidate.keep).length;
  const droppedCount = allCandidates.length - keptCount;

  if (input.dryRun) {
    return {
      sessionKey: detail.summary.id,
      status: 'succeeded',
      turnCount: turns.length,
      messageCount: messageInputs.length,
      keptCount,
      droppedCount,
      promotedCount,
      modelProvider,
      candidates: allCandidates,
    };
  }

  const row = await createRunningDistillation({
    sessionKey: detail.summary.id,
    transcriptHash,
    promptVersion,
    modelProvider,
    turnCount: turns.length,
    messageCount: messageInputs.length,
    metadata: {
      source: detail.summary.source,
      sourceId: detail.summary.sourceId,
    },
  });

  try {
    await replaceKnowledgeCandidates(row.id, allCandidates);
    await markDistillationStatus(row.id, {
      status: 'succeeded',
      keptCount,
      droppedCount,
      metadata: {
        promotedCount,
      },
    });

    return {
      distillationId: row.id,
      sessionKey: detail.summary.id,
      status: 'succeeded',
      turnCount: turns.length,
      messageCount: messageInputs.length,
      keptCount,
      droppedCount,
      promotedCount,
      modelProvider,
      candidates: allCandidates,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markDistillationStatus(row.id, {
      status: 'failed',
      keptCount,
      droppedCount,
      error: message,
    });

    return {
      distillationId: row.id,
      sessionKey: detail.summary.id,
      status: 'failed',
      turnCount: turns.length,
      messageCount: messageInputs.length,
      keptCount,
      droppedCount,
      promotedCount,
      modelProvider,
      error: message,
      candidates: allCandidates,
    };
  }
}
