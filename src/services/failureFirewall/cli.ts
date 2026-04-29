import fs from 'node:fs';
import { closeDbPool } from '../../db/index.js';
import { getReviewLLMService } from '../review/llm/reviewer.js';
import { renderFailureFirewall, runFailureFirewall } from './index.js';
import { type FailureKnowledgeSourceMode, FailureKnowledgeSourceModeSchema } from './types.js';
import { FailureFirewallModeSchema } from './types.js';

type FailureFirewallCliArgs = {
  repoPath: string;
  diffMode: 'git_diff' | 'worktree';
  mode: 'fast' | 'with_llm';
  knowledgeSource?: FailureKnowledgeSourceMode;
  json: boolean;
};

function getArg(argv: string[], key: string): string | undefined {
  const index = argv.indexOf(key);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function parseArgs(argv: string[]): FailureFirewallCliArgs {
  const repoPath = getArg(argv, '--repo') ?? process.cwd();
  const rawMode = getArg(argv, '--mode') ?? 'worktree';
  const diffMode = rawMode === 'git_diff' || rawMode === 'worktree' ? rawMode : 'worktree';
  const mode = FailureFirewallModeSchema.parse(argv.includes('--with-llm') ? 'with_llm' : 'fast');
  const rawKnowledgeSource = getArg(argv, '--knowledge-source');
  return {
    repoPath: fs.realpathSync(repoPath),
    diffMode,
    mode,
    knowledgeSource: rawKnowledgeSource
      ? FailureKnowledgeSourceModeSchema.parse(rawKnowledgeSource)
      : undefined,
    json: argv.includes('--json'),
  };
}

export async function runFailureFirewallCli(argv = process.argv.slice(2)): Promise<void> {
  try {
    const args = parseArgs(argv);
    const llmService =
      args.mode === 'with_llm'
        ? await getReviewLLMService('local', {
            invoker: 'cli',
            requestId: `failure-firewall:${Date.now()}`,
          })
        : undefined;
    const result = await runFailureFirewall({
      repoPath: args.repoPath,
      diffMode: args.diffMode,
      mode: args.mode,
      knowledgeSource: args.knowledgeSource,
      llmService,
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    process.stdout.write(`${renderFailureFirewall(result)}\n`);
  } finally {
    await closeDbPool().catch(() => undefined);
  }
}
