import type { ReviewLLMService } from '../review/llm/types.js';
import type { FailureCandidate, FailureDiffFeatures } from './types.js';
import { FailureDecisionSchema, FailureSeveritySchema } from './types.js';

export interface FailureFirewallAdjudicatorDeps {
  llmService?: ReviewLLMService;
}

type LlmDecision = {
  candidateId: string;
  decision?: FailureCandidate['decision'];
  severity?: FailureCandidate['severity'];
  confidence?: FailureCandidate['confidence'];
  rationale?: string;
};

function asConfidence(value: unknown): FailureCandidate['confidence'] | undefined {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return undefined;
}

function asLlmDecision(value: unknown): LlmDecision | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.candidateId !== 'string' || record.candidateId.trim().length === 0) {
    return undefined;
  }

  const decision = FailureDecisionSchema.safeParse(record.decision);
  const severity = FailureSeveritySchema.safeParse(record.severity);
  const confidence = asConfidence(record.confidence);

  return {
    candidateId: record.candidateId,
    decision: decision.success ? decision.data : undefined,
    severity: severity.success ? severity.data : undefined,
    confidence,
    rationale: typeof record.rationale === 'string' ? record.rationale : undefined,
  };
}

function candidateKey(candidate: FailureCandidate, index: number): string {
  return candidate.failurePattern?.id ?? candidate.goldenPath?.id ?? `candidate-${index + 1}`;
}

function parseJsonArray(text: string): LlmDecision[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  const parsed = JSON.parse(match[0]) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    const decision = asLlmDecision(item);
    return decision ? [decision] : [];
  });
}

export async function adjudicateWithLocalLlm(
  features: FailureDiffFeatures,
  candidates: FailureCandidate[],
  deps: FailureFirewallAdjudicatorDeps = {},
): Promise<{ candidates: FailureCandidate[]; degradedReason?: string; localLlmUsed: boolean }> {
  if (!deps.llmService || candidates.length === 0) {
    return { candidates, localLlmUsed: false };
  }
  if (deps.llmService.provider !== 'local') {
    return { candidates, degradedReason: 'non_local_llm_skipped', localLlmUsed: false };
  }

  const compactCandidates = candidates.map((candidate, index) => ({
    candidateId: candidateKey(candidate, index),
    goldenPath: candidate.goldenPath?.title,
    failurePattern: candidate.failurePattern?.title,
    decision: candidate.decision,
    severity: candidate.severity,
    deviationScore: candidate.deviationScore,
    recurrenceScore: candidate.recurrenceScore,
    evidence: candidate.evidence.slice(0, 5),
  }));

  const prompt = `
Failure Firewall candidate adjudication.

Rules:
- Do not perform generic code review.
- Only decide whether each candidate is a Golden Path deviation, recurrence, allowed alternative, no match, or needs confirmation.
- Prefer needs_confirmation when evidence is incomplete.
- Return JSON array only.

Patch summary:
${features.patchSummary}

Candidates:
${JSON.stringify(compactCandidates, null, 2)}

Return:
[
  {
    "candidateId": "id",
    "decision": "deviation|deviation_with_recurrence|allowed_alternative|no_match|needs_confirmation",
    "severity": "error|warning|info",
    "confidence": "high|medium|low",
    "rationale": "short reason"
  }
]
`.trim();

  try {
    const response = await deps.llmService.generate(prompt, { format: 'text' });
    const decisions = parseJsonArray(response);
    if (decisions.length === 0) {
      return { candidates, degradedReason: 'local_llm_unparseable', localLlmUsed: true };
    }

    const byId = new Map(decisions.map((decision) => [decision.candidateId, decision]));
    return {
      candidates: candidates
        .map((candidate, index) => {
          const decision = byId.get(candidateKey(candidate, index));
          if (!decision) return candidate;
          if (decision.decision === 'no_match' || decision.decision === 'allowed_alternative') {
            return { ...candidate, decision: decision.decision, score: 0 };
          }
          return {
            ...candidate,
            decision: decision.decision ?? candidate.decision,
            severity: decision.severity ?? candidate.severity,
            confidence: decision.confidence ?? candidate.confidence,
            evidence: decision.rationale
              ? [...candidate.evidence, `local_llm: ${decision.rationale}`]
              : candidate.evidence,
            needsHumanConfirmation:
              decision.decision === 'needs_confirmation' || candidate.needsHumanConfirmation,
          };
        })
        .filter((candidate) => candidate.score > 0),
      localLlmUsed: true,
    };
  } catch {
    return { candidates, degradedReason: 'local_llm_failed', localLlmUsed: true };
  }
}
