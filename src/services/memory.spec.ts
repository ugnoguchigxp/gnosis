import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { saveMemory, searchMemory } from "./memory.js";
import { db } from "../db/index.js";
import { vibeMemories } from "../db/schema.js";
import { eq } from "drizzle-orm";

describe("Vibe Memory Services", () => {
  const testSessionId = "TEST_MEM_SESSION";

  beforeAll(async () => {
    // Cleanup
    await db.delete(vibeMemories).where(eq(vibeMemories.sessionId, testSessionId));
  });

  afterAll(async () => {
    // Cleanup
    await db.delete(vibeMemories).where(eq(vibeMemories.sessionId, testSessionId));
  });

  test("should save a memory and search it via vector similarity", async () => {
    // 1. Save memory
    const content = "The quick brown fox jumps over the lazy dog";
    const memory = await saveMemory(testSessionId, content, { type: "test" });
    expect(memory.id).toBeDefined();
    
    // Save another unrelated memory
    await saveMemory(testSessionId, "Bun is a fast all-in-one JavaScript runtime", { type: "test2" });

    // 2. Search memory
    // "fox and dog" should match the first memory better
    const results = await searchMemory(testSessionId, "fox and dog", 2);
    expect(results.length).toBeGreaterThan(0);
    
    expect(results[0].content).toBe(content);
    expect(Number(results[0].similarity)).toBeGreaterThan(0.5); // Should have high cosine similarity
  }, 30000); // Extend timeout for python spawn
});
