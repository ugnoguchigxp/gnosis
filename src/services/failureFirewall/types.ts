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
