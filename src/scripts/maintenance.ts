import { sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { scheduler } from '../services/background/scheduler.js';
import { PgJsonbQueueRepository } from '../services/knowflow/queue/pgJsonbRepository.js';

/**
 * Gnosis システムのメンテナンススクリプト。
 * cron 起動や、定期的な整理のために実行されることを想定しています。
 */
async function main() {
  if (process.env.GNOSIS_ENABLE_AUTOMATION !== 'true') {
    console.error('[Maintenance] Automation is OFF. Skipping scheduled maintenance.');
    process.exit(0);
  }

  console.error('=== Gnosis Maintenance Start ===');
  const start = Date.now();

  try {
    // 1. 統合スケスケジューラーの停滞タスク掃除 & 最適化
    console.error('[Maintenance] Cleaning up and optimizing UnifiedTaskScheduler...');
    scheduler.optimize();

    // 2. KnowFlow (Postgres) の停滞タスク掃除
    console.error('[Maintenance] Cleaning up stale tasks in KnowFlow queue...');
    const queueRepo = new PgJsonbQueueRepository(db);
    const knowFlowCleaned = await queueRepo.clearStaleTasks(config.knowflow.worker.cronRunWindowMs);
    console.error(`[Maintenance] KnowFlow tasks cleaned: ${knowFlowCleaned}`);

    // 3. Postgres データベースの統計情報更新
    console.error('[Maintenance] Synchronizing Postgres statistics (ANALYZE)...');
    await db.execute(sql`ANALYZE;`);

    // 4. (任意) 成功済みタスクの削除やアーカイブなどの重い処理をここに追加可能

    const duration = Date.now() - start;
    console.error(`=== Gnosis Maintenance Completed successfully (${duration}ms) ===`);
  } catch (error) {
    console.error('!!! Gnosis Maintenance Failed !!!');
    console.error(error);
    process.exit(1);
  } finally {
    scheduler.close();
  }
}

main();
