import { loadLocalEnv, runCommand } from './lib/quality.js';

type MonitorSnapshot = {
  queue?: {
    pending?: number;
    running?: number;
    deferred?: number;
    failed?: number;
  };
  worker?: {
    lastSuccessTs?: number | null;
    lastFailureTs?: number | null;
    consecutiveFailures?: number;
  };
  eval?: {
    degradedRate?: number;
    passed?: number;
    failed?: number;
  };
};

function formatTs(value: number | null | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('ja-JP', { hour12: false });
}

const run = async () => {
  loadLocalEnv();

  const bun = process.argv[0];
  const result = await runCommand(bun, ['run', 'src/scripts/monitor-snapshot.ts', '--json'], {
    capture: true,
    passthrough: false,
  });

  if (result.code !== 0) {
    process.stdout.write(
      '[observe:worker] skipped: local monitor snapshot is unavailable. Start the local database and worker before rerunning.\n',
    );
    return;
  }

  const snapshot = JSON.parse(result.stdout) as MonitorSnapshot;
  const queue = snapshot.queue ?? {};
  const worker = snapshot.worker ?? {};
  const evalResult = snapshot.eval ?? {};

  process.stdout.write('[observe:worker] local worker summary\n');
  process.stdout.write(
    `  queue pending=${queue.pending ?? 0} running=${queue.running ?? 0} deferred=${
      queue.deferred ?? 0
    } failed=${queue.failed ?? 0}\n`,
  );
  process.stdout.write(
    `  worker lastSuccess=${formatTs(worker.lastSuccessTs)} lastFailure=${formatTs(
      worker.lastFailureTs,
    )} consecutiveFailures=${worker.consecutiveFailures ?? 0}\n`,
  );
  process.stdout.write(
    `  eval degradedRate=${evalResult.degradedRate ?? 0} passed=${evalResult.passed ?? 0} failed=${
      evalResult.failed ?? 0
    }\n`,
  );
};

run().catch((error) => {
  process.stdout.write(
    `[observe:worker] skipped: ${error instanceof Error ? error.message : String(error)}\n`,
  );
});
