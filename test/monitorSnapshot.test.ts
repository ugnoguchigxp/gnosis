import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectWorkerEvalAndKnowFlow } from '../src/scripts/monitor-snapshot';

describe('monitor snapshot log collection', () => {
  it('does not mark KnowFlow degraded for unrelated background task failures', async () => {
    const logsRoot = await mkdtemp(join(tmpdir(), 'gnosis-monitor-snapshot-'));
    await writeFile(
      join(logsRoot, 'runs.jsonl'),
      [
        JSON.stringify({
          ts: '2026-04-29T10:00:00.000Z',
          event: 'background.task.completed',
          data: {
            taskType: 'knowflow_frontier_seed',
            summary: 'frontier seeded',
          },
        }),
        JSON.stringify({
          ts: '2026-04-29T10:01:00.000Z',
          event: 'background.task.failed',
          data: {
            taskType: 'synthesis',
            error: 'unrelated failure',
          },
        }),
      ].join('\n'),
    );

    const { knowflow } = await collectWorkerEvalAndKnowFlow(logsRoot, 10);

    expect(knowflow.lastSeedSummary).toBe('frontier seeded');
    expect(knowflow.lastFailureTs).toBeNull();
    expect(knowflow.status).toBe('healthy');
  });
});
