import { like } from 'drizzle-orm';
import { closeDbPool, db } from './src/db/index.ts';
import { vibeMemories } from './src/db/schema.ts';

async function main() {
  const vibes = await db
    .select()
    .from(vibeMemories)
    .where(like(vibeMemories.content, '%決定論的%'));
  console.log(
    JSON.stringify(
      vibes.map((v) => ({
        id: v.id,
        sessionId: v.sessionId,
        content: v.content.slice(0, 50),
        metadata: v.metadata,
      })),
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
