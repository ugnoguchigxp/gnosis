import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Pool } = pkg;
import { eq, inArray, sql } from 'drizzle-orm';
import { config } from '../../src/config.js';
import { entities, relations, vibeMemories } from '../../src/db/schema.js';

// Global mocks in other files often break the shared db instance.
// For this integration test, we create a local isolated connection.
const runMonitorEpisodesIntegration = process.env.RUN_MONITOR_EPISODES_INTEGRATION === '1';

describe('Episode Deletion Cascade', () => {
  it('should physically delete episode, raw memories, and associated graph data', async () => {
    if (!runMonitorEpisodesIntegration) {
      console.warn(
        '[skip] monitor-episodes integration test skipped (set RUN_MONITOR_EPISODES_INTEGRATION=1 to enable)',
      );
      return;
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL || config.databaseUrl });
    const localDb = drizzle(pool);

    try {
      await pool.query('select 1');
    } catch {
      console.warn('[skip] monitor-episodes integration test skipped (DB likely unavailable)');
      await pool.end();
      return;
    }

    const sessionId = `test-session-${Date.now()}`;

    try {
      // 1. Create dummy raw memories
      const rawIds = [];
      for (let i = 0; i < 2; i++) {
        const [raw] = await localDb
          .insert(vibeMemories)
          .values({
            sessionId,
            content: `Raw memory ${i}`,
            memoryType: 'raw',
            embedding: new Array(config.embeddingDimension || 384).fill(0),
            dedupeKey: `test-raw-${i}-${Date.now()}`,
          })
          .returning();

        if (!raw) {
          throw new Error(
            `Failed to insert raw memory ${i} (returning() was empty). SessionID: ${sessionId}`,
          );
        }
        rawIds.push(raw.id);
      }

      // 2. Create an episode record
      const [episode] = await localDb
        .insert(vibeMemories)
        .values({
          sessionId,
          content: 'Synthesized episode',
          memoryType: 'episode',
          embedding: new Array(config.embeddingDimension || 384).fill(0),
          metadata: { sourceIds: rawIds },
          dedupeKey: `test-episode-${Date.now()}`,
        })
        .returning();

      if (!episode) {
        throw new Error(
          `Failed to insert episode memory (returning() was empty). SessionID: ${sessionId}`,
        );
      }

      const episodeId = episode.id;
      const episodeEntityId = `episode/${episodeId}`;

      // 3. Create graph data
      // (a) Proxies
      await localDb.insert(entities).values({
        id: episodeEntityId,
        name: 'Episode Entity',
        type: 'episode',
        description: 'Test episode entity',
      });

      // (b) Entity with metadata reference
      const metaEntityId = `entity-with-meta-${Date.now()}`;
      await localDb.insert(entities).values({
        id: metaEntityId,
        name: 'Referenced Entity',
        type: 'concept',
        metadata: { memoryId: episodeId },
      });

      // (c) Relation
      await localDb.insert(relations).values({
        sourceId: episodeEntityId,
        targetId: metaEntityId,
        relationType: 'learned_from',
        weight: 1.0,
      });

      // 4. Execute the deletion script
      console.log(`Executing deletion for test episode: ${episodeId}`);
      const result = spawnSync(
        'bun',
        ['run', 'src/scripts/monitor-episodes.ts', 'delete', episodeId],
        {
          encoding: 'utf-8',
          timeout: 10000, // 10s for the subprocess
        },
      );

      if (result.stdout) console.log('Script Output:', result.stdout);
      if (result.stderr) console.error('Script Error:', result.stderr);

      if (result.error) {
        console.error('Spawn Error:', result.error);
      }

      expect(result.status).toBe(0);
      const parsed = JSON.parse(
        result.stdout
          .split('\n')
          .filter((l) => l.trim().startsWith('{'))
          .pop() || '{}',
      );
      expect(parsed.success).toBe(true);

      // 5. Verify physical deletion
      // (a) Episode memory
      const epCheck = await localDb
        .select()
        .from(vibeMemories)
        .where(eq(vibeMemories.id, episodeId));
      expect(epCheck.length).toBe(0);

      // (b) Raw memories
      const rawCheck = await localDb
        .select()
        .from(vibeMemories)
        .where(inArray(vibeMemories.id, rawIds));
      expect(rawCheck.length).toBe(0);

      // (c) Proxy entity
      const proxyCheck = await localDb
        .select()
        .from(entities)
        .where(eq(entities.id, episodeEntityId));
      expect(proxyCheck.length).toBe(0);

      // (d) Meta entity (specifically deleted via metadata->>'memoryId')
      const metaCheck = await localDb.select().from(entities).where(eq(entities.id, metaEntityId));
      expect(metaCheck.length).toBe(0);

      // (e) Relations
      const relCheck = await localDb
        .select()
        .from(relations)
        .where(sql`source_id = ${episodeEntityId} OR target_id = ${episodeEntityId}`);
      expect(relCheck.length).toBe(0);
    } finally {
      await pool.end();
    }
  }, 15000); // 15s timeout for the test
});
