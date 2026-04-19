import { printCoverageSummary, runCommand } from './lib/quality.js';

const run = async () => {
  const bun = process.argv[0];
  const result = await runCommand(
    bun,
    [
      'test',
      '--coverage',
      '--coverage-include=src/adapters/**',
      '--coverage-include=src/domain/**',
      '--coverage-include=src/mcp/tools/**',
      '--coverage-include=src/services/**',
      '--coverage-include=src/utils/**',
    ],
    { capture: true },
  );

  printCoverageSummary(result.stdout + result.stderr);
  if (result.code !== 0) {
    process.exit(result.code);
  }
};

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
