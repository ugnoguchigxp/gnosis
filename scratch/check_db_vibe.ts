import { eq } from 'drizzle-orm';
import { closeDbPool, db } from '../src/db/index.ts';
import { vibeMemories } from '../src/db/schema.ts';

async function main() {
  const vibes = await db.select().from(vibeMemories).where(eq(vibeMemories.sessionId, 'gnosis'));
  console.log(
    JSON.stringify(
      vibes.map((v) => ({
        id: v.id,
        content: v.content.slice(0, 100),
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
