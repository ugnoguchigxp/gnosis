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
  resetDistillationToRunning,
} from './repository.js';
import { splitSessionTurns, toSessionMessageInputs } from './segmenter.js';
import type { DistillSessionResult, KnowledgeCandidate } from './types.js';

function hashTranscript(
  messages: Array<{ id?: string; role: string; content: string; createdAt?: string }>,
): string {
  const stable = messages.map((m) => [m.id ?? '', m.role, m.createdAt ?? '', m.content]).join('\n');
  return createHash('sha256').update(stable).digest('hex');
}

function errorKindFromUnknown(error: unknown): string {
  if (error instanceof Error) {
    const byName = error.name?.trim();
    if (byName) return byName;
    const ctorName = error.constructor?.name;
    if (typeof ctorName === 'string' && ctorName.trim().length > 0) return ctorName;
    return 'Error';
  }
  if (typeof error === 'string') return 'StringError';
  return 'UnknownError';
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
  let llmSucceededTurns = 0;
  let llmFailedTurns = 0;
  let llmSkippedTurns = 0;
  let llmParsedConfidenceTotal = 0;
  for (const turn of turns) {
    const deterministic = buildDeterministicCandidates(turn);
    const hasReusableCandidates = deterministic.some((candidate) => candidate.keep);
    if (provider === 'deterministic') {
      allCandidates = allCandidates.concat(deterministic);
      continue;
    }
    if (!hasReusableCandidates) {
      // Skip expensive LLM refinement when deterministic pass already concluded "nothing reusable".
      allCandidates = allCandidates.concat(deterministic);
      llmSkippedTurns += 1;
      continue;
    }
    const refined = await refineCandidatesWithLlm(turn, deterministic);
    if (refined.status === 'llm_succeeded') {
      llmSucceededTurns += 1;
      llmParsedConfidenceTotal += refined.diagnostics?.parsedConfidenceCount ?? 0;
    } else {
      llmFailedTurns += 1;
    }
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

  const baseRowInput = {
    modelProvider,
    turnCount: turns.length,
    messageCount: messageInputs.length,
    metadata: {
      source: detail.summary.source,
      sourceId: detail.summary.sourceId,
    },
  } as const;
  const row =
    existing && input.force
      ? await resetDistillationToRunning({
          id: existing.id,
          ...baseRowInput,
        })
      : await createRunningDistillation({
          sessionKey: detail.summary.id,
          transcriptHash,
          promptVersion,
          ...baseRowInput,
        });

  try {
    await replaceKnowledgeCandidates(row.id, allCandidates);
    await markDistillationStatus(row.id, {
      status: 'succeeded',
      keptCount,
      droppedCount,
      metadata: {
        promotedCount,
        llmSucceededTurns,
        llmFailedTurns,
        llmSkippedTurns,
        llmParsedConfidenceTotal,
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
    const errorKind = errorKindFromUnknown(error);
    const message = error instanceof Error ? error.message : String(error);
    await markDistillationStatus(row.id, {
      status: 'failed',
      keptCount,
      droppedCount,
      error: message,
      metadata: {
        promotedCount,
        llmSucceededTurns,
        llmFailedTurns,
        llmSkippedTurns,
        llmParsedConfidenceTotal,
        errorKind,
      },
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
      errorKind,
      error: message,
      candidates: allCandidates,
    };
  }
}
