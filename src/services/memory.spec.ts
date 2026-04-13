import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

const shouldRunIntegration =
  process.env.GNOSIS_RUN_INTEGRATION === '1' && !!process.env.DATABASE_URL;
const describeIntegration = shouldRunIntegration ? describe : describe.skip;
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { vibeMemories } from '../db/schema.js';
import { saveMemory, searchMemory } from './memory.js';

/**
 * テスト用の決定論的な擬似埋め込み生成関数。
 * 単語の重なりを考慮したベクトルを生成し、セマンティック検索のテストが通るようにします。
 */
function mockEmbeddingGenerator(text: string): number[] {
  const dim = config.embeddingDimension;
  const vector = new Array(dim).fill(0);
  const words = text.toLowerCase().split(/\W+/);
  for (const word of words) {
    if (!word) continue;
    const hash = createHash('md5').update(word).digest();
    for (let i = 0; i < dim; i++) {
      vector[i] += hash[i % 16] / 255 - 0.5;
    }
  }
  // Normalize
  const length = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / length);
}

// Module mock
mock.module('./memory.js', () => {
  return {
    ...require('./memory.js'),
    generateEmbedding: mock(async (text: string) => mockEmbeddingGenerator(text)),
  };
});

describeIntegration('Vibe Memory Services', () => {
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
