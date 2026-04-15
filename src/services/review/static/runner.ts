import path from 'node:path';
import { extractChangedFiles } from '../diff/normalizer.js';
import { REVIEW_LIMITS, ReviewError } from '../errors.js';
import type { NormalizedDiff, StaticAnalysisFinding } from '../types.js';
import { classifyFile, detectLanguage } from './classifier.js';

const ALLOWED_TOOLS: Record<
  string,
  Array<{ command: string; args: string[]; source: StaticAnalysisFinding['source'] }>
> = {
  typescript: [
    { command: 'bun', args: ['x', 'tsc', '--noEmit', '--pretty', 'false'], source: 'tsc' },
  ],
  javascript: [
    { command: 'bun', args: ['x', 'tsc', '--noEmit', '--pretty', 'false'], source: 'tsc' },
  ],
  python: [{ command: 'ruff', args: ['check'], source: 'custom' }],
  rust: [{ command: 'cargo', args: ['clippy', '--no-deps'], source: 'custom' }],
  go: [{ command: 'golangci-lint', args: ['run'], source: 'custom' }],
};

const STATIC_ANALYSIS_TIMEOUT_MS = Math.min(20_000, REVIEW_LIMITS.LLM_TIMEOUT_MS);

function isToolAvailable(command: string): boolean {
  if (command === 'bun') return true;
  if (typeof Bun === 'undefined') return false;

  try {
    const proc = Bun.spawn([command, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    void proc.exited;
    return true;
  } catch {
    return false;
  }
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  return new Response(stream).text();
}

async function runTool(
  tool: { command: string; args: string[]; source: StaticAnalysisFinding['source'] },
  projectRoot: string,
): Promise<StaticAnalysisFinding[]> {
  if (typeof Bun === 'undefined') return [];

  const proc = Bun.spawn([tool.command, ...tool.args], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });

  const timer = setTimeout(() => {
    proc.kill('SIGKILL');
  }, STATIC_ANALYSIS_TIMEOUT_MS);

  try {
    const [stdout, stderr] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
    const code = await proc.exited;
    const output = `${stdout}\n${stderr}`.trim();

    if (code !== 0 && !output) {
      throw new ReviewError('E009', `${tool.command} exited with code ${code}`);
    }

    return parseStaticFindings(output, tool.source);
  } finally {
    clearTimeout(timer);
  }
}

function parseStaticFindings(
  output: string,
  source: StaticAnalysisFinding['source'],
): StaticAnalysisFinding[] {
  if (!output.trim()) return [];

  const findings: StaticAnalysisFinding[] = [];
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const tscMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([^:]+):\s+(.+)$/i);
    if (tscMatch) {
      findings.push({
        id: `static-${findings.length + 1}`,
        file_path: tscMatch[1] ?? '',
        line: Number(tscMatch[2]),
        severity: tscMatch[4]?.toLowerCase() === 'warning' ? 'warning' : 'error',
        message: tscMatch[6] ?? line,
        rule_id: tscMatch[5]?.trim(),
        source,
      });
      continue;
    }

    const biomeMatch = line.match(/^(.+?):(\d+):(\d+)\s+(error|warning|info)\s+(.+)$/i);
    if (biomeMatch) {
      findings.push({
        id: `static-${findings.length + 1}`,
        file_path: biomeMatch[1] ?? '',
        line: Number(biomeMatch[2]),
        severity:
          biomeMatch[4]?.toLowerCase() === 'warning'
            ? 'warning'
            : biomeMatch[4]?.toLowerCase() === 'info'
              ? 'info'
              : 'error',
        message: biomeMatch[5] ?? line,
        source,
      });
    }
  }

  const normalized: StaticAnalysisFinding[] = [];
  for (const finding of findings) {
    const line = finding.line;
    if (
      finding.file_path.length > 0 &&
      typeof line === 'number' &&
      Number.isFinite(line) &&
      line > 0
    ) {
      normalized.push(finding);
    }
  }

  return normalized;
}

export async function findPackageRoot(filePath: string): Promise<string> {
  const configFiles = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
  let current = path.dirname(filePath);

  while (current !== path.dirname(current)) {
    for (const configFile of configFiles) {
      try {
        const exists = await Bun.file(path.join(current, configFile)).exists();
        if (exists) return current;
      } catch {
        // ignore
      }
    }
    current = path.dirname(current);
  }

  return process.cwd();
}

function isGeneratedFile(filePath: string): boolean {
  return (
    /(?:^|\/)(?:dist|build|coverage|node_modules)\//i.test(filePath) || /\.d\.ts$/i.test(filePath)
  );
}

export async function runStaticAnalysis(
  files: string[],
  projectRoot: string,
): Promise<{ findings: StaticAnalysisFinding[]; degraded: boolean }> {
  const language = detectLanguage(files[0] ?? '');
  const tools = ALLOWED_TOOLS[language] ?? [];

  for (const tool of tools) {
    if (!isToolAvailable(tool.command)) continue;

    try {
      const result = await runTool(tool, projectRoot);
      return { findings: result, degraded: false };
    } catch (error) {
      console.warn(
        `Static analysis tool failed (${tool.command} ${tool.args.join(' ')}): ${error}`,
      );
    }
  }

  return { findings: [], degraded: true };
}

function isInChangedRange(line: number | undefined, diff: NormalizedDiff): boolean {
  if (typeof line !== 'number' || !Number.isFinite(line) || line <= 0) return false;

  return diff.hunks.some((hunk) => line >= hunk.newStart && line < hunk.newStart + hunk.newLines);
}

export async function runStaticAnalysisOnChanged(
  diffs: NormalizedDiff[],
  projectRoot: string,
): Promise<StaticAnalysisFinding[]> {
  return (await runStaticAnalysisOnChangedDetailed(diffs, projectRoot)).findings;
}

export async function runStaticAnalysisOnChangedDetailed(
  diffs: NormalizedDiff[],
  projectRoot: string,
): Promise<{ findings: StaticAnalysisFinding[]; degraded: boolean }> {
  const reviewableFiles = diffs
    .filter((diff) => !diff.isBinary && !isGeneratedFile(diff.filePath))
    .map((diff) => path.join(projectRoot, diff.filePath));

  if (reviewableFiles.length === 0) return { findings: [], degraded: false };

  const groupedByRoot = new Map<string, string[]>();
  for (const filePath of reviewableFiles) {
    const packageRoot = await findPackageRoot(filePath);
    const items = groupedByRoot.get(packageRoot) ?? [];
    items.push(filePath);
    groupedByRoot.set(packageRoot, items);
  }

  const findings: StaticAnalysisFinding[] = [];
  let degraded = false;
  for (const [root, filesForRoot] of groupedByRoot.entries()) {
    const result = await runStaticAnalysis(filesForRoot, root);
    if (result.degraded) {
      degraded = true;
      continue;
    }

    for (const finding of result.findings) {
      const matchingDiff = diffs.find((diff) => finding.file_path.endsWith(diff.filePath));
      if (!matchingDiff) continue;
      if (!isInChangedRange(finding.line, matchingDiff)) continue;

      findings.push({
        ...finding,
        file_path: matchingDiff.filePath,
      });
    }
  }

  return { findings, degraded };
}

export function toFilePathSet(diffs: NormalizedDiff[]): Set<string> {
  return new Set(extractChangedFiles(diffs).filter((filePath) => !classifyFile(filePath).isTest));
}
