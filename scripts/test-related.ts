import { existsSync } from 'node:fs';
import path from 'node:path';
import { runCommand } from './lib/quality.js';

type Options = {
  maxFiles: number;
  dryRun: boolean;
  baseRef: string;
};

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
  };

  return {
    maxFiles: Math.max(1, Number(get('--max-files') ?? '30')),
    dryRun: argv.includes('--dry-run'),
    baseRef: get('--base-ref') ?? 'HEAD',
  };
}

async function listChangedFiles(baseRef: string): Promise<string[]> {
  const captureOptions = { capture: true, passthrough: false } as const;
  const unstaged = await runCommand(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMRTUXB'],
    captureOptions,
  );
  const staged = await runCommand(
    'git',
    ['diff', '--name-only', '--cached', '--diff-filter=ACMRTUXB'],
    captureOptions,
  );
  const sinceBase = await runCommand(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMRTUXB', baseRef],
    captureOptions,
  );

  const all = `${unstaged.stdout}\n${staged.stdout}\n${sinceBase.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return [...new Set(all)];
}

function isTestFile(filePath: string): boolean {
  return /(?:\.test|\.spec)\.tsx?$/.test(filePath);
}

function toTestCandidates(filePath: string): string[] {
  const normalized = filePath.replace(/\\/g, '/');

  if (isTestFile(normalized)) {
    return [normalized];
  }

  if (!/\.tsx?$/.test(normalized)) {
    return [];
  }

  const withoutExt = normalized.replace(/\.tsx?$/, '');
  const candidates = new Set<string>([
    `${withoutExt}.test.ts`,
    `${withoutExt}.spec.ts`,
    `${withoutExt}.test.tsx`,
    `${withoutExt}.spec.tsx`,
  ]);

  if (withoutExt.startsWith('src/')) {
    const mapped = withoutExt.replace(/^src\//, 'test/');
    candidates.add(`${mapped}.test.ts`);
    candidates.add(`${mapped}.spec.ts`);
    candidates.add(`${mapped}.test.tsx`);
    candidates.add(`${mapped}.spec.tsx`);
  }

  return [...candidates];
}

function resolveExistingTests(candidates: string[]): string[] {
  return candidates.filter((candidate) => existsSync(path.resolve(process.cwd(), candidate)));
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const changedFiles = await listChangedFiles(options.baseRef);

  if (changedFiles.length === 0) {
    process.stdout.write('[test:related] No changed files detected.\n');
    return;
  }

  const rawCandidates = changedFiles.flatMap(toTestCandidates);
  const relatedTests = [...new Set(resolveExistingTests(rawCandidates))].slice(0, options.maxFiles);

  if (relatedTests.length === 0) {
    process.stdout.write(
      `[test:related] No related tests found from ${changedFiles.length} changed files. Skipping.\n`,
    );
    return;
  }

  process.stdout.write(`[test:related] Running ${relatedTests.length} test files.\n`);
  for (const testFile of relatedTests) {
    process.stdout.write(`  - ${testFile}\n`);
  }

  if (options.dryRun) {
    return;
  }

  const result = await runCommand('bun', ['test', ...relatedTests]);
  if (result.code !== 0) {
    throw new Error(`Related test run failed with exit code ${result.code}`);
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
