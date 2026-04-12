import { spawn } from 'node:child_process';

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
  const steps: Array<{ name: string; command: string; args: string[] }> = [
    { name: 'lint', command: 'bun', args: ['run', 'lint'] },
    { name: 'typecheck', command: 'bunx', args: ['tsc', '--noEmit'] },
    { name: 'test', command: 'bun', args: ['test'] },
    { name: 'smoke', command: 'bun', args: ['run', 'smoke'] },
  ];

  const startedAt = Date.now();
  for (const step of steps) {
    process.stdout.write(`[verify] ${step.name}\n`);
    const stepStartedAt = Date.now();
    await runCommand(step.command, step.args);
    const durationMs = Date.now() - stepStartedAt;
    process.stdout.write(`[verify] ${step.name} done (${durationMs}ms)\n`);
  }
  const totalMs = Date.now() - startedAt;
  process.stdout.write(`[verify] all checks passed (${totalMs}ms)\n`);
};

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
