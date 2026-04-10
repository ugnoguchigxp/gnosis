import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { entities, relations } from '../db/schema.js';
import {
  deleteRelation,
  queryGraphContext,
  saveEntities,
  saveRelations,
  updateEntity,
} from './graph.js';

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
    // Cleanup any existing test data
    await db.delete(entities).where(eq(entities.id, 'TEST_E1'));
    await db.delete(entities).where(eq(entities.id, 'TEST_E2'));
    await db.delete(entities).where(eq(entities.id, 'TEST_E3'));
  });

  afterAll(async () => {
    await db.delete(entities).where(eq(entities.id, 'TEST_E1'));
    await db.delete(entities).where(eq(entities.id, 'TEST_E2'));
    await db.delete(entities).where(eq(entities.id, 'TEST_E3'));
  });

  test('should save entities and relations', async () => {
    // 1. Save entities
    await saveEntities([
      { id: 'TEST_E1', type: 'Person', name: 'Alice', description: 'Test User 1' },
      { id: 'TEST_E2', type: 'Company', name: 'Wonderland Inc.' },
    ]);

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
