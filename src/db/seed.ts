import { and, eq, sql } from 'drizzle-orm';
import { db } from './index.js';
import { vibeMemories } from './schema.js';

const SEED_SESSION_ID = '__system_seed__';
const SEED_MARKER = 'gnosis-bootstrap-v1';

async function main() {
  const [existing] = await db
    .select({ id: vibeMemories.id })
    .from(vibeMemories)
    .where(
      and(
        eq(vibeMemories.sessionId, SEED_SESSION_ID),
        sql`${vibeMemories.metadata} @> ${JSON.stringify({ seedMarker: SEED_MARKER })}::jsonb`,
      ),
    )
    .limit(1);

  if (existing) {
    console.log(`Seed already exists (id=${existing.id}). Skip.`);
    process.exit(0);
  }

  const [inserted] = await db
    .insert(vibeMemories)
    .values({
      sessionId: SEED_SESSION_ID,
      content: 'System bootstrap marker for initialization checks.',
      embedding: null,
      metadata: {
        seedMarker: SEED_MARKER,
        system: true,
        safe: true,
        note: 'No user knowledge impact: isolated seed session only.',
      },
    })
    .returning({ id: vibeMemories.id });

  console.log(`Seed inserted (id=${inserted.id}).`);
  process.exit(0);
}

main().catch((error) => {
  console.error('Failed to run seed:', error);
  process.exit(1);
});
