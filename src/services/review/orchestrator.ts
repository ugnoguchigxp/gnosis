import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { sha256 } from '../../utils/crypto.js';
import { runFailureFirewallReview } from '../failureFirewall/index.js';
import { deduplicateFindings, mergeFindings, validateFindingsFull } from './diff/merge.js';
import { countAddedLines, countRemovedLines, normalizeDiff } from './diff/normalizer.js';
import { ReviewError } from './errors.js';
import { validateAllowedRoot } from './foundation/allowedRoots.js';
import { getDiff } from './foundation/gitDiff.js';
import { enforceHardLimit } from './foundation/hardLimit.js';
import { maskOrThrow } from './foundation/secretMask.js';
import { validateSessionId } from './foundation/sessionId.js';
import { generateFixSuggestion } from './knowledge/fixSuggester.js';
import {
  getProjectKey,
  persistReviewCase,
  retrieveGuidance,
  searchSimilarFindings,
} from './knowledge/index.js';
import { reviewWithTools } from './llm/agenticReviewer.js';
import { getReviewLLMService, reviewWithLLM } from './llm/reviewer.js';
import { resolveReviewerAlias } from './llm/reviewer.js';
import type { ChatMessage, ReviewLLMService } from './llm/types.js';
import type { ReviewMcpToolCaller } from './mcp/caller.js';
import { recordReviewResult } from './memoryIntegration.js';
import { calculateMetrics } from './metrics/calculator.js';
import { enrichRiskSignalsWithImpact, planReview } from './planner/riskScorer.js';
import { renderReviewMarkdown } from './render/markdown.js';
import { analyzeImpactWithAstmend, extractChangedSymbols } from './static/astmend.js';
import { analyzeDiffWithDiffGuard, runDiffGuard } from './static/diffguard.js';
import { runStaticAnalysisOnChangedDetailed } from './static/runner.js';
import type { ReviewerToolContext } from './tools/types.js';
import {
  type DegradedMode,
  type Finding,
  type FindingCategory,
  type FindingConfidence,
  type FindingSeverity,
  type FixSuggestion,
  type GuidanceItem,
  type KnowledgePolicy,
  type KnowledgeRetrievalStatus,
  type NormalizedDiff,
  type ReviewMetadata,
  type ReviewOutput,
  ReviewOutputSchema,
  type ReviewRequest,
  type ReviewStatus,
  type RubricCriterion,
  type RubricEvaluation,
  type StaticAnalysisFinding,
} from './types.js';

interface LLMReviewResult {
  findings: Array<{
    title: string;
    severity: FindingSeverity;
    confidence: FindingConfidence;
    file_path: string;
    line_new: number;
    category: FindingCategory;
    rationale: string;
    suggested_fix?: string;
    evidence: string;
  }>;
  summary: string;
  next_actions: string[];
}

type RunReviewDeps = {
  llmService?: ReviewLLMService;
  now?: () => number;
  diffProvider?: (repoPath: string, mode: ReviewRequest['mode']) => Promise<string>;
  mcpCaller?: ReviewMcpToolCaller;
  retrieveGuidanceFn?: typeof retrieveGuidance;
  searchSimilarFindingsFn?: typeof searchSimilarFindings;
  reviewWithToolsFn?: typeof reviewWithTools;
};

function countChangedFiles(rawDiff: string): number {
  return (rawDiff.match(/^diff --git /gm) || []).length;
}

function deriveReviewStatus(findings: Finding[]): ReviewStatus {
  if (findings.some((finding) => finding.severity === 'error')) return 'changes_requested';
  if (findings.some((finding) => finding.needsHumanConfirmation)) return 'needs_confirmation';
  return 'no_major_findings';
}

function determineRiskLevel(findings: Finding[]): ReviewMetadata['risk_level'] {
  if (findings.some((finding) => finding.severity === 'error')) return 'high';
  if (findings.length > 0) return 'medium';
  return 'low';
}

function detectPrimaryLanguage(diffs: NormalizedDiff[]): string {
  const counts = new Map<string, number>();

  for (const diff of diffs) {
    counts.set(diff.language, (counts.get(diff.language) ?? 0) + 1);
  }

  let winner = 'unknown';
  let winnerCount = -1;
  for (const [language, count] of counts.entries()) {
    if (count > winnerCount) {
      winner = language;
      winnerCount = count;
    }
  }

  return winner;
}

function enrichRiskSignalsWithDiffGuard(
  signals: string[],
  analysis: Awaited<ReturnType<typeof analyzeDiffWithDiffGuard>>,
): string[] {
  if (!analysis) return signals;

  const enriched = [...signals];
  for (const file of analysis.files) {
    const joined = file.changeTypes.join(' ').toLowerCase();
    if (joined.includes('rename')) enriched.push('rename_only');
    if (joined.includes('doc')) enriched.push('docs_only');
    if (joined.includes('comment')) enriched.push('comment_only');
  }

  return [...new Set(enriched)];
}

function extractFilePathsFromDiff(rawDiff: string): string[] {
  const paths = new Set<string>();
  const matches = rawDiff.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm);
  for (const match of matches) {
    const filePath = match[2];
    if (filePath) paths.add(filePath);
  }
  return [...paths];
}

function detectLanguageFromFiles(filePaths: string[]): string {
  const counts = new Map<string, number>();

  for (const filePath of filePaths) {
    const ext = path.extname(filePath).toLowerCase();
    const language =
      ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts'
        ? 'TypeScript'
        : ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs'
          ? 'JavaScript'
          : ext === '.py'
            ? 'Python'
            : ext === '.rs'
              ? 'Rust'
              : ext === '.go'
                ? 'Go'
                : ext === '.svelte'
                  ? 'Svelte'
                  : 'Unknown';

    counts.set(language, (counts.get(language) ?? 0) + 1);
  }

  let winner = 'Unknown';
  let winnerCount = -1;
  for (const [language, count] of counts.entries()) {
    if (count > winnerCount) {
      winner = language;
      winnerCount = count;
    }
  }

  return winner;
}

function detectFrameworkFromPackageJson(repoPath: string): string | undefined {
  const packageJsonPath = path.join(repoPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return undefined;

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    };
    const names = Object.keys(deps).join(' ');

    if (/\bnext\b/i.test(names)) return 'Next.js';
    if (/\b@sveltejs\/kit\b/i.test(names) || /\bsvelte\b/i.test(names)) return 'SvelteKit';
    if (/\breact\b/i.test(names)) return 'React';
    if (/\bvue\b/i.test(names)) return 'Vue';
    if (/\bastro\b/i.test(names)) return 'Astro';
    if (/\bhono\b/i.test(names)) return 'Hono';
    if (/\bexpress\b/i.test(names)) return 'Express';
    if (/\btauri\b/i.test(names)) return 'Tauri';

    return undefined;
  } catch {
    return undefined;
  }
}

function detectProjectInfo(
  repoPath: string,
  rawDiff: string,
): { language: string; framework?: string } {
  const filePaths = extractFilePathsFromDiff(rawDiff);
  const language = detectLanguageFromFiles(filePaths);
  const framework = detectFrameworkFromPackageJson(repoPath);

  return framework ? { language, framework } : { language };
}

function buildResult(input: Omit<ReviewOutput, 'markdown'> & { markdown?: string }): ReviewOutput {
  const withMarkdown = {
    ...input,
    markdown: '',
  } satisfies ReviewOutput;
  const markdown = renderReviewMarkdown(withMarkdown);
  return { ...input, markdown };
}

async function buildFixSuggestions(
  findings: Finding[],
  repoPath: string,
  mcpCaller: ReviewMcpToolCaller | undefined,
): Promise<FixSuggestion[]> {
  const suggestions: FixSuggestion[] = [];

  for (const finding of findings) {
    const suggestion = await generateFixSuggestion(finding, repoPath, mcpCaller);
    if (suggestion) suggestions.push(suggestion);
  }

  return suggestions;
}

function buildNoChangesResult(startTime: number, now: () => number): ReviewOutput {
  return buildResult({
    review_id: randomUUID(),
    review_status: 'no_major_findings',
    findings: [],
    summary: 'No changes detected',
    next_actions: [],
    rerun_review: false,
    metadata: {
      reviewed_files: 0,
      risk_level: 'low',
      static_analysis_used: false,
      knowledge_applied: [],
      degraded_mode: false,
      degraded_reasons: [],
      local_llm_used: false,
      heavy_llm_used: false,
      review_duration_ms: now() - startTime,
    },
  });
}

function buildTimedOutResult(startTime: number, now: () => number): ReviewOutput {
  return buildResult({
    review_id: randomUUID(),
    review_status: 'no_major_findings',
    findings: [],
    summary: 'Review timed out',
    next_actions: [],
    rerun_review: false,
    metadata: {
      reviewed_files: 0,
      risk_level: 'low',
      static_analysis_used: false,
      knowledge_applied: [],
      degraded_mode: true,
      degraded_reasons: ['llm_timeout' as DegradedMode],
      local_llm_used: false,
      heavy_llm_used: false,
      review_duration_ms: now() - startTime,
    },
  });
}

export async function runReviewStageA(
  req: ReviewRequest,
  deps: RunReviewDeps = {},
): Promise<ReviewOutput> {
  const startTime = deps.now?.() ?? Date.now();
  const now = deps.now ?? Date.now;

  validateAllowedRoot(req.repoPath);
  validateSessionId(req.sessionId);

  let rawDiff: string;
  try {
    rawDiff = await (deps.diffProvider ?? getDiff)(req.repoPath, req.mode);
  } catch (error) {
    throw new ReviewError('E005', `Git diff failed: ${error}`);
  }

  if (!rawDiff.trim()) {
    return buildNoChangesResult(startTime, now);
  }

  enforceHardLimit(rawDiff);

  const llmService =
    deps.llmService ??
    (await getReviewLLMService(
      process.env.GNOSIS_REVIEW_LLM_PREFERENCE === 'local' ? 'local' : 'cloud',
    ));

  const maskedDiff = maskOrThrow(rawDiff, llmService.provider === 'cloud');

  try {
    const { findings, summary, next_actions } = await reviewWithLLM(
      {
        instruction: req.taskGoal ?? '',
        projectInfo: detectProjectInfo(req.repoPath, rawDiff),
        rawDiff: maskedDiff,
        outputSchema: {},
      },
      llmService,
    );

    const result = ReviewOutputSchema.parse({
      review_id: randomUUID(),
      task_id: req.taskId,
      review_status: deriveReviewStatus(findings),
      findings,
      summary,
      next_actions,
      rerun_review: findings.some((finding) => finding.severity === 'error'),
      metadata: {
        reviewed_files: countChangedFiles(rawDiff),
        risk_level: determineRiskLevel(findings),
        static_analysis_used: false,
        knowledge_applied: [],
        degraded_mode: false,
        degraded_reasons: [],
        local_llm_used: llmService.provider === 'local',
        heavy_llm_used: llmService.provider === 'cloud',
        review_duration_ms: now() - startTime,
      },
      markdown: '',
    });

    return buildResult(result);
  } catch (error) {
    if (error instanceof ReviewError && error.code === 'E006') {
      return buildTimedOutResult(startTime, now);
    }

    throw error;
  }
}

async function buildReviewDiffState(
  repoPath: string,
  enableStaticAnalysis: boolean | undefined,
  mcpCaller: ReviewMcpToolCaller | undefined,
  rawDiff: string,
): Promise<{
  diffs: NormalizedDiff[];
  staticAnalysisFindings: StaticAnalysisFinding[];
  degradedModes: DegradedMode[];
  impactAnalysis: Awaited<ReturnType<typeof analyzeImpactWithAstmend>>;
  riskSignals: string[];
}> {
  const diffs = normalizeDiff(rawDiff);
  const degradedModes: DegradedMode[] = [];

  const diffGuardAnalysis = await analyzeDiffWithDiffGuard(rawDiff, mcpCaller);
  const riskSignalsBase = enrichRiskSignalsWithDiffGuard(
    extractRiskSignalsFromDiffs(diffs),
    diffGuardAnalysis,
  );

  const changedSymbols = extractChangedSymbols(diffs);
  const impactAnalysis = await analyzeImpactWithAstmend(changedSymbols, repoPath, mcpCaller);
  if (impactAnalysis.degraded) degradedModes.push('astmend_unavailable');

  const staticAnalysisResult = enableStaticAnalysis
    ? await runStaticAnalysisOnChangedDetailed(diffs, repoPath)
    : { findings: [], degraded: false };
  if (enableStaticAnalysis && staticAnalysisResult.degraded) {
    degradedModes.push('static_analysis_unavailable');
  }

  const diffGuardFindings = await runDiffGuard(rawDiff, repoPath, mcpCaller);
  const allStaticFindings = [...diffGuardFindings, ...staticAnalysisResult.findings];

  return {
    diffs,
    staticAnalysisFindings: allStaticFindings,
    degradedModes,
    impactAnalysis,
    riskSignals: enrichRiskSignalsWithImpact(riskSignalsBase, impactAnalysis),
  };
}

function extractRiskSignalsFromDiffs(diffs: NormalizedDiff[]): string[] {
  const contentSignals = new Set<string>();
  for (const diff of diffs) {
    const content = diff.hunks.flatMap((hunk) => hunk.lines.map((line) => line.content)).join('\n');

    if (/auth[_-]?(?:middleware|guard|token|jwt)/i.test(content) || /requiresAuth/i.test(content))
      contentSignals.add('auth');
    if (/(?:can|has)[A-Z][a-z]+Permission/.test(content)) contentSignals.add('permission');
    if (/stripe|payment|billing|charge/i.test(content)) contentSignals.add('payment');
    if (/delete|remove|drop|truncate/i.test(content)) contentSignals.add('deletion');
    if (/migration|migrate|ALTER TABLE|CREATE TABLE/i.test(content))
      contentSignals.add('migration');
    if (/transaction|BEGIN|COMMIT|ROLLBACK/i.test(content)) contentSignals.add('transaction');
    if (/mutex|lock|semaphore|atomic|race/i.test(content)) contentSignals.add('concurrency');
    if (/invalidate|evict|flush.*cache/i.test(content)) contentSignals.add('cache_invalidation');
    if (/validate|sanitize|escape/i.test(content)) contentSignals.add('input_validation');
    if (/fetch|axios|got|http\.(?:get|post)/i.test(content))
      contentSignals.add('external_api_error');
    if (/schema\.ts|\.sql|migration/i.test(content)) contentSignals.add('db_schema_change');
    if (/\.env|config\.|settings\./i.test(content)) contentSignals.add('config_changed');
    if (/TODO.*test|FIXME.*test/i.test(content)) contentSignals.add('tests_absent');

    if (diff.classification.isMigration) contentSignals.add('migration');
    if (diff.classification.isConfig) contentSignals.add('config_changed');
    if (diff.classification.isInfra) contentSignals.add('infra_change');
    if (diff.changeType === 'renamed') contentSignals.add('rename_only');
  }

  return [...contentSignals];
}

export async function runReviewStageB(
  req: ReviewRequest,
  deps: RunReviewDeps = {},
): Promise<ReviewOutput> {
  const startTime = deps.now?.() ?? Date.now();
  const now = deps.now ?? Date.now;

  validateAllowedRoot(req.repoPath);
  validateSessionId(req.sessionId);

  let rawDiff: string;
  try {
    rawDiff = await (deps.diffProvider ?? getDiff)(req.repoPath, req.mode);
  } catch (error) {
    throw new ReviewError('E005', `Git diff failed: ${error}`);
  }

  if (!rawDiff.trim()) {
    return buildNoChangesResult(startTime, now);
  }

  enforceHardLimit(rawDiff);

  const knowledgePolicy = resolveKnowledgePolicy(req, 'best_effort');
  if (knowledgePolicy === 'required') {
    // Fast mode should not bypass required knowledge policy.
    return runReviewStageC(req, deps);
  }

  const state = await buildReviewDiffState(
    req.repoPath,
    req.enableStaticAnalysis,
    deps.mcpCaller,
    rawDiff,
  );

  const plan = planReview(state.riskSignals);
  const llmService =
    deps.llmService ?? (await getReviewLLMService(plan.useHeavyLLM ? 'cloud' : 'local'));
  const maskedDiff = maskOrThrow(rawDiff, true);

  const {
    findings: llmFindings,
    summary,
    next_actions,
  } = await reviewWithLLM(
    {
      instruction: req.taskGoal ?? '',
      projectInfo: {
        language: state.diffs[0]?.language ?? 'unknown',
        framework: state.diffs[0]?.classification.framework,
      },
      rawDiff: maskedDiff,
      diffSummary: {
        filesChanged: state.diffs.length,
        linesAdded: countAddedLines(state.diffs),
        linesRemoved: countRemovedLines(state.diffs),
        riskSignals: state.riskSignals,
      },
      selectedHunks: state.diffs,
      staticAnalysisFindings: state.staticAnalysisFindings,
      impactAnalysis: state.impactAnalysis,
      outputSchema: {},
    },
    llmService,
  );

  const mergedFindings = validateFindingsFull(
    mergeFindings(state.staticAnalysisFindings, llmFindings),
    state.diffs,
  );
  const result = ReviewOutputSchema.parse({
    review_id: randomUUID(),
    task_id: req.taskId,
    review_status: deriveReviewStatus(mergedFindings),
    findings: mergedFindings,
    summary,
    next_actions,
    rerun_review: mergedFindings.some((finding) => finding.severity === 'error'),
    metadata: {
      reviewed_files: state.diffs.length,
      risk_level: plan.riskLevel,
      static_analysis_used: state.staticAnalysisFindings.length > 0,
      knowledge_applied: [],
      degraded_mode: state.degradedModes.length > 0,
      degraded_reasons: state.degradedModes,
      local_llm_used: llmService.provider === 'local',
      heavy_llm_used: llmService.provider === 'cloud',
      review_duration_ms: now() - startTime,
      knowledge_policy: knowledgePolicy,
      knowledge_retrieval_status: 'not_requested',
    },
    markdown: '',
  });

  return buildResult(result);
}

function buildKnowledgeApplied(findings: Finding[]): string[] {
  return [...new Set(findings.flatMap((finding) => finding.knowledge_refs ?? []))];
}

function buildKnowledgeContext(
  principles: GuidanceItem[],
  heuristics: GuidanceItem[],
  patterns: GuidanceItem[],
  skills: GuidanceItem[],
  pastSimilarFindings: string[],
  pastSuccessBenchmarks: string[],
): {
  recalledPrinciples: GuidanceItem[];
  recalledHeuristics: GuidanceItem[];
  recalledPatterns: GuidanceItem[];
  optionalSkills: GuidanceItem[];
  pastSimilarFindings: string[];
  pastSuccessBenchmarks: string[];
} {
  return {
    recalledPrinciples: principles,
    recalledHeuristics: heuristics,
    recalledPatterns: patterns,
    optionalSkills: skills,
    pastSimilarFindings,
    pastSuccessBenchmarks,
  };
}

function resolveKnowledgePolicy(
  req: ReviewRequest,
  defaultPolicy: KnowledgePolicy,
): KnowledgePolicy {
  if (req.knowledgePolicy) return req.knowledgePolicy;
  if (req.enableKnowledgeRetrieval === false) return 'off';
  return defaultPolicy;
}

function isFailureFirewallGoal(goal: string | undefined): boolean {
  return /\bfailure[-_ ]firewall\b/i.test(goal ?? '');
}

function isEmptyKnowledgeModeFail(): boolean {
  return process.env.GNOSIS_REVIEW_EMPTY_KNOWLEDGE_MODE?.trim().toLowerCase() === 'fail';
}

function toRubricCheckpoints(content: string): string[] {
  const checkpoints = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 2);
  if (checkpoints.length > 0) return checkpoints;
  return ['Apply this guidance to changed code paths and validate edge cases.'];
}

function buildRubricFromGuidance(knowledge: {
  principles: GuidanceItem[];
  heuristics: GuidanceItem[];
  patterns: GuidanceItem[];
}): RubricCriterion[] {
  const source = [...knowledge.principles, ...knowledge.heuristics, ...knowledge.patterns].slice(
    0,
    5,
  );
  return source.map((item, index) => ({
    criterionId: `rubric-${index + 1}`,
    title: item.title,
    sourceGuidanceIds: [item.id],
    checkpoints: toRubricCheckpoints(item.content),
  }));
}

function applyKnowledgeBasisDefaults(
  findings: Finding[],
  retrievalStatus: KnowledgeRetrievalStatus,
): Finding[] {
  return findings.map((finding) => {
    if (finding.knowledge_refs?.length || finding.knowledge_basis) return finding;
    if (finding.source === 'static_analysis') {
      return { ...finding, knowledge_basis: 'static_analysis' };
    }
    if (retrievalStatus === 'empty_index' || retrievalStatus === 'no_applicable_knowledge') {
      return { ...finding, knowledge_basis: 'no_applicable_knowledge' };
    }
    return { ...finding, knowledge_basis: 'novel_issue' };
  });
}

function hasKnowledgeRelation(finding: Finding): boolean {
  return Boolean(
    (finding.knowledge_refs && finding.knowledge_refs.length > 0) || finding.knowledge_basis,
  );
}

function validateKnowledgeCoverage(findings: Finding[]): boolean {
  const targets = findings.filter(
    (finding) => finding.severity === 'error' || finding.severity === 'warning',
  );
  if (targets.length === 0) return true;
  return targets.every(hasKnowledgeRelation);
}

function buildRubricEvaluation(rubric: RubricCriterion[], findings: Finding[]): RubricEvaluation[] {
  return rubric.map((criterion) => {
    const related = findings.filter((finding) =>
      (finding.knowledge_refs ?? []).some((id) => criterion.sourceGuidanceIds.includes(id)),
    );
    if (related.length === 0) {
      return {
        criterionId: criterion.criterionId,
        status: 'not_applicable',
        evidence: 'No directly related finding in this diff.',
        sourceGuidanceIds: criterion.sourceGuidanceIds,
      };
    }
    const failed = related.some(
      (finding) => finding.severity === 'error' || finding.severity === 'warning',
    );
    return {
      criterionId: criterion.criterionId,
      status: failed ? 'failed' : 'passed',
      evidence: failed
        ? related
            .map((finding) => `${finding.file_path}:${finding.line_new} ${finding.title}`)
            .join('; ')
        : 'No blocking issue found for this criterion.',
      sourceGuidanceIds: criterion.sourceGuidanceIds,
    };
  });
}

export async function runReviewStageC(
  req: ReviewRequest,
  deps: RunReviewDeps = {},
): Promise<ReviewOutput> {
  const startTime = deps.now?.() ?? Date.now();
  const now = deps.now ?? Date.now;

  validateAllowedRoot(req.repoPath);
  validateSessionId(req.sessionId);

  if (isFailureFirewallGoal(req.taskGoal)) {
    return runFailureFirewallReview(req, deps);
  }

  let rawDiff: string;
  try {
    rawDiff = await (deps.diffProvider ?? getDiff)(req.repoPath, req.mode);
  } catch (error) {
    throw new ReviewError('E005', `Git diff failed: ${error}`);
  }

  if (!rawDiff.trim()) {
    return buildNoChangesResult(startTime, now);
  }

  enforceHardLimit(rawDiff);

  const state = await buildReviewDiffState(
    req.repoPath,
    req.enableStaticAnalysis,
    deps.mcpCaller,
    rawDiff,
  );

  const plan = planReview(state.riskSignals);
  const llmService =
    deps.llmService ?? (await getReviewLLMService(plan.useHeavyLLM ? 'cloud' : 'local'));
  const maskedDiff = maskOrThrow(rawDiff, true);
  const projectKey = getProjectKey(req.repoPath);
  const language = detectPrimaryLanguage(state.diffs);
  const framework = state.diffs.find((diff) => diff.classification.framework)?.classification
    .framework;
  const knowledgePolicy = resolveKnowledgePolicy(req, 'best_effort');
  const retrieveGuidanceFn = deps.retrieveGuidanceFn ?? retrieveGuidance;
  const searchSimilarFindingsFn = deps.searchSimilarFindingsFn ?? searchSimilarFindings;

  let knowledge = {
    principles: [] as GuidanceItem[],
    heuristics: [] as GuidanceItem[],
    patterns: [] as GuidanceItem[],
    skills: [] as GuidanceItem[],
    benchmarks: [] as string[],
  };
  let pastSimilarFindings: string[] = [];
  let knowledgeRetrievalStatus: KnowledgeRetrievalStatus = 'not_requested';
  let knowledgeUnavailableReason: string | undefined;
  let rubric: RubricCriterion[] = [];

  if (knowledgePolicy !== 'off') {
    try {
      knowledge = await retrieveGuidanceFn(projectKey, state.riskSignals, language, framework);
      pastSimilarFindings = await searchSimilarFindingsFn(projectKey, state.riskSignals, language);
      rubric = buildRubricFromGuidance(knowledge);
      const hasKnowledgeSource =
        knowledge.principles.length +
          knowledge.heuristics.length +
          knowledge.patterns.length +
          knowledge.skills.length >
        0;
      if (!hasKnowledgeSource) {
        knowledgeRetrievalStatus = 'empty_index';
        knowledgeUnavailableReason = 'empty_index';
        state.degradedModes.push('knowledge_empty_index');
        if (knowledgePolicy === 'required' && isEmptyKnowledgeModeFail()) {
          throw new ReviewError('E008', 'knowledge retrieval required but index is empty');
        }
      } else {
        knowledgeRetrievalStatus = 'success';
      }
    } catch (error) {
      console.warn(`Knowledge retrieval failed: ${error}`);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('index is empty')) {
        knowledgeRetrievalStatus = 'empty_index';
        knowledgeUnavailableReason = 'empty_index';
        state.degradedModes.push('knowledge_empty_index');
      } else {
        state.degradedModes.push('knowledge_retrieval_failed');
        knowledgeRetrievalStatus = 'failed';
        knowledgeUnavailableReason = 'retrieval_failed';
      }
      if (knowledgePolicy === 'required') {
        throw new ReviewError(
          'E008',
          `knowledge retrieval required but unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const {
    findings: llmFindings,
    summary,
    next_actions,
  } = await reviewWithLLM(
    {
      instruction: req.taskGoal ?? '',
      projectInfo: {
        language,
        framework,
      },
      rawDiff: maskedDiff,
      diffSummary: {
        filesChanged: state.diffs.length,
        linesAdded: countAddedLines(state.diffs),
        linesRemoved: countRemovedLines(state.diffs),
        riskSignals: state.riskSignals,
      },
      selectedHunks: state.diffs,
      staticAnalysisFindings: state.staticAnalysisFindings,
      impactAnalysis: state.impactAnalysis,
      ...buildKnowledgeContext(
        knowledge.principles,
        knowledge.heuristics,
        knowledge.patterns,
        knowledge.skills,
        pastSimilarFindings,
        knowledge.benchmarks,
      ),
      rubric,
      outputSchema: {},
    },
    llmService,
  );

  const mergedFindingsRaw = deduplicateFindings(
    mergeFindings(state.staticAnalysisFindings, validateFindingsFull(llmFindings, state.diffs)),
  );
  const mergedFindings = applyKnowledgeBasisDefaults(mergedFindingsRaw, knowledgeRetrievalStatus);
  const hasKnowledgeApplied = buildKnowledgeApplied(mergedFindings).length > 0;
  if (
    knowledgeRetrievalStatus === 'success' &&
    !hasKnowledgeApplied &&
    mergedFindings.some((finding) => finding.source !== 'static_analysis')
  ) {
    knowledgeRetrievalStatus = 'no_applicable_knowledge';
    knowledgeUnavailableReason = 'no_applicable_knowledge';
    state.degradedModes.push('knowledge_no_applicable');
  }
  if (knowledgePolicy === 'required' && !validateKnowledgeCoverage(mergedFindings)) {
    throw new ReviewError('E008', 'required knowledge policy violated: missing knowledge relation');
  }
  const rubricEvaluation = buildRubricEvaluation(rubric, mergedFindings);

  const result = ReviewOutputSchema.parse({
    review_id: randomUUID(),
    task_id: req.taskId,
    review_status: deriveReviewStatus(mergedFindings),
    findings: mergedFindings,
    summary,
    next_actions,
    rerun_review: mergedFindings.some((finding) => finding.severity === 'error'),
    metadata: {
      reviewed_files: state.diffs.length,
      risk_level: plan.riskLevel,
      static_analysis_used: state.staticAnalysisFindings.length > 0,
      knowledge_applied: buildKnowledgeApplied(mergedFindings),
      degraded_mode: state.degradedModes.length > 0,
      degraded_reasons: state.degradedModes,
      local_llm_used: llmService.provider === 'local',
      heavy_llm_used: llmService.provider === 'cloud',
      review_duration_ms: now() - startTime,
      knowledge_policy: knowledgePolicy,
      knowledge_retrieval_status: knowledgeRetrievalStatus,
      knowledge_unavailable_reason: knowledgeUnavailableReason,
      rubric,
      rubric_evaluation: rubricEvaluation,
    },
    markdown: '',
  });

  const withMarkdown = buildResult(result);

  await persistReviewCase(req, withMarkdown).catch((error) => {
    console.warn(`Stage C persistence failed (non-fatal): ${error}`);
  });

  return withMarkdown;
}

export async function runReviewStageD(
  req: ReviewRequest,
  deps: RunReviewDeps = {},
): Promise<ReviewOutput> {
  const now = deps.now ?? Date.now;
  const result = await runReviewStageC(req, deps);
  const fixSuggestions = await buildFixSuggestions(result.findings, req.repoPath, deps.mcpCaller);
  const reviewKpis = await calculateMetrics(
    {
      start: new Date(now() - 7 * 24 * 60 * 60 * 1000),
      end: new Date(now()),
    },
    getProjectKey(req.repoPath),
  );

  return buildResult({
    ...result,
    fix_suggestions: fixSuggestions,
    review_kpis: reviewKpis,
  });
}

export async function runReviewStageE(
  req: ReviewRequest,
  deps: RunReviewDeps = {},
): Promise<ReviewOutput> {
  const startTime = deps.now?.() ?? Date.now();
  const now = deps.now ?? Date.now;

  validateAllowedRoot(req.repoPath);
  validateSessionId(req.sessionId);

  let rawDiff: string;
  try {
    rawDiff = await (deps.diffProvider ?? getDiff)(req.repoPath, req.mode);
  } catch (error) {
    throw new ReviewError('E005', `Git diff failed: ${error}`);
  }

  if (!rawDiff.trim()) {
    return buildNoChangesResult(startTime, now);
  }

  enforceHardLimit(rawDiff);

  const knowledgePolicy = resolveKnowledgePolicy(req, 'best_effort');
  const retrieveGuidanceFn = deps.retrieveGuidanceFn ?? retrieveGuidance;
  const reviewWithToolsFn = deps.reviewWithToolsFn ?? reviewWithTools;
  const normalizedForSignals = normalizeDiff(rawDiff);
  const riskSignals = extractRiskSignalsFromDiffs(normalizedForSignals);
  const projectKey = getProjectKey(req.repoPath);
  const language = detectPrimaryLanguage(normalizedForSignals);
  const framework = normalizedForSignals.find((diff) => diff.classification.framework)
    ?.classification.framework;

  let knowledge = {
    principles: [] as GuidanceItem[],
    heuristics: [] as GuidanceItem[],
    patterns: [] as GuidanceItem[],
    skills: [] as GuidanceItem[],
    benchmarks: [] as string[],
  };
  let knowledgeRetrievalStatus: KnowledgeRetrievalStatus = 'not_requested';
  let knowledgeUnavailableReason: string | undefined;
  let rubric: RubricCriterion[] = [];
  if (knowledgePolicy !== 'off') {
    try {
      knowledge = await retrieveGuidanceFn(projectKey, riskSignals, language, framework);
      rubric = buildRubricFromGuidance(knowledge);
      const hasKnowledgeSource =
        knowledge.principles.length +
          knowledge.heuristics.length +
          knowledge.patterns.length +
          knowledge.skills.length >
        0;
      if (!hasKnowledgeSource) {
        knowledgeRetrievalStatus = 'empty_index';
        knowledgeUnavailableReason = 'empty_index';
        if (knowledgePolicy === 'required' && isEmptyKnowledgeModeFail()) {
          throw new ReviewError('E008', 'knowledge retrieval required but index is empty');
        }
      } else {
        knowledgeRetrievalStatus = 'success';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('index is empty')) {
        knowledgeRetrievalStatus = 'empty_index';
        knowledgeUnavailableReason = 'empty_index';
      } else {
        knowledgeRetrievalStatus = 'failed';
        knowledgeUnavailableReason = 'retrieval_failed';
      }
      if (knowledgePolicy === 'required') {
        throw new ReviewError(
          'E008',
          `knowledge retrieval required but unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const llmService = deps.llmService ?? (await getReviewLLMService());
  const reviewerAlias = resolveReviewerAlias();

  const ctx: ReviewerToolContext = {
    repoPath: req.repoPath,
    gnosisSessionId: req.sessionId,
    mcpCaller: deps.mcpCaller,
    maxToolRounds: 5,
    webSearchFn: undefined,
  };

  const rubricText =
    rubric.length > 0
      ? rubric
          .map(
            (item) =>
              `- ${item.criterionId}: ${item.title} | sources=${item.sourceGuidanceIds.join(', ')}`,
          )
          .join('\n')
      : '- (no rubric available)';

  const systemPrompt = `
You are a highly skilled software engineer and an expert code reviewer. Perform an autonomous, agentic code review for the following diff.

### Gnosis Memory & Procedural Knowledge
You have access to Gnosis, a sophisticated memory system. Before reaching conclusions:
1. Use 'query_procedure' to fetch project-specific instructions and constraints. Pay special attention to "Golden Paths" (tasks with high confidence).
2. Use 'recall_lessons' if you encounter patterns that might have caused issues in the past.
3. Use 'query_graph' to understand the relationships and dependencies of the components you are auditing.

Knowledge policy: ${knowledgePolicy}
Knowledge retrieval status (pre-check): ${knowledgeRetrievalStatus}
Rubric:
${rubricText}

Goal: ${req.taskGoal ?? 'Review the code changes for bugs, security issues, and maintainability.'}

Return your final review in the following JSON format ONLY:
{
  "findings": [
    {
      "title": "Finding title",
      "severity": "error|warning|info",
      "confidence": "high|medium|low",
      "file_path": "relative/path/to/file",
      "line_new": 123,
      "category": "bug|security|performance|design|maintainability",
      "rationale": "Why this is an issue using evidence from Gnosis memory if applicable",
      "suggested_fix": "How to fix it",
      "evidence": "Code snippet or context",
      "knowledge_refs": ["guidance-id-if-used"],
      "knowledge_basis": "static_analysis|novel_issue|no_applicable_knowledge"
    }
  ],
  "rubric_evaluation": [
    {
      "criterionId": "rubric-1",
      "status": "passed|failed|not_applicable",
      "evidence": "why",
      "sourceGuidanceIds": ["guidance-id"]
    }
  ],
  "summary": "Overall summary of the review, including how past lessons were applied",
  "next_actions": ["Action 1", "Action 2"]
}
`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `The diff to review:\n\n${rawDiff}` },
  ];

  try {
    const finalResponse = await reviewWithToolsFn(llmService, messages, ctx);

    // Attempt to parse JSON from the final response
    let parsed: LLMReviewResult;
    try {
      const jsonMatch = finalResponse.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : finalResponse);
    } catch (e) {
      // Fallback if not JSON
      parsed = {
        findings: [],
        summary: finalResponse,
        next_actions: [],
      };
    }

    const findingsRaw: Finding[] = (parsed.findings ?? []).map((f) => {
      const fingerprint = sha256(`${f.file_path}:${f.line_new}:${f.title}:${f.rationale}`);
      return {
        ...f,
        id: randomUUID(),
        fingerprint,
        needsHumanConfirmation: f.severity !== 'error',
        source: llmService.provider === 'local' ? 'local_llm' : 'heavy_llm',
      };
    });
    const findings = applyKnowledgeBasisDefaults(findingsRaw, knowledgeRetrievalStatus);
    const hasKnowledgeApplied = buildKnowledgeApplied(findings).length > 0;
    if (
      knowledgeRetrievalStatus === 'success' &&
      !hasKnowledgeApplied &&
      findings.some((finding) => finding.source !== 'static_analysis')
    ) {
      knowledgeRetrievalStatus = 'no_applicable_knowledge';
      knowledgeUnavailableReason = 'no_applicable_knowledge';
    }
    if (knowledgePolicy === 'required' && !validateKnowledgeCoverage(findings)) {
      throw new ReviewError(
        'E008',
        'required knowledge policy violated: missing knowledge relation',
      );
    }
    const rubricEvaluation = buildRubricEvaluation(rubric, findings);

    const result = ReviewOutputSchema.parse({
      review_id: randomUUID(),
      task_id: req.taskId,
      review_status: deriveReviewStatus(findings),
      findings,
      summary: parsed.summary || 'Review completed successfully.',
      next_actions: parsed.next_actions || [],
      rerun_review: findings.some((f) => f.severity === 'error'),
      metadata: {
        reviewed_files: countChangedFiles(rawDiff),
        risk_level: determineRiskLevel(findings),
        static_analysis_used: true, // Agentic review implicitly uses static tools if needed
        knowledge_applied: buildKnowledgeApplied(findings),
        degraded_mode: knowledgeRetrievalStatus !== 'success' && knowledgePolicy !== 'off',
        degraded_reasons:
          knowledgeRetrievalStatus === 'failed'
            ? (['knowledge_retrieval_failed'] as DegradedMode[])
            : knowledgeRetrievalStatus === 'empty_index'
              ? (['knowledge_empty_index'] as DegradedMode[])
              : knowledgeRetrievalStatus === 'no_applicable_knowledge'
                ? (['knowledge_no_applicable'] as DegradedMode[])
                : [],
        local_llm_used: llmService.provider === 'local',
        heavy_llm_used: llmService.provider === 'cloud',
        review_duration_ms: now() - startTime,
        knowledge_policy: knowledgePolicy,
        knowledge_retrieval_status: knowledgeRetrievalStatus,
        knowledge_unavailable_reason: knowledgeUnavailableReason,
        rubric,
        rubric_evaluation: rubricEvaluation,
        // Custom Stage E metadata
        reviewer_alias: reviewerAlias,
        stage: 'E',
      },
      markdown: '',
    });

    // Background call to record outcome in Gnosis memory
    recordReviewResult(result).catch((err) => {
      console.error('[Stage E] Failed to record review outcome:', err);
    });

    return buildResult(result);
  } catch (error) {
    if (error instanceof ReviewError && error.code === 'E006') {
      return buildTimedOutResult(startTime, now);
    }
    throw error;
  }
}

export async function runReviewStageBFromRepo(
  repoPath: string,
  options: Omit<ReviewRequest, 'repoPath'>,
  deps: RunReviewDeps = {},
): Promise<ReviewOutput> {
  return runReviewStageB({ ...options, repoPath }, deps);
}

export async function runReviewStageAFromRepo(
  repoPath: string,
  options: Omit<ReviewRequest, 'repoPath'>,
  deps: RunReviewDeps = {},
): Promise<ReviewOutput> {
  return runReviewStageA({ ...options, repoPath }, deps);
}

export async function resolveCurrentBranch(repoPath: string): Promise<string> {
  try {
    const git = simpleGit(repoPath);
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    return branch.trim() || 'HEAD';
  } catch {
    return 'HEAD';
  }
}
