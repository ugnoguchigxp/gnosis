import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { saveEntities, saveRelations, queryGraphContext, updateEntity, deleteRelation } from "./graph.js";
import { db } from "../db/index.js";
import { entities, relations } from "../db/schema.js";
import { eq } from "drizzle-orm";

describe("Graph Engine Services", () => {
  beforeAll(async () => {
    // Cleanup any existing test data
    await db.delete(entities).where(eq(entities.id, "TEST_E1"));
    await db.delete(entities).where(eq(entities.id, "TEST_E2"));
    await db.delete(entities).where(eq(entities.id, "TEST_E3"));
  });

  afterAll(async () => {
    await db.delete(entities).where(eq(entities.id, "TEST_E1"));
    await db.delete(entities).where(eq(entities.id, "TEST_E2"));
    await db.delete(entities).where(eq(entities.id, "TEST_E3"));
  });

  test("should save entities and relations", async () => {
    // 1. Save entities
    await saveEntities([
      { id: "TEST_E1", type: "Person", name: "Alice", description: "Test User 1" },
      { id: "TEST_E2", type: "Company", name: "Wonderland Inc." }
    ]);

    // 2. Query individual entity to verify
    const [e1] = await db.select().from(entities).where(eq(entities.id, "TEST_E1"));
    expect(e1).toBeDefined();
    expect(e1.name).toBe("Alice");

    // 3. Save relation
    await saveRelations([
      { sourceId: "TEST_E1", targetId: "TEST_E2", relationType: "works_for", weight: "1.0" }
    ]);

    // 4. Query graph context
    const context = await queryGraphContext("TEST_E1");
    expect(context.entityId).toBe("TEST_E1");
    expect(context.outgoing.length).toBe(1);
    expect(context.outgoing[0].relation).toBe("works_for");
    expect(context.outgoing[0].target.id).toBe("TEST_E2");
    expect(context.incoming.length).toBe(0);
  });

  test("should update entity", async () => {
    await updateEntity("TEST_E1", { description: "Updated Description" });
    const [e1] = await db.select().from(entities).where(eq(entities.id, "TEST_E1"));
    expect(e1.description).toBe("Updated Description");
  });

  test("should delete relation", async () => {
    await deleteRelation("TEST_E1", "TEST_E2", "works_for");
    const context = await queryGraphContext("TEST_E1");
    expect(context.outgoing.length).toBe(0);
  });
});
