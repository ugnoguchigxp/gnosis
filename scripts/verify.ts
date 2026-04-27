import { COLORS, loadLocalEnv, printCoverageSummary, runCommand } from './lib/quality.js';

type VerifyMode = 'fast' | 'standard' | 'strict';

type Step = {
  name: string;
  command: string;
  args: string[];
  capture?: boolean;
};

function resolveMode(raw?: string): VerifyMode {
  if (raw === 'fast' || raw === 'strict') return raw;
  return 'standard';
}

function buildSteps(mode: VerifyMode, bun: string): Step[] {
  if (mode === 'fast') {
    return [
      { name: 'format-check', command: bun, args: ['x', 'biome', 'ci', '.'] },
      { name: 'lint', command: bun, args: ['run', 'lint'] },
      { name: 'typecheck', command: bun, args: ['x', 'tsc', '--noEmit'] },
      { name: 'build', command: bun, args: ['run', 'build'] },
    ];
  }

  const standard: Step[] = [
    { name: 'format-check', command: bun, args: ['x', 'biome', 'ci', '.'] },
    { name: 'lint', command: bun, args: ['run', 'lint'] },
    { name: 'typecheck', command: bun, args: ['x', 'tsc', '--noEmit'] },
    { name: 'build', command: bun, args: ['run', 'build'] },
    { name: 'test', command: bun, args: ['test'] },
  ];

  if (mode === 'strict') {
    standard.push(
      { name: 'coverage', command: bun, args: ['run', 'test:coverage'], capture: true },
      { name: 'failure-path', command: bun, args: ['run', 'test:failure-path'] },
      { name: 'smoke', command: bun, args: ['run', 'smoke'] },
      { name: 'flaky-check', command: bun, args: ['run', 'test:flaky-check'] },
      { name: 'integration-local', command: bun, args: ['run', 'test:integration:local'] },
    );
  }

  return standard;
}

const run = async () => {
  loadLocalEnv();

  const bun = process.argv[0];
  const mode = resolveMode(process.argv[2]);
  const steps = buildSteps(mode, bun);

  const startedAt = Date.now();
  let failedStep: string | null = null;

  for (const step of steps) {
    process.stdout.write(
      `\n${COLORS.cyan}>>> [verify:${mode}] Starting: ${step.name}${COLORS.reset}\n`,
    );
    const stepStartedAt = Date.now();

    try {
      const result = await runCommand(step.command, step.args, { capture: step.capture });
      if (step.name === 'coverage') {
        printCoverageSummary(result.stdout + result.stderr);
      }
      if (result.code !== 0) {
        throw new Error(
          `${step.command} ${step.args.join(' ')} failed with exit code ${result.code}`,
        );
      }

      const durationMs = Date.now() - stepStartedAt;
      process.stdout.write(
        `${COLORS.green}✔ [verify:${mode}] ${step.name} passed (${durationMs}ms)${COLORS.reset}\n`,
      );
    } catch (error) {
      failedStep = step.name;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${COLORS.red}✘ [verify:${mode}] ${step.name} failed: ${message}${COLORS.reset}\n`,
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
  }

  process.stdout.write(`\n${COLORS.green}✨ verify:${mode} passed (${totalMs}ms)${COLORS.reset}\n`);
};

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
