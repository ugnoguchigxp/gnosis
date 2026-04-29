import { randomUUID } from 'node:crypto';
import { sha256 } from '../../utils/crypto.js';
import { type ReviewDiffMode, getDiff } from '../review/foundation/gitDiff.js';
import { getReviewLLMService } from '../review/llm/reviewer.js';
import type { ReviewLLMService } from '../review/llm/types.js';
import type { DegradedMode, Finding, ReviewOutput, ReviewRequest } from '../review/types.js';
import { adjudicateWithLocalLlm } from './adjudicator.js';
import { buildFailureDiffFeatures } from './diffFeatures.js';
import { type FailurePatternStoreDeps, loadFailureKnowledge } from './patternStore.js';
import { renderFailureFirewallMarkdown } from './renderer.js';
import { scoreFailureCandidates } from './scorer.js';
import type {
  FailureCandidate,
  FailureFirewallMatch,
  FailureFirewallMode,
  FailureFirewallOutput,
  FailureKnowledgeSourceMode,
} from './types.js';
import { FailureKnowledgeSourceModeSchema } from './types.js';

export interface RunFailureFirewallOptions extends FailurePatternStoreDeps {
  repoPath?: string;
  rawDiff?: string;
  mode?: FailureFirewallMode;
  diffMode?: ReviewDiffMode;
  llmService?: ReviewLLMService;
  now?: () => number;
}

export interface FailureFirewallGoalOptions {
  mode: FailureFirewallMode;
  knowledgeSource?: FailureKnowledgeSourceMode;
}

function taskGoalTokens(taskGoal: string | undefined): string[] {
  return taskGoal?.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

function stripTokenQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function getTaskGoalFlagValue(tokens: string[], flag: string): string | undefined {
  const inlinePrefix = `${flag}=`;
  const inline = tokens.find((token) => token.startsWith(inlinePrefix));
  if (inline) return stripTokenQuotes(inline.slice(inlinePrefix.length));

  const index = tokens.indexOf(flag);
  if (index >= 0 && index + 1 < tokens.length) return stripTokenQuotes(tokens[index + 1] ?? '');
  return undefined;
}

export function resolveFailureFirewallGoalOptions(
  taskGoal: string | undefined,
): FailureFirewallGoalOptions {
  const tokens = taskGoalTokens(taskGoal);
  const parsedSource = FailureKnowledgeSourceModeSchema.safeParse(
    getTaskGoalFlagValue(tokens, '--knowledge-source')?.trim().toLowerCase(),
  );

  return {
    mode: tokens.includes('--with-llm') ? 'with_llm' : 'fast',
    ...(parsedSource.success ? { knowledgeSource: parsedSource.data } : {}),
  };
}

function candidateTitle(candidate: FailureCandidate): string {
  return candidate.failurePattern?.title ?? candidate.goldenPath?.title ?? 'Golden Path deviation';
}

function candidateRationale(candidate: FailureCandidate): string {
  const parts = [];
  if (candidate.goldenPath) {
    parts.push(
      `この変更は「${candidate.goldenPath.title}」の必須条件から外れている可能性があります。`,
    );
  }
  if (candidate.failurePattern && candidate.recurrenceScore >= 0.65) {
    parts.push(`さらに「${candidate.failurePattern.title}」と同じ構造の再発候補です。`);
  }
  if (candidate.decision === 'needs_confirmation') {
    parts.push('根拠が不足しているため、人間の確認が必要です。');
  }
  return parts.join(' ') || 'Golden Path 逸脱候補です。';
}

function suggestedAction(candidate: FailureCandidate): string | undefined {
  const step = candidate.missingRequiredSteps[0];
  if (step) return step;
  return candidate.failurePattern?.requiredEvidence[0];
}

function toMatch(candidate: FailureCandidate): FailureFirewallMatch {
  return {
    ...candidate,
    title: candidateTitle(candidate),
    rationale: candidateRationale(candidate),
    suggestedAction: suggestedAction(candidate),
  };
}

function deriveStatus(matches: FailureFirewallMatch[]): FailureFirewallOutput['status'] {
  if (
    matches.some(
      (match) =>
        isAutoBlockingMatch(match.severity, match.decision) && !match.needsHumanConfirmation,
    )
  ) {
    return 'changes_requested';
  }
  if (matches.length > 0) return 'needs_confirmation';
  return 'no_recurrence_detected';
}

function isAutoBlockingMatch(
  severity: FailureFirewallMatch['severity'],
  decision: FailureFirewallMatch['decision'],
): boolean {
  return severity === 'error' && decision === 'deviation_with_recurrence';
}

function toReviewDegradedReasons(reasons: string[]): DegradedMode[] {
  const mapped = reasons.flatMap((reason): DegradedMode[] => {
    if (reason === 'local_llm_failed') return ['llm_failed'];
    if (reason === 'local_llm_unparseable') return ['llm_unparseable'];
    if (reason === 'non_local_llm_skipped') return ['non_local_llm_skipped'];
    return [];
  });
  return [...new Set(mapped)];
}

function toFinding(match: FailureFirewallMatch): Finding {
  return {
    id: randomUUID(),
    title: `[Failure Firewall] ${match.title}`,
    severity: match.severity,
    confidence: match.confidence,
    file_path: match.filePath,
    line_new: match.lineNew,
    category: match.severity === 'error' ? 'bug' : 'maintainability',
    rationale: match.rationale,
    suggested_fix: match.suggestedAction,
    evidence: match.evidence.join('\n'),
    knowledge_refs: [match.goldenPath?.id, match.failurePattern?.id].filter((id): id is string =>
      Boolean(id),
    ),
    fingerprint: sha256(
      `${match.filePath}:${match.lineNew}:${match.title}:${match.decision}:${match.evidence.join(
        '|',
      )}`,
    ),
    needsHumanConfirmation: match.needsHumanConfirmation,
    source: 'rule_engine',
    metadata: {
      failureFirewall: {
        decision: match.decision,
        deviationScore: match.deviationScore,
        recurrenceScore: match.recurrenceScore,
      },
    },
  };
}

export async function runFailureFirewall(
  options: RunFailureFirewallOptions = {},
): Promise<FailureFirewallOutput> {
  const startedAt = options.now?.() ?? Date.now();
  const now = options.now ?? Date.now;
  const mode = options.mode ?? 'fast';
  const rawDiff =
    options.rawDiff ??
    (await getDiff(options.repoPath ?? process.cwd(), options.diffMode ?? 'worktree'));

  if (!rawDiff.trim()) {
    return {
      status: 'no_recurrence_detected',
      mode,
      matches: [],
      goldenPathsEvaluated: 0,
      patternsEvaluated: 0,
      degradedReasons: [],
      metadata: {
        reviewedFiles: 0,
        riskSignals: [],
        languages: [],
        durationMs: now() - startedAt,
        localLlmUsed: false,
        docsOnly: false,
      },
    };
  }

  const features = buildFailureDiffFeatures(rawDiff);
  const knowledge = await loadFailureKnowledge({ database: options.database });
  let candidates = scoreFailureCandidates(
    features,
    knowledge.goldenPaths,
    knowledge.failurePatterns,
  );
  const degradedReasons: string[] = [];
  let localLlmUsed = false;

  if (mode === 'with_llm' && candidates.length > 0) {
    const llmService =
      options.llmService ?? (await getReviewLLMService('local', { invoker: 'service' }));
    const adjudicated = await adjudicateWithLocalLlm(features, candidates, { llmService });
    candidates = adjudicated.candidates;
    localLlmUsed = adjudicated.localLlmUsed;
    if (adjudicated.degradedReason) degradedReasons.push(adjudicated.degradedReason);
  }

  const matches = candidates.map(toMatch);

  return {
    status: deriveStatus(matches),
    mode,
    matches,
    goldenPathsEvaluated: knowledge.goldenPaths.length,
    patternsEvaluated: knowledge.failurePatterns.length,
    degradedReasons,
    metadata: {
      reviewedFiles: features.changedFiles.length,
      riskSignals: features.riskSignals,
      languages: features.languages,
      durationMs: now() - startedAt,
      localLlmUsed,
      docsOnly: features.docsOnly,
    },
  };
}

export function renderFailureFirewall(output: FailureFirewallOutput): string {
  return renderFailureFirewallMarkdown(output);
}

export async function runFailureFirewallReview(
  req: ReviewRequest,
  deps: {
    now?: () => number;
    diffProvider?: (repoPath: string, mode: ReviewRequest['mode']) => Promise<string>;
    llmService?: ReviewLLMService;
  } = {},
): Promise<ReviewOutput> {
  const startedAt = deps.now?.() ?? Date.now();
  const now = deps.now ?? Date.now;
  const rawDiff = await (deps.diffProvider ?? getDiff)(req.repoPath, req.mode);
  const goalOptions = resolveFailureFirewallGoalOptions(req.taskGoal);
  const firewall = await runFailureFirewall({
    repoPath: req.repoPath,
    rawDiff,
    mode: goalOptions.mode,
    knowledgeSource: goalOptions.knowledgeSource,
    llmService: deps.llmService,
    now,
  });
  const findings = firewall.matches.map(toFinding);
  const markdown = renderFailureFirewallMarkdown(firewall);
  const degradedReasons = toReviewDegradedReasons(firewall.degradedReasons);

  return {
    review_id: randomUUID(),
    task_id: req.taskId,
    review_status:
      firewall.status === 'changes_requested'
        ? 'changes_requested'
        : firewall.status === 'needs_confirmation'
          ? 'needs_confirmation'
          : 'no_major_findings',
    findings,
    summary:
      findings.length > 0
        ? `Failure Firewall detected ${findings.length} Golden Path deviation candidate(s).`
        : 'Failure Firewall detected no Golden Path deviation.',
    next_actions:
      findings.length > 0
        ? ['Confirm whether each Failure Firewall candidate is a true project-specific deviation.']
        : [],
    rerun_review: findings.some((finding) => finding.severity === 'error'),
    metadata: {
      reviewed_files: firewall.metadata.reviewedFiles,
      risk_level: findings.some((finding) => finding.severity === 'error')
        ? 'high'
        : findings.length > 0
          ? 'medium'
          : 'low',
      static_analysis_used: true,
      knowledge_applied: [...new Set(findings.flatMap((finding) => finding.knowledge_refs ?? []))],
      degraded_mode: firewall.degradedReasons.length > 0,
      degraded_reasons: degradedReasons,
      local_llm_used: firewall.metadata.localLlmUsed,
      heavy_llm_used: false,
      review_duration_ms: now() - startedAt,
      stage: 'failure_firewall',
    },
    markdown,
  };
}
