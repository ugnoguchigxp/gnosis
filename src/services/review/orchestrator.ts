import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { ReviewError } from './errors.js';
import { validateAllowedRoot } from './foundation/allowedRoots.js';
import { getDiff } from './foundation/gitDiff.js';
import { enforceHardLimit } from './foundation/hardLimit.js';
import { maskOrThrow } from './foundation/secretMask.js';
import { validateSessionId } from './foundation/sessionId.js';
import { getReviewLLMService, reviewWithLLM } from './llm/reviewer.js';
import type { ReviewLLMService } from './llm/types.js';
import { renderReviewMarkdown } from './render/markdown.js';
import {
  type DegradedMode,
  type Finding,
  type ReviewMetadata,
  type ReviewOutput,
  ReviewOutputSchema,
  type ReviewRequest,
  type ReviewStatus,
} from './types.js';

type RunReviewDeps = {
  llmService?: ReviewLLMService;
  now?: () => number;
  diffProvider?: (repoPath: string, mode: ReviewRequest['mode']) => Promise<string>;
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

function buildResult(input: Omit<ReviewOutput, 'markdown'>): ReviewOutput {
  const withMarkdown = {
    ...input,
    markdown: '',
  } satisfies ReviewOutput;
  const markdown = renderReviewMarkdown(withMarkdown);
  return { ...input, markdown };
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
