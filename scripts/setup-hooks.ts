import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Target = 'all' | 'cursor' | 'claude' | 'codex' | 'cline' | 'windsurf' | 'generic';

type Options = {
  target: Target;
  dryRun: boolean;
  applyProjectRules: boolean;
  root: string;
};

const START_MARKER = '<!-- gnosis-hooks:start -->';
const END_MARKER = '<!-- gnosis-hooks:end -->';

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
  };

  const rawTarget = (get('--target') ?? 'all').toLowerCase();
  const target: Target =
    rawTarget === 'cursor' ||
    rawTarget === 'claude' ||
    rawTarget === 'codex' ||
    rawTarget === 'cline' ||
    rawTarget === 'windsurf' ||
    rawTarget === 'generic' ||
    rawTarget === 'all'
      ? rawTarget
      : 'all';

  const root = path.resolve(get('--root') ?? process.cwd());
  return {
    target,
    root,
    dryRun: argv.includes('--dry-run'),
    applyProjectRules: argv.includes('--apply-project-rules'),
  };
}

function ensureDir(dirPath: string, dryRun: boolean) {
  if (dryRun) return;
  mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath: string, content: string, dryRun: boolean) {
  if (dryRun) return;
  writeFileSync(filePath, content, 'utf8');
}

function upsertMarkedBlock(
  filePath: string,
  block: string,
  dryRun: boolean,
  allowCreate = true,
): 'created' | 'updated' | 'skipped' {
  const markedBlock = `${START_MARKER}\n${block.trimEnd()}\n${END_MARKER}\n`;

  if (!existsSync(filePath)) {
    if (!allowCreate) return 'skipped';
    if (dryRun) return 'created';
    writeFileSync(filePath, `${markedBlock}`, 'utf8');
    return 'created';
  }

  const current = readFileSync(filePath, 'utf8');
  const start = current.indexOf(START_MARKER);
  const end = current.indexOf(END_MARKER);

  let next: string;
  if (start >= 0 && end > start) {
    next = `${current.slice(0, start)}${markedBlock}${current
      .slice(end + END_MARKER.length)
      .replace(/^\n/, '')}`;
  } else {
    next = `${current.trimEnd()}\n\n${markedBlock}`;
  }

  if (next === current) return 'skipped';

  if (dryRun) return 'updated';

  copyFileSync(filePath, `${filePath}.bak`);
  writeFileSync(filePath, next, 'utf8');
  return 'updated';
}

function buildHookPromptBlock(manualPath: string): string {
  return `
# Gnosis Hook Workflow (Auto-managed)
- Read and follow the hook guide at: ${manualPath}
- Before saying a coding segment is done, call \`task_checkpoint\`.
- Before starting a review, trigger \`task.ready_for_review\` via the review flow.
- If hook gate fails, prioritize fixing lint/typecheck/test before continuing.
- Record completion and failures so episode/lesson candidates are created.
`.trim();
}

function buildManual(): string {
  return `# Gnosis Hook Guide (Global)

This guide defines the shared hook workflow for IDE agents and LLM tools.

## Hook checkpoints
1. Emit a segment checkpoint when an implementation chunk is complete.
2. Run pre-review quality gate before review execution.
3. On completion/failure, ensure candidate records can be generated.

## Required quality gates
- lint
- typecheck
- related test for segment
- full test for ready_for_review

## Failure policy
- Segment lint/typecheck: block_with_guidance
- Segment related test: soft_warn
- Ready_for_review gate: block_progress

## Traceability
- Always preserve runId.
- Use traceId to correlate hook events, review events, and candidates.
`;
}

function buildEnvTemplate(): string {
  return `# Gnosis Hooks runtime defaults
GNOSIS_HOOKS_ENABLED=true
GNOSIS_HOOK_FILE_CHANGED_DEBOUNCE_MS=10000
GNOSIS_HOOK_ACTION_TIMEOUT_SEC_DEFAULT=120
GNOSIS_HOOK_ACTION_TIMEOUT_SEC_MAX=900
`;
}

function buildSnippet(target: Target): string {
  const title = target === 'all' ? 'generic' : target;
  return `# ${title} hook settings snippet

Apply the following instruction in your ${title} rule/system prompt:

- Use Gnosis hook workflow.
- Call task checkpoint at segment boundaries.
- Enforce pre-review quality gate before review.
- Respect hook failures and remediation guidance.

Reference:
- Global hook manual: ~/.gnosis/hooks/manual.md
- Project hook env template: .gnosis/hooks/.env.hooks
`;
}

function targetsToGenerate(target: Target): Target[] {
  if (target === 'all') return ['cursor', 'claude', 'codex', 'cline', 'windsurf', 'generic'];
  return [target];
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = options.root;

  const globalDir = path.join(process.env.HOME ?? projectRoot, '.gnosis', 'hooks');
  const projectHookDir = path.join(projectRoot, '.gnosis', 'hooks');
  const snippetDir = path.join(projectHookDir, 'snippets');

  ensureDir(globalDir, options.dryRun);
  ensureDir(projectHookDir, options.dryRun);
  ensureDir(snippetDir, options.dryRun);

  const manualPath = path.join(globalDir, 'manual.md');
  const envPath = path.join(projectHookDir, '.env.hooks');

  writeText(manualPath, buildManual(), options.dryRun);
  writeText(envPath, buildEnvTemplate(), options.dryRun);

  const generatedTargets = targetsToGenerate(options.target);
  for (const target of generatedTargets) {
    const snippetPath = path.join(snippetDir, `${target}.md`);
    writeText(snippetPath, buildSnippet(target), options.dryRun);
  }

  const updates: Array<{ file: string; result: string }> = [];
  if (options.applyProjectRules) {
    const promptBlock = buildHookPromptBlock(manualPath);
    const mapping = [
      path.join(projectRoot, '.cursorrules'),
      path.join(projectRoot, '.clauderules'),
      path.join(projectRoot, '.ai-rules.md'),
    ];

    for (const filePath of mapping) {
      const result = upsertMarkedBlock(filePath, promptBlock, options.dryRun, true);
      updates.push({ file: filePath, result });
    }
  }

  const lines = [
    `[setup-hooks] root=${projectRoot}`,
    `[setup-hooks] dryRun=${options.dryRun}`,
    `[setup-hooks] target=${options.target}`,
    `[setup-hooks] generated snippets=${generatedTargets.join(',')}`,
    `[setup-hooks] manual=${manualPath}`,
    `[setup-hooks] envTemplate=${envPath}`,
  ];

  if (updates.length > 0) {
    for (const update of updates) {
      lines.push(`[setup-hooks] rules ${update.result}: ${update.file}`);
    }
  } else {
    lines.push('[setup-hooks] project rule files were not modified (use --apply-project-rules).');
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

run();
