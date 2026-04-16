import { z } from 'zod';

export const ReviewTriggerSchema = z.enum(['task_completed', 'checkpoint', 'manual']);
export type ReviewTrigger = z.infer<typeof ReviewTriggerSchema>;

export const ReviewModeSchema = z.enum(['git_diff', 'worktree']);
export type ReviewMode = z.infer<typeof ReviewModeSchema>;

export const FindingSeveritySchema = z.enum(['error', 'warning', 'info']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type FindingConfidence = z.infer<typeof FindingConfidenceSchema>;

export const FindingCategorySchema = z.enum([
  'bug',
  'security',
  'performance',
  'design',
  'maintainability',
  'test',
  'validation',
  'unused-import',
  'missing-import',
  'missing-parameter',
  'interface-property',
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

export const FindingSourceSchema = z.enum([
  'local_llm',
  'heavy_llm',
  'static_analysis',
  'rule_engine',
]);
export type FindingSource = z.infer<typeof FindingSourceSchema>;

export const ReviewStatusSchema = z.enum([
  'changes_requested',
  'needs_confirmation',
  'no_major_findings',
]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const DegradedModeSchema = z.enum([
  'static_analysis_unavailable',
  'knowledge_retrieval_failed',
  'astmend_unavailable',
  'diff_size_limited',
  'llm_timeout',
]);
export type DegradedMode = z.infer<typeof DegradedModeSchema>;

export interface ReviewRequest {
  taskId: string;
  repoPath: string;
  baseRef: string;
  headRef: string;
  taskGoal?: string;
  changedFiles?: string[];
  trigger: ReviewTrigger;
  sessionId: string;
  mode: ReviewMode;
  enableStaticAnalysis?: boolean;
  enableKnowledgeRetrieval?: boolean;
}

export const ReviewRequestSchema = z
  .object({
    taskId: z.string().min(1),
    repoPath: z.string().min(1),
    baseRef: z.string().min(1),
    headRef: z.string().min(1),
    taskGoal: z.string().min(1).optional(),
    changedFiles: z.array(z.string().min(1)).optional(),
    trigger: ReviewTriggerSchema,
    sessionId: z.string().min(1),
    mode: ReviewModeSchema,
    enableStaticAnalysis: z.boolean().optional(),
    enableKnowledgeRetrieval: z.boolean().optional(),
  })
  .strict();

export interface Finding {
  id: string;
  title: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  file_path: string;
  line_new: number;
  end_line?: number;
  category: FindingCategory;
  rationale: string;
  suggested_fix?: string;
  evidence: string;
  knowledge_refs?: string[];
  fingerprint: string;
  needsHumanConfirmation: boolean;
  source: FindingSource;
  metadata?: Record<string, unknown>;
}

export const FindingSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    severity: FindingSeveritySchema,
    confidence: FindingConfidenceSchema,
    file_path: z.string().min(1),
    line_new: z.number().int().positive(),
    end_line: z.number().int().positive().optional(),
    category: FindingCategorySchema,
    rationale: z.string().min(1),
    suggested_fix: z.string().min(1).optional(),
    evidence: z.string(),
    knowledge_refs: z.array(z.string().min(1)).optional(),
    fingerprint: z.string().min(1),
    needsHumanConfirmation: z.boolean(),
    source: FindingSourceSchema,
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export interface FixSuggestion {
  findingId: string;
  operation: Record<string, unknown>;
  diff: string;
  updatedText: string;
  confidence: 'high' | 'medium';
}

export const FixSuggestionSchema = z
  .object({
    findingId: z.string().min(1),
    operation: z.record(z.unknown()),
    diff: z.string(),
    updatedText: z.string(),
    confidence: z.enum(['high', 'medium']),
  })
  .strict();

export interface ReviewKPIs {
  totalReviews: number;
  totalFindings: number;
  avgFindingsPerReview: number;
  precisionRate: number;
  falsePositiveRate: number;
  knowledgeContributionRate: number;
  zeroFpDays: number;
  avgReviewDurationMs: number;
  precisionByCategory: Record<string, number>;
}

export const ReviewKPISchema = z
  .object({
    totalReviews: z.number().int().nonnegative(),
    totalFindings: z.number().int().nonnegative(),
    avgFindingsPerReview: z.number(),
    precisionRate: z.number(),
    falsePositiveRate: z.number(),
    knowledgeContributionRate: z.number(),
    zeroFpDays: z.number().int().nonnegative(),
    avgReviewDurationMs: z.number(),
    precisionByCategory: z.record(z.number()),
  })
  .strict();

export interface ReviewMetadata {
  reviewed_files: number;
  risk_level: 'low' | 'medium' | 'high';
  static_analysis_used: boolean;
  knowledge_applied: string[];
  degraded_mode: boolean;
  degraded_reasons: DegradedMode[];
  local_llm_used: boolean;
  heavy_llm_used: boolean;
  review_duration_ms: number;
}

export const ReviewMetadataSchema = z
  .object({
    reviewed_files: z.number().int().nonnegative(),
    risk_level: z.enum(['low', 'medium', 'high']),
    static_analysis_used: z.boolean(),
    knowledge_applied: z.array(z.string()),
    degraded_mode: z.boolean(),
    degraded_reasons: z.array(DegradedModeSchema),
    local_llm_used: z.boolean(),
    heavy_llm_used: z.boolean(),
    review_duration_ms: z.number().int().nonnegative(),
  })
  .strict();

export interface ReviewOutput {
  review_id: string;
  task_id?: string;
  review_status: ReviewStatus;
  findings: Finding[];
  summary: string;
  next_actions: string[];
  rerun_review: boolean;
  metadata: ReviewMetadata;
  markdown: string;
  fix_suggestions?: FixSuggestion[];
  review_kpis?: ReviewKPIs;
}

export const ReviewOutputSchema = z
  .object({
    review_id: z.string().min(1),
    task_id: z.string().min(1).optional(),
    review_status: ReviewStatusSchema,
    findings: z.array(FindingSchema),
    summary: z.string(),
    next_actions: z.array(z.string()),
    rerun_review: z.boolean(),
    metadata: ReviewMetadataSchema,
    markdown: z.string(),
    fix_suggestions: z.array(FixSuggestionSchema).optional(),
    review_kpis: ReviewKPISchema.optional(),
  })
  .strict();

export interface FileClassification {
  language: string;
  isConfig: boolean;
  isMigration: boolean;
  isTest: boolean;
  isInfra: boolean;
  framework?: string;
}

export interface DiffLine {
  type: 'context' | 'added' | 'removed';
  oldLineNo?: number;
  newLineNo?: number;
  content: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface NormalizedDiff {
  filePath: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  oldLineMap: Map<number, string>;
  newLineMap: Map<number, string>;
  hunks: Hunk[];
  language: string;
  fileSize: number;
  isBinary: boolean;
  classification: FileClassification;
}

export interface StaticAnalysisFinding {
  id: string;
  file_path: string;
  line?: number;
  message: string;
  severity: FindingSeverity;
  rule_id?: string;
  source: 'eslint' | 'tsc' | 'biome' | 'custom' | 'rule_engine';
}

export interface AstmendImpactSummary {
  /** 変更されたシンボルごとの参照・影響情報 */
  symbols: AstmendSymbolImpact[];
  /** Astmend MCP が利用不可だった場合 true */
  degraded: boolean;
}

export interface AstmendSymbolImpact {
  name: string;
  kind: 'function' | 'interface' | 'class' | 'type_alias' | 'enum' | 'variable';
  file: string;
  /** analyze_references の結果: 参照箇所 */
  references: { file: string; line: number; isDefinition: boolean }[];
  /** detect_impact の結果: 影響を受ける宣言 */
  impactedDeclarations: { name: string; kind: string; file: string }[];
}

export interface ReviewContextV1 {
  instruction: string;
  projectInfo: { language: string; framework?: string };
  rawDiff: string;
  outputSchema: object;
}

export interface ReviewContextV2 extends ReviewContextV1 {
  diffSummary: {
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    riskSignals: string[];
  };
  selectedHunks: NormalizedDiff[];
  staticAnalysisFindings: StaticAnalysisFinding[];
  impactAnalysis?: AstmendImpactSummary;
}

export interface GuidanceItem {
  id: string;
  title: string;
  content: string;
  guidanceType: 'rule' | 'skill';
  scope: 'always' | 'on_demand';
  priority: number;
  tags: string[];
  applicability?: {
    signals?: string[];
    fileTypes?: string[];
    languages?: string[];
    frameworks?: string[];
    excludedFrameworks?: string[];
  };
}

export interface ReviewContextV3 extends ReviewContextV2 {
  recalledPrinciples: GuidanceItem[];
  recalledHeuristics: GuidanceItem[];
  recalledPatterns: GuidanceItem[];
  optionalSkills: GuidanceItem[];
  pastSimilarFindings: string[];
}
