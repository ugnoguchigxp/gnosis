import { spawn } from 'node:child_process';

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const runCommand = (command: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
    });
  });

const run = async () => {
  const bun = process.argv[0];
  const steps: Array<{ name: string; command: string; args: string[] }> = [
    { name: 'lint', command: bun, args: ['run', 'lint'] },
    { name: 'typecheck', command: bun, args: ['x', 'tsc', '--noEmit'] },
    { name: 'test', command: bun, args: ['test'] },
    { name: 'smoke', command: bun, args: ['scripts/smoke.ts'] },
  ];

  const startedAt = Date.now();
  let failedStep: string | null = null;

  for (const step of steps) {
    process.stdout.write(`\n${COLORS.cyan}>>> [verify] Starting: ${step.name}${COLORS.reset}\n`);
    const stepStartedAt = Date.now();
    try {
      await runCommand(step.command, step.args);
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
