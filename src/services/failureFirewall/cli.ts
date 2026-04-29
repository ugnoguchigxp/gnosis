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

type LocalLlmPreflightResult = {
  ok: boolean;
  reason?: string;
};

function getArg(argv: string[], key: string): string | undefined {
  const index = argv.indexOf(key);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function isHelpRequest(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h') || argv.includes('help');
}

function renderUsage(): string {
  return `Usage: bun run failure-firewall -- [options]

Options:
  --repo <path>                         Repository root. Defaults to current directory.
  --mode <worktree|git_diff>            Diff source. Defaults to worktree.
  --knowledge-source <entities|dedicated|hybrid>
                                        Knowledge source for rule matching.
  --with-llm                            Add local LLM review. Falls back to fast mode when preflight fails.
  --json                                Print machine-readable JSON.
  -h, --help                            Show this help.

Examples:
  bun run failure-firewall -- --mode worktree
  bun run failure-firewall -- --mode git_diff --json
  bun run failure-firewall -- --knowledge-source dedicated --with-llm`;
}

async function checkLocalLlmPreflight(): Promise<LocalLlmPreflightResult> {
  const base = process.env.LOCAL_LLM_API_BASE_URL?.trim();
  if (!base) {
    return { ok: false, reason: 'LOCAL_LLM_API_BASE_URL is not set' };
  }

  const healthUrl = `${base.replace(/\/+$/, '')}/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    if (response.ok) {
      return { ok: true };
    }
    return { ok: false, reason: `${healthUrl} responded ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
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
  if (isHelpRequest(argv)) {
    process.stdout.write(`${renderUsage()}\n`);
    return;
  }

  try {
    const args = parseArgs(argv);
    const preflight = args.mode === 'with_llm' ? await checkLocalLlmPreflight() : { ok: true };
    const effectiveMode = args.mode === 'with_llm' && !preflight.ok ? 'fast' : args.mode;
    const llmService =
      effectiveMode === 'with_llm'
        ? await getReviewLLMService('local', {
            invoker: 'cli',
            requestId: `failure-firewall:${Date.now()}`,
          })
        : undefined;
    const result = await runFailureFirewall({
      repoPath: args.repoPath,
      diffMode: args.diffMode,
      mode: effectiveMode,
      knowledgeSource: args.knowledgeSource,
      llmService,
    });
    if (args.mode === 'with_llm' && !preflight.ok) {
      result.degradedReasons = [
        ...new Set([
          ...result.degradedReasons,
          `local_llm_preflight_failed:${preflight.reason ?? 'unknown'}`,
        ]),
      ];
      if (!args.json) {
        process.stderr.write(
          `[failure-firewall] local LLM preflight failed; used fast fallback: ${
            preflight.reason ?? 'unknown'
          }\n`,
        );
      }
    }

    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    process.stdout.write(`${renderFailureFirewall(result)}\n`);
  } finally {
    await closeDbPool().catch(() => undefined);
  }
}
