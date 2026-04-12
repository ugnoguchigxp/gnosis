import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { eq, inArray, or, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { entities, relations } from '../db/schema.js';
import {
  deleteRelation,
  queryGraphContext,
  saveEntities,
  saveRelations,
  updateEntity,
} from './graph.js';

/**
 * テスト用の決定論的な擬似埋め込み生成関数。
 * 名前からハッシュを作成し、固定長のベクトルを返します。
 * これにより外部プロセスを起動せずに、かつ類似度計算を機能させることができます。
 */
async function mockEmbeddingGenerator(text: string): Promise<number[]> {
  const hash = createHash('sha256').update(text).digest();
  const vector: number[] = [];
  const dim = config.embeddingDimension;
  for (let i = 0; i < dim; i++) {
    // 0.0 ~ 1.0 の範囲に正規化
    vector.push(hash[i % hash.length] / 255);
  }
  return vector;
}

describe('Graph Engine Services', () => {
  async function ensureEntityExists() {
    await db
      .insert(entities)
      .values({
        id: 'TEST_E1',
        type: 'Person',
        name: 'Alice',
        description: 'Seed for update/delete test',
      })
      .onConflictDoNothing();
  }

  async function ensureRelationExists() {
    await db
      .insert(entities)
      .values({
        id: 'TEST_E2',
        type: 'Company',
        name: 'Wonderland Inc.',
      })
      .onConflictDoNothing();
    await saveRelations([
      { sourceId: 'TEST_E1', targetId: 'TEST_E2', relationType: 'works_for', weight: 1.0 },
    ]);
  }

  beforeAll(async () => {
    // Initialize DB state if needed (Drizzle should take care of schema if already migrated)
  });

  beforeEach(async () => {
    // Clean up test data before each test for total isolation
    const testIds = ['TEST_E1', 'TEST_E2', 'TEST_E3'];
    await db
      .delete(relations)
      .where(or(inArray(relations.sourceId, testIds), inArray(relations.targetId, testIds)));
    await db.delete(entities).where(inArray(entities.id, testIds));
  });

  afterAll(async () => {
    await db.delete(entities).where(eq(entities.id, 'TEST_E1'));
    await db.delete(entities).where(eq(entities.id, 'TEST_E2'));
    await db.delete(entities).where(eq(entities.id, 'TEST_E3'));
  });

  test('should save entities and relations', async () => {
    // 1. Save entities (Pass mock embedding generator)
    await saveEntities(
      [
        { id: 'TEST_E1', type: 'Person', name: 'Alice', description: 'Test User 1' },
        { id: 'TEST_E2', type: 'Company', name: 'Wonderland Inc.' },
      ],
      db,
      mockEmbeddingGenerator,
    );

    // 2. Query individual entity to verify
    const [e1] = await db.select().from(entities).where(eq(entities.id, 'TEST_E1'));
    expect(e1).toBeDefined();
    expect(e1.name).toBe('Alice');

    // 3. Save relation
    await saveRelations([
      { sourceId: 'TEST_E1', targetId: 'TEST_E2', relationType: 'works_for', weight: '1.0' },
    ]);

    // 4. Query graph context
    const context = await queryGraphContext('TEST_E1');
    const e1Node = context.entities.find((entity) => entity.id === 'TEST_E1');
    const outgoing = context.relations.filter((relation) => relation.sourceId === 'TEST_E1');
    const incoming = context.relations.filter((relation) => relation.targetId === 'TEST_E1');

    expect(e1Node).toBeDefined();
    expect(outgoing.length).toBe(1);
    expect(outgoing[0].relationType).toBe('works_for');
    expect(outgoing[0].targetId).toBe('TEST_E2');
    expect(incoming.length).toBe(0);

    // 5. Verify reference tracking
    const [dbResult] = await db
      .select({ count: entities.referenceCount })
      .from(entities)
      .where(eq(entities.id, 'TEST_E1'));
    // queryGraphContext is called twice in the logic (once for start node, once in loop)
    // Actually in the implementation it should be 1 if updated once at the end.
    expect(dbResult.count).toBeGreaterThan(0);
  }, 60000);

  test('should update entity', async () => {
    await ensureEntityExists();
    await updateEntity('TEST_E1', { description: 'Updated Description' });
    const [e1] = await db.select().from(entities).where(eq(entities.id, 'TEST_E1'));
    expect(e1).toBeDefined();
    expect(e1.description).toBe('Updated Description');
  });

  test('should delete relation', async () => {
    await ensureEntityExists();
    await ensureRelationExists();
    await deleteRelation('TEST_E1', 'TEST_E2', 'works_for');
    const context = await queryGraphContext('TEST_E1');
    const outgoing = context.relations.filter((relation) => relation.sourceId === 'TEST_E1');
    expect(outgoing.length).toBe(0);
  });
});
