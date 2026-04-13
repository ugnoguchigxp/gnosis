import { spawn } from 'node:child_process';

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const COVERAGE_WARN_THRESHOLD = 75;
const CORE_DIRECTORIES = [
  'src/adapters',
  'src/domain',
  'src/mcp',
  'src/services',
  'src/utils',
  'src/config.ts',
];

const runCommand = (
  command: string,
  args: string[],
  capture = false,
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    if (capture && child.stdout && child.stderr) {
      child.stdout.on('data', (data) => {
        const str = data.toString();
        process.stdout.write(str);
        stdout += str;
      });
      child.stderr.on('data', (data) => {
        const str = data.toString();
        process.stderr.write(str);
        stderr += str;
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || capture) {
        resolve({ code: code ?? 1, stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
    });
  });

const run = async () => {
  const bun = process.argv[0];
  const steps: Array<{ name: string; command: string; args: string[] }> = [
    { name: 'format-check', command: bun, args: ['x', 'biome', 'ci', '.'] },
    { name: 'lint', command: bun, args: ['run', 'lint'] },
    { name: 'typecheck', command: bun, args: ['x', 'tsc', '--noEmit'] },
    { name: 'test', command: bun, args: ['test', '--coverage'] },
    { name: 'smoke', command: bun, args: ['scripts/smoke.ts'] },
  ];

  const startedAt = Date.now();
  let failedStep: string | null = null;

  for (const step of steps) {
    process.stdout.write(`\n${COLORS.cyan}>>> [verify] Starting: ${step.name}${COLORS.reset}\n`);
    const stepStartedAt = Date.now();
    try {
      const { code, stdout, stderr } = await runCommand(
        step.command,
        step.args,
        step.name === 'test',
      );
      if (code !== 0 && step.name !== 'test') {
        throw new Error(`${step.command} failed with exit code ${code}`);
      }

      if (step.name === 'test') {
        // Parse coverage from both stdout and stderr (Bun might use both)
        const combinedOutput = stdout + stderr;
        const lines = combinedOutput.split('\n');
        let coreLineCoverageSum = 0;
        let coreFuncCoverageSum = 0;
        let coreFileCount = 0;

        for (const line of lines) {
          if (!line.includes('|')) continue;

          // Remove ANSI codes if present. Use constructor to avoid lint errors with literals.
          const ansiRegex = new RegExp(
            `[${String.fromCharCode(27)}][[(?);]{0,2}(;?\\d)*[A-Za-z]`,
            'g',
          );
          const cleanLine = line.replace(ansiRegex, '').trim();
          const parts = cleanLine.split('|').map((p) => p.trim());

          if (parts.length >= 3) {
            const filePath = parts[0];
            const isMatch = CORE_DIRECTORIES.some((dir) => filePath.startsWith(dir));

            if (isMatch) {
              const funcPct = Number.parseFloat(parts[1]);
              const linePct = Number.parseFloat(parts[2]);

              if (!Number.isNaN(funcPct) && !Number.isNaN(linePct)) {
                coreFuncCoverageSum += funcPct;
                coreLineCoverageSum += linePct;
                coreFileCount++;
              }
            }
          }
        }

        if (coreFileCount > 0) {
          const avgLine = coreLineCoverageSum / coreFileCount;
          const avgFunc = coreFuncCoverageSum / coreFileCount;
          const status = avgLine < COVERAGE_WARN_THRESHOLD ? COLORS.yellow : COLORS.green;
          const symbol = avgLine < COVERAGE_WARN_THRESHOLD ? '⚠' : '✔';

          process.stdout.write(
            `\n${status}${symbol} [verify] Core Coverage (${coreFileCount} files analyzed)${COLORS.reset}\n`,
          );
          process.stdout.write(`    Sources:   ${CORE_DIRECTORIES.join(', ')}\n`);
          process.stdout.write(
            `    Lines Avg: ${avgLine.toFixed(2)}% (Threshold: ${COVERAGE_WARN_THRESHOLD}%)\n`,
          );
          process.stdout.write(`    Funcs Avg: ${avgFunc.toFixed(2)}%${COLORS.reset}\n`);
        } else {
          process.stdout.write(
            `\n${COLORS.yellow}⚠ [verify] No core files found in coverage report.${COLORS.reset}\n`,
          );
        }

        if (code !== 0) {
          throw new Error(`Tests failed with exit code ${code}`);
        }
      }

      const durationMs = Date.now() - stepStartedAt;
      process.stdout.write(
        `${COLORS.green}✔ [verify] ${step.name} passed (${durationMs}ms)${COLORS.reset}\n`,
      );
    } catch (error) {
      failedStep = step.name;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${COLORS.red}✘ [verify] ${step.name} failed: ${message}${COLORS.reset}\n`,
      );
      break;
    }
  }

  const totalMs = Date.now() - startedAt;
  if (failedStep) {
    process.stderr.write(
      `\n${COLORS.red}Verification FAILED at step: ${failedStep}${COLORS.reset}\n`,
    );
    process.exit(1);
  } else {
    process.stdout.write(`\n${COLORS.green}✨ All checks passed! (${totalMs}ms)${COLORS.reset}\n`);
  }
};

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
