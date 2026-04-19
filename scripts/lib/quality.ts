import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

export const COVERAGE_WARN_THRESHOLD = 75;
export const CORE_DIRECTORIES = [
  'src/adapters',
  'src/domain',
  'src/mcp',
  'src/services',
  'src/utils',
  'src/config.ts',
];

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunCommandOptions = {
  capture?: boolean;
  env?: NodeJS.ProcessEnv;
  passthrough?: boolean;
};

export type CoverageSummary = {
  fileCount: number;
  avgLine: number;
  avgFunc: number;
};

function normalizeEnvValue(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadLocalEnv(filePath = path.join(process.cwd(), '.env')): void {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || key in process.env) continue;

    const value = trimmed.slice(separatorIndex + 1);
    process.env[key] = normalizeEnvValue(value);
  }
}

export const runCommand = (
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      shell: false,
      env: options.env,
    });

    let stdout = '';
    let stderr = '';

    if (options.capture && child.stdout && child.stderr) {
      child.stdout.on('data', (data) => {
        const text = data.toString();
        if (options.passthrough !== false) {
          process.stdout.write(text);
        }
        stdout += text;
      });
      child.stderr.on('data', (data) => {
        const text = data.toString();
        if (options.passthrough !== false) {
          process.stderr.write(text);
        }
        stderr += text;
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });

export function parseCoverageSummary(output: string): CoverageSummary | null {
  const lines = output.split('\n');
  let coreLineCoverageSum = 0;
  let coreFuncCoverageSum = 0;
  let coreFileCount = 0;

  const ansiRegex = new RegExp(`[${String.fromCharCode(27)}][[(?);]{0,2}(;?\\d)*[A-Za-z]`, 'g');

  for (const line of lines) {
    if (!line.includes('|')) continue;

    const cleanLine = line.replace(ansiRegex, '').trim();
    const parts = cleanLine.split('|').map((part) => part.trim());
    if (parts.length < 3) continue;

    const filePath = parts[0];
    const isMatch = CORE_DIRECTORIES.some((dir) => filePath.startsWith(dir));
    if (!isMatch) continue;

    const funcPct = Number.parseFloat(parts[1]);
    const linePct = Number.parseFloat(parts[2]);
    if (Number.isNaN(funcPct) || Number.isNaN(linePct)) continue;

    coreFuncCoverageSum += funcPct;
    coreLineCoverageSum += linePct;
    coreFileCount += 1;
  }

  if (coreFileCount === 0) return null;

  return {
    fileCount: coreFileCount,
    avgLine: coreLineCoverageSum / coreFileCount,
    avgFunc: coreFuncCoverageSum / coreFileCount,
  };
}

export function printCoverageSummary(output: string): void {
  const summary = parseCoverageSummary(output);
  if (!summary) {
    process.stdout.write(
      `\n${COLORS.yellow}⚠ [coverage] No core files found in coverage report.${COLORS.reset}\n`,
    );
    return;
  }

  const status = summary.avgLine < COVERAGE_WARN_THRESHOLD ? COLORS.yellow : COLORS.green;
  const symbol = summary.avgLine < COVERAGE_WARN_THRESHOLD ? '⚠' : '✔';

  process.stdout.write(
    `\n${status}${symbol} [coverage] Core Coverage (${summary.fileCount} files analyzed)${COLORS.reset}\n`,
  );
  process.stdout.write(`    Sources:   ${CORE_DIRECTORIES.join(', ')}\n`);
  process.stdout.write(
    `    Lines Avg: ${summary.avgLine.toFixed(2)}% (Threshold: ${COVERAGE_WARN_THRESHOLD}%)\n`,
  );
  process.stdout.write(`    Funcs Avg: ${summary.avgFunc.toFixed(2)}%${COLORS.reset}\n`);
}
