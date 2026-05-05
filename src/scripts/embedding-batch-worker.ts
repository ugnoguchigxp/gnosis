#!/usr/bin/env bun

import { envBoolean, envNumber } from '../config.js';
import { GNOSIS_CONSTANTS } from '../constants.js';
import { closeDbPool } from '../db/index.js';
import { embeddingBatchTask } from '../services/background/tasks/embeddingBatchTask.js';

async function main(): Promise<void> {
  const automationEnabled = envBoolean(
    process.env.GNOSIS_ENABLE_AUTOMATION,
    GNOSIS_CONSTANTS.AUTOMATION_ENABLED_DEFAULT,
  );
  if (!automationEnabled) {
    console.error('[EmbeddingBatchWorker] Automation is OFF. Skipping embedding batch.');
    return;
  }

  const batchSize = Math.max(1, envNumber(process.env.GNOSIS_EMBED_BATCH_SIZE, 50));
  const startedAt = Date.now();
  try {
    const result = await embeddingBatchTask(batchSize);
    console.log(
      JSON.stringify({
        event: 'embedding_batch.completed',
        processed: result.processed,
        batchSize,
        durationMs: Date.now() - startedAt,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'embedding_batch.failed',
        batchSize,
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    await closeDbPool().catch(() => {});
  }
}

await main();
