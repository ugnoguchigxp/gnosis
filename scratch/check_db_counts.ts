import { eq } from 'drizzle-orm';
import { config } from '../src/config.ts';
import { closeDbPool, db } from '../src/db/index.ts';
import { experienceLogs, vibeMemories } from '../src/db/schema.ts';

async function main() {
  const logs = await db.select().from(experienceLogs);
  const vibesGnosis = await db
    .select()
    .from(vibeMemories)
    .where(eq(vibeMemories.sessionId, 'gnosis'));
  const vibesGuidance = await db
    .select()
    .from(vibeMemories)
    .where(eq(vibeMemories.sessionId, config.guidance.sessionId));

  console.log(
    JSON.stringify(
      {
        experienceLogsCount: logs.length,
        vibeGnosisCount: vibesGnosis.length,
        vibeGuidanceCount: vibesGuidance.length,
      },
      null,
      2,
    ),
  );
}

main()
  .catch(console.error)
  .finally(async () => {
    await closeDbPool();
  });
