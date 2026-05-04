import { z } from 'zod';
import type { NormalizedDiff } from '../review/types.js';

export const FailureSeveritySchema = z.enum(['error', 'warning', 'info']);
export type FailureSeverity = z.infer<typeof FailureSeveritySchema>;

export const FailureDecisionSchema = z.enum([
  'deviation',
  'deviation_with_recurrence',
  'allowed_alternative',
  'no_match',
  'needs_confirmation',
]);
export type FailureDecision = z.infer<typeof FailureDecisionSchema>;

export const FailureFirewallModeSchema = z.enum(['fast', 'with_llm']);
export type FailureFirewallMode = z.infer<typeof FailureFirewallModeSchema>;

export const FailureKnowledgeSourceModeSchema = z.enum(['entities', 'dedicated', 'hybrid']);
export type FailureKnowledgeSourceMode = z.infer<typeof FailureKnowledgeSourceModeSchema>;

export interface GoldenPath {
  id: string;
  title: string;
  pathType: string;
  appliesWhen: string[];
  requiredSteps: string[];
  allowedAlternatives: string[];
  blockWhenMissing: string[];
  severityWhenMissing: FailureSeverity;
  riskSignals: string[];
  languages: string[];
  frameworks: string[];
  tags: string[];
  status: 'active' | 'needs_review' | 'deprecated';
  source: 'seed' | 'entity' | 'experience' | 'dedicated';
}

export interface FailurePattern {
  id: string;
  title: string;
  patternType: string;
  severity: FailureSeverity;
  riskSignals: string[];
  languages: string[];
  frameworks: string[];
  matchHints: string[];
  requiredEvidence: string[];
  goldenPathId?: string;
  status: 'active' | 'needs_review' | 'deprecated';
  falsePositiveCount: number;
  source: 'seed' | 'entity' | 'experience' | 'dedicated' | 'review_outcome';
}

export interface FailureDiffFileFeature {
  filePath: string;
  language: string;
  framework?: string;
  changeType: NormalizedDiff['changeType'];
  addedLines: string[];
  removedLines: string[];
  isDocsOnly: boolean;
  isTest: boolean;
  isConfig: boolean;
  isMigration: boolean;
}

export interface FailureDiffFeatures {
  rawDiff: string;
  files: FailureDiffFileFeature[];
  normalizedDiffs: NormalizedDiff[];
  riskSignals: string[];
  languages: string[];
  frameworks: string[];
  changedFiles: string[];
  addedLineCount: number;
  removedLineCount: number;
  docsOnly: boolean;
  patchSummary: string;
}

export interface FailureCandidate {
  goldenPath?: GoldenPath;
  failurePattern?: FailurePattern;
  deviationScore: number;
  recurrenceScore: number;
  score: number;
  missingRequiredSteps: string[];
  allowedAlternativeMatched: string[];
  evidence: string[];
  filePath: string;
  lineNew: number;
  decision: FailureDecision;
  severity: FailureSeverity;
  confidence: 'high' | 'medium' | 'low';
  needsHumanConfirmation: boolean;
}

export interface FailureFirewallMatch extends FailureCandidate {
  title: string;
  rationale: string;
  suggestedAction?: string;
}

export interface FailureFirewallOutput {
  status: 'changes_requested' | 'needs_confirmation' | 'no_recurrence_detected';
  mode: FailureFirewallMode;
  matches: FailureFirewallMatch[];
  goldenPathsEvaluated: number;
  patternsEvaluated: number;
  degradedReasons: string[];
  metadata: {
    reviewedFiles: number;
    riskSignals: string[];
    languages: string[];
    durationMs: number;
    localLlmUsed: boolean;
    docsOnly: boolean;
  };
}

export interface FailureKnowledgeSource {
  goldenPaths: GoldenPath[];
  failurePatterns: FailurePattern[];
}

export interface FailureFirewallContext {
  shouldUse: boolean;
  reason: string;
  riskSignals: string[];
  changedFiles: string[];
  lessonCandidates: FailureFirewallLessonCandidate[];
  goldenPathCandidates: Array<{
    id: string;
    title: string;
    source: GoldenPath['source'];
    pathType: string;
    appliesWhen: string[];
    requiredSteps: string[];
    allowedAlternatives: string[];
    score: number;
  }>;
  failurePatternCandidates: Array<{
    id: string;
    title: string;
    source: FailurePattern['source'];
    patternType: string;
    severity: FailureSeverity;
    requiredEvidence: string[];
    score: number;
  }>;
  suggestedUse: 'skip' | 'review_reference' | 'run_fast_gate' | 'generate_learning_candidates';
  degradedReasons: string[];
}

export interface FailureFirewallLessonCandidate {
  id: string;
  title: string;
  kind: string;
  category?: string;
  content: string;
  tags: string[];
  files: string[];
  evidence: string[];
  riskSignals: string[];
  score: number;
  reason: string;
  source: 'entity' | 'experience';
  blocking: false;
}

export interface LookupFailureFirewallContextInput {
  repoPath?: string;
  rawDiff?: string;
  taskGoal?: string;
  files?: string[];
  changeTypes?: string[];
  technologies?: string[];
  maxGoldenPaths?: number;
  maxFailurePatterns?: number;
  maxLessonCandidates?: number;
  knowledgeSource?: FailureKnowledgeSourceMode;
}

export interface FailureFirewallLearningCandidate {
  candidateId: string;
  status: 'needs_review';
  sourceEvent: 'verified_commit_approval';
  verifyCommand: string;
  commitApprovedByUser: true;
  successPattern?: {
    kind: 'procedure' | 'skill' | 'rule' | 'decision';
    title: string;
    content: string;
    goldenPath: {
      pathType: string;
      appliesWhen: string[];
      requiredSteps: string[];
      allowedAlternatives: string[];
      blockWhenMissing: string[];
      riskSignals: string[];
    };
  };
  failurePattern?: {
    kind: 'risk' | 'lesson' | 'rule';
    title: string;
    content: string;
    failureFirewall: {
      patternType: string;
      severity: FailureSeverity;
      riskSignals: string[];
      matchHints: string[];
      requiredEvidence: string[];
      goldenPathCandidateId?: string;
    };
  };
}

export interface SuggestFailureFirewallLearningCandidatesInput {
  repoPath?: string;
  rawDiff: string;
  verifyCommand: string;
  verifyPassed: boolean;
  commitApprovedByUser: boolean;
  reviewFindings?: Array<{
    title: string;
    severity: string;
    accepted?: boolean;
    filePath?: string;
    evidence?: string;
  }>;
  knowledgeSource?: FailureKnowledgeSourceMode;
}

export interface FailureFirewallLearningCandidatesOutput {
  candidates: FailureFirewallLearningCandidate[];
  skippedReason?: string;
}
