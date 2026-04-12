import { exec } from 'node:child_process';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { experienceLogs, knowledgeClaims, knowledgeTopics, vibeMemories } from '../db/schema.js';

async function showNotification(message: string, subtitle = 'Gnosis Metrics') {
  const title = 'Gnosis System Report';
  const command = `osascript -e 'display notification "${message}" with title "${title}" subtitle "${subtitle}"'`;

  return new Promise((resolve, reject) => {
    exec(command, (error) => {
      if (error) reject(error);
      else resolve(true);
    });
  });
}

async function getDbSize(): Promise<string> {
  const result = await db.execute(
    sql`SELECT pg_size_pretty(pg_database_size(current_database())) as size`,
  );
  return (result.rows[0] as { size: string }).size;
}

async function main() {
  try {
    const size = await getDbSize();

    // 並列で集計
    const [topicCount, claimCount, skillCount, memoryCount, expCount] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(knowledgeTopics)
        .then((r) => r[0].count),
      db
        .select({ count: sql<number>`count(*)` })
        .from(knowledgeClaims)
        .then((r) => r[0].count),
      db
        .select({ count: sql<number>`count(*)` })
        .from(vibeMemories)
        .where(sql`${vibeMemories.metadata}->>'kind' = 'guidance'`)
        .then((r) => r[0].count),
      db
        .select({ count: sql<number>`count(*)` })
        .from(vibeMemories)
        .where(
          sql`${vibeMemories.metadata}->>'kind' IS NULL OR ${vibeMemories.metadata}->>'kind' != 'guidance'`,
        )
        .then((r) => r[0].count),
      db
        .select({ count: sql<number>`count(*)` })
        .from(experienceLogs)
        .then((r) => r[0].count),
    ]);

    const message = `DB: ${size} / 知識: ${topicCount}個(${claimCount}事実) / スキル: ${skillCount}件 / 記憶: ${memoryCount}件 / 経験: ${expCount}件`;

    await showNotification(message);
    console.log('Notification sent:', message);

    process.exit(0);
  } catch (error) {
    console.error('Failed to generate report:', error);
    process.exit(1);
  }
}

main();
