import fs from 'node:fs';
import path from 'node:path';
import { getReviewLLMService } from './llm/reviewer.js';
import {
  runReviewStageA,
  runReviewStageB,
  runReviewStageC,
  runReviewStageD,
  runReviewStageE,
} from './orchestrator.js';
import { ReviewModeSchema, type ReviewOutput, ReviewRequestSchema } from './types.js';

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
  json: boolean;
  stage: 'a' | 'b' | 'c' | 'd' | 'e';
  enableStaticAnalysis: boolean;
};

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
  const stageArg = getArg(argv, '--stage');
  const stage =
    stageArg === 'a' || stageArg === 'c' || stageArg === 'd' || stageArg === 'e' ? stageArg : 'b';
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
  });

  const envPreference = process.env.GNOSIS_REVIEW_LLM_PREFERENCE === 'local' ? 'local' : 'cloud';
  const llmService = await getReviewLLMService(args.llmPreference ?? envPreference);

  let result: ReviewOutput;
  switch (args.stage) {
    case 'a':
      result = await runReviewStageA(request, { llmService });
      break;
    case 'b':
      result = await runReviewStageB(request, { llmService });
      break;
    case 'c':
      result = await runReviewStageC(request, { llmService });
      break;
    case 'd':
      result = await runReviewStageD(request, { llmService });
      break;
    case 'e':
      result = await runReviewStageE(request, { llmService });
      break;
    default:
      result = await runReviewStageB(request, { llmService });
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${result.markdown.trimEnd()}\n`);
}
