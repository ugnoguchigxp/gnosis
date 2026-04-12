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
    {
      name: 'knowflow enqueue dry-run',
      command: 'bun',
      args: [
        'src/services/knowflow/cli.ts',
        'enqueue',
        '--topic',
        'smoke topic',
        '--dry-run',
        '--json',
      ],
    },
    {
      name: 'knowflow merge dry-run',
      command: 'bun',
      args: [
        'src/services/knowflow/cli.ts',
        'merge-knowledge',
        '--input',
        '{"topic":"smoke topic","claims":[],"relations":[],"sources":[]}',
        '--dry-run',
        '--json',
      ],
    },
    {
      name: 'knowflow eval local suite',
      command: 'bun',
      args: ['src/services/knowflow/cli.ts', 'eval-run', '--suite', 'local', '--json'],
    },
  ];

  for (const step of steps) {
    process.stdout.write(`[smoke] ${step.name}\n`);
    await runCommand(step.command, step.args);
  }
};

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
