import { runCommand } from './lib/quality.js';

const FAILURE_PATH_FILES = [
  'src/services/knowflow/worker/loop.test.ts',
  'test/memoryLoopLlmRouter.test.ts',
  'test/runner.test.ts',
  'test/review-stage-a.test.ts',
  'test/review-cloud-provider.test.ts',
  'test/consolidation.test.ts',
];

const run = async () => {
  const bun = process.argv[0];
  const result = await runCommand(bun, ['test', ...FAILURE_PATH_FILES]);
  if (result.code !== 0) {
    process.exit(result.code);
  }
};

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
