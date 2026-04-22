import { inArray, sql } from 'drizzle-orm';
import { db, closeDbPool } from '../src/db/index.js';
import { vibeMemories, entities } from '../src/db/schema.js';

const targetIds = [
  'd2e106d3-15e4-422f-92b7-e0ee468e1429',
  '630c9adf-0302-470f-ae1d-299171ad0dd5',
  '989dd93b-fa5f-4aca-b867-e472a0c9410b'
];

async function run() {
  try {
    console.log('Deleting vibeMemories...');
    const deletedMemories = await db.delete(vibeMemories).where(inArray(vibeMemories.id, targetIds)).returning();
    console.log(`Deleted ${deletedMemories.length} vibeMemories.`);

    console.log('Deleting entities...');
    // The previous implementation used generateEntityId('episode', episode.id)
    // which results in 'episode:<uuid>' or similar.
    // metadata.memoryId contains the vibeMemory ID.
    const deletedEntities = await db.delete(entities).where(
      sql`metadata->>'memoryId' IN (${sql.join(targetIds.map(id => sql`${id}`), sql`, `)})`
    ).returning();
    console.log(`Deleted ${deletedEntities.length} entities.`);
  } catch (error) {
    console.error('Error during cleanup:', error);
  } finally {
    await closeDbPool();
  }
}

run();
