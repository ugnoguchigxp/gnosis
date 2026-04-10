import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { vibeMemories } from '../db/schema.js';
import { saveMemory, searchMemory } from './memory.js';

describe('Vibe Memory Services', () => {
  const testSessionId = 'TEST_MEM_SESSION';

  beforeAll(async () => {
    // Cleanup
    await db.delete(vibeMemories).where(eq(vibeMemories.sessionId, testSessionId));
  });

  afterAll(async () => {
    // Cleanup
    await db.delete(vibeMemories).where(eq(vibeMemories.sessionId, testSessionId));
  });

  test('should save a memory and search it via vector similarity', async () => {
    // 1. Save memory
    const content = 'The quick brown fox jumps over the lazy dog';
    const memory = await saveMemory(testSessionId, content, { type: 'test' });
    expect(memory.id).toBeDefined();

    // Save another unrelated memory
    await saveMemory(testSessionId, 'Bun is a fast all-in-one JavaScript runtime', {
      type: 'test2',
    });

    // 2. Search memory
    // "fox and dog" should match the first memory better
    const results = await searchMemory(testSessionId, 'fox and dog', 2);
    expect(results.length).toBeGreaterThan(0);

    expect(results[0].content).toBe(content);
    expect(Number(results[0].similarity)).toBeGreaterThan(0.5); // Should have high cosine similarity

    // 3. Verify reference tracking
    const [dbResult] = await db
      .select({
        count: vibeMemories.referenceCount,
        lastRef: vibeMemories.lastReferencedAt,
      })
      .from(vibeMemories)
      .where(eq(vibeMemories.id, results[0].id));

    expect(dbResult.count).toBe(1);
    expect(dbResult.lastRef).not.toBeNull();

    // Check second search increments to 2
    await searchMemory(testSessionId, 'fox and dog', 1);
    const [dbResult2] = await db
      .select({ count: vibeMemories.referenceCount })
      .from(vibeMemories)
      .where(eq(vibeMemories.id, results[0].id));
    expect(dbResult2.count).toBe(2);
  }, 30000); // Extend timeout for python spawn
});
