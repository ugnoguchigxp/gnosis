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
            taskType: 'knowflow_keyword_seed',
            summary: 'phrase scout seeded',
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

    expect(knowflow.lastSeedSummary).toBe('phrase scout seeded');
    expect(knowflow.lastFailureTs).toBeNull();
    expect(knowflow.status).toBe('healthy');
  });

  it('does not stop before reading an older Phrase Scout seed event in the same log', async () => {
    const logsRoot = await mkdtemp(join(tmpdir(), 'gnosis-monitor-snapshot-'));
    await writeFile(
      join(logsRoot, 'runs.jsonl'),
      [
        JSON.stringify({
          ts: '2026-04-29T10:00:00.000Z',
          event: 'knowflow.phrase_scout.completed',
          data: {
            sources: 1,
            phrases: 2,
            enqueued: 2,
          },
        }),
        JSON.stringify({
          ts: '2026-04-29T10:01:00.000Z',
          event: 'task.deferred',
          data: {
            taskId: 'task-1',
            error: 'retry',
          },
        }),
        JSON.stringify({
          ts: '2026-04-29T10:02:00.000Z',
          event: 'task.done',
          data: {
            taskId: 'task-2',
            summary: 'done',
          },
        }),
        JSON.stringify({
          ts: '2026-04-29T10:03:00.000Z',
          event: 'cli.result',
          data: {
            command: 'eval-run',
            result: {
              passedCount: 2,
              failedCount: 0,
              passRate: 100,
            },
          },
        }),
      ].join('\n'),
    );

    const { evalResult, knowflow } = await collectWorkerEvalAndKnowFlow(logsRoot, 10);

    expect(evalResult.passRate).toBe(100);
    expect(knowflow.lastSeedTs).toBe(Date.parse('2026-04-29T10:00:00.000Z'));
    expect(knowflow.lastSeedSummary).toBe('phrase scout: sources=1 phrases=2 enqueued=2');
  });
});
