import { runCommand } from './lib/quality.js';

const FLAKY_SUITE_FILES = [
  'src/services/knowflow/worker/loop.test.ts',
  'test/knowflow/phase1.test.ts',
  'test/memoryLoopLlmRouter.test.ts',
  'test/runner.test.ts',
];

const RUN_COUNT = 3;

const run = async () => {
  const bun = process.argv[0];

  for (let index = 1; index <= RUN_COUNT; index += 1) {
    process.stdout.write(`[flaky-check] run ${index}/${RUN_COUNT}\n`);
    const result = await runCommand(bun, ['test', ...FLAKY_SUITE_FILES]);
    if (result.code !== 0) {
      process.exit(result.code);
    }
  }
};

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
