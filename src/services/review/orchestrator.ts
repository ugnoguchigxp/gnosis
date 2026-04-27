import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { sha256 } from '../../utils/crypto.js';
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
  type NormalizedDiff,
  type ReviewMetadata,
  type ReviewOutput,
  ReviewOutputSchema,
  type ReviewRequest,
  type ReviewStatus,
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

export async function runReviewStageC(
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

  let knowledge = {
    principles: [] as GuidanceItem[],
    heuristics: [] as GuidanceItem[],
    patterns: [] as GuidanceItem[],
    skills: [] as GuidanceItem[],
    benchmarks: [] as string[],
  };
  let pastSimilarFindings: string[] = [];

  if (req.enableKnowledgeRetrieval !== false) {
    try {
      knowledge = await retrieveGuidance(projectKey, state.riskSignals, language, framework);
      pastSimilarFindings = await searchSimilarFindings(projectKey, state.riskSignals, language);
    } catch (error) {
      console.warn(`Knowledge retrieval failed: ${error}`);
      state.degradedModes.push('knowledge_retrieval_failed');
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
      outputSchema: {},
    },
    llmService,
  );

  const mergedFindings = deduplicateFindings(
    mergeFindings(state.staticAnalysisFindings, validateFindingsFull(llmFindings, state.diffs)),
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
      knowledge_applied: buildKnowledgeApplied(mergedFindings),
      degraded_mode: state.degradedModes.length > 0,
      degraded_reasons: state.degradedModes,
      local_llm_used: llmService.provider === 'local',
      heavy_llm_used: llmService.provider === 'cloud',
      review_duration_ms: now() - startTime,
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

  const llmService = deps.llmService ?? (await getReviewLLMService());
  const reviewerAlias = resolveReviewerAlias();

  const ctx: ReviewerToolContext = {
    repoPath: req.repoPath,
    gnosisSessionId: req.sessionId,
    mcpCaller: deps.mcpCaller,
    maxToolRounds: 5,
    webSearchFn: undefined,
  };

  const systemPrompt = `
You are a highly skilled software engineer and an expert code reviewer. Perform an autonomous, agentic code review for the following diff.

### Gnosis Memory & Procedural Knowledge
You have access to Gnosis, a sophisticated memory system. Before reaching conclusions:
1. Use 'query_procedure' to fetch project-specific instructions and constraints. Pay special attention to "Golden Paths" (tasks with high confidence).
2. Use 'recall_lessons' if you encounter patterns that might have caused issues in the past.
3. Use 'query_graph' to understand the relationships and dependencies of the components you are auditing.

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
      "evidence": "Code snippet or context"
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
    const finalResponse = await reviewWithTools(llmService, messages, ctx);

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

    const findings: Finding[] = (parsed.findings ?? []).map((f) => {
      const fingerprint = sha256(`${f.file_path}:${f.line_new}:${f.title}:${f.rationale}`);
      return {
        ...f,
        id: randomUUID(),
        fingerprint,
        needsHumanConfirmation: f.severity !== 'error',
        source: llmService.provider === 'local' ? 'local_llm' : 'heavy_llm',
      };
    });

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
        knowledge_applied: [],
        degraded_mode: false,
        degraded_reasons: [],
        local_llm_used: llmService.provider === 'local',
        heavy_llm_used: llmService.provider === 'cloud',
        review_duration_ms: now() - startTime,
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
