import fs from 'node:fs';
import path from 'node:path';
import { getReviewLLMService } from './llm/reviewer.js';
import { runReviewAgentic } from './orchestrator.js';
import {
  KnowledgePolicySchema,
  ReviewModeSchema,
  type ReviewOutput,
  ReviewRequestSchema,
} from './types.js';

type CliArgs = {
  repoPath: string;
  taskId: string;
  baseRef: string;
  headRef: string;
  trigger: 'manual';
  sessionId?: string;
  mode: 'git_diff' | 'worktree';
  goal?: string;
  llmPreference?: 'local' | 'cloud';
  knowledgePolicy?: 'off' | 'best_effort' | 'required';
  exitPolicy: 'strict' | 'balanced' | 'permissive';
  json: boolean;
  stage: 'agentic';
  enableStaticAnalysis: boolean;
};

export function resolveReviewExitCode(output: ReviewOutput, policy: CliArgs['exitPolicy']): number {
  if (policy === 'permissive') return 0;
  if (output.review_status === 'changes_requested') return 3;
  if (policy === 'balanced') return 0;
  if (output.review_status === 'needs_confirmation') return 2;
  if (policy === 'strict' && output.metadata.degraded_mode) return 2;
  return 0;
}

function isReviewDebugEnabled(): boolean {
  const raw = process.env.GNOSIS_REVIEW_DEBUG?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function emitReviewDebugLog(payload: Record<string, unknown>): void {
  if (!isReviewDebugEnabled()) return;
  console.error(`[review-debug] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function getArg(argv: string[], key: string): string | undefined {
  const index = argv.indexOf(key);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const repoPath = getArg(argv, '--repo') ?? process.cwd();
  const taskId = getArg(argv, '--task-id') ?? `review-${Date.now()}`;
  const baseRef = getArg(argv, '--base') ?? 'main';
  const headRef = getArg(argv, '--head') ?? 'HEAD';
  const mode = ReviewModeSchema.parse((getArg(argv, '--mode') ?? 'git_diff') as string);
  const sessionId = getArg(argv, '--session-id');
  const goal = getArg(argv, '--goal');
  const llmFlag = getArg(argv, '--llm');
  const llmPreference = llmFlag === 'local' ? 'local' : llmFlag === 'cloud' ? 'cloud' : undefined;
  const json = argv.includes('--json');
  const knowledgePolicyArg = getArg(argv, '--knowledge-policy');
  const knowledgePolicy = knowledgePolicyArg
    ? KnowledgePolicySchema.parse(knowledgePolicyArg)
    : undefined;
  const exitPolicyArg = getArg(argv, '--exit-policy');
  const exitPolicy =
    exitPolicyArg === 'strict' || exitPolicyArg === 'balanced' ? exitPolicyArg : 'permissive';
  const stageArg = getArg(argv, '--stage');
  if (stageArg && stageArg.trim().length > 0) {
    emitReviewDebugLog({
      event: 'cli_stage_flag_ignored',
      requestedStage: stageArg,
      effectiveStage: 'agentic',
    });
  }
  const stage: CliArgs['stage'] = 'agentic';
  const enableStaticAnalysis = argv.includes('--enable-static-analysis');

  return {
    repoPath,
    taskId,
    baseRef,
    headRef,
    trigger: 'manual',
    sessionId,
    mode,
    goal,
    llmPreference,
    knowledgePolicy,
    exitPolicy,
    json,
    stage,
    enableStaticAnalysis,
  };
}

function deriveSessionId(repoPath: string, branchHint: string): string {
  const repoName = path.basename(repoPath).replace(/[^a-zA-Z0-9_-]+/g, '-');
  const branchName = branchHint.replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `code-review-${repoName}:${branchName || 'HEAD'}`;
}

export async function runReviewCli(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const sessionId = args.sessionId ?? deriveSessionId(args.repoPath, args.baseRef || args.headRef);
  const requestId = `${args.taskId}:${Date.now()}`;

  const request = ReviewRequestSchema.parse({
    taskId: args.taskId,
    repoPath: fs.realpathSync(args.repoPath),
    baseRef: args.baseRef,
    headRef: args.headRef,
    trigger: args.trigger,
    sessionId,
    mode: args.mode,
    taskGoal: args.goal,
    enableStaticAnalysis: args.enableStaticAnalysis,
    knowledgePolicy: args.knowledgePolicy ?? 'best_effort',
  });

  emitReviewDebugLog({
    event: 'cli_review_start',
    requestId,
    repoPath: request.repoPath,
    stage: args.stage,
    mode: args.mode,
    llmPreference: args.llmPreference ?? null,
  });

  const envPreference = process.env.GNOSIS_REVIEW_LLM_PREFERENCE === 'local' ? 'local' : 'cloud';
  const llmService = await getReviewLLMService(args.llmPreference ?? envPreference, {
    invoker: 'cli',
    requestId,
  });

  let result: ReviewOutput;
  try {
    result = await runReviewAgentic(request, { llmService });
  } catch (error) {
    emitReviewDebugLog({
      event: 'cli_review_error',
      requestId,
      stage: args.stage,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  emitReviewDebugLog({
    event: 'cli_review_success',
    requestId,
    stage: args.stage,
    markdownLength: result.markdown.length,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = resolveReviewExitCode(result, args.exitPolicy);
    return;
  }

  process.stdout.write(`${result.markdown.trimEnd()}\n`);
  process.exitCode = resolveReviewExitCode(result, args.exitPolicy);
}
