import { closeDbPool, db } from './src/db/index.ts';
import { vibeMemories } from './src/db/schema.ts';

async function main() {
  const vibes = await db.select().from(vibeMemories);
  const sessionStats = vibes.reduce((acc: Record<string, number>, v) => {
    acc[v.sessionId] = (acc[v.sessionId] || 0) + 1;
    return acc;
  }, {});

  console.log(
    JSON.stringify(
      {
        totalCount: vibes.length,
        sessionStats,
        sample: vibes.slice(0, 5).map((v) => ({
          id: v.id,
          sessionId: v.sessionId,
          content: v.content.slice(0, 50),
          metadata: v.metadata,
        })),
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
