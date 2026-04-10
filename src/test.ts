import {
  queryGraphContext,
  saveEntities,
  saveRelations,
  searchEntityByQuery,
} from './services/graph.js';
import { deleteMemory, saveMemory, searchMemory } from './services/memory.js';

async function test() {
  console.log('=== Vibe Memory Test ===');
  const memory1 = await saveMemory('session-1', '東京は日本の首都です。', { source: 'test' });
  const memory2 = await saveMemory('session-1', '富士山は日本一高い山です。', { source: 'test' });
  console.log(`Saved memories: ${memory1.id}, ${memory2.id}`);

  console.log("\nSearching for '日本の首都':");
  const results = await searchMemory('session-1', '日本の首都は？');
  for (const r of results) {
    // Number() -> to avoid object printing issues
    console.log(`- [Score: ${Number(r.similarity).toFixed(3)}] ${r.content}`);
  }

  console.log('\n=== Knowledge Graph Test ===');
  await saveEntities([
    { id: 'Tokyo', type: 'City', name: '東京', description: '日本の首都です' },
    { id: 'Japan', type: 'Country', name: '日本', description: '東アジアの島国です' },
    { id: 'Asia', type: 'Region', name: 'アジア', description: 'ユーラシア大陸の東部です' },
  ]);

  await saveRelations([
    { sourceId: 'Tokyo', targetId: 'Japan', relationType: 'capital_of', weight: '1.0' },
    { sourceId: 'Japan', targetId: 'Asia', relationType: 'located_in', weight: '1.0' },
  ]);

  console.log('Searching entity using semantic query: "東アジアの国"');
  const entityId = await searchEntityByQuery('東アジアの国');
  console.log(`Found Entity ID: ${entityId}`);

  if (entityId) {
    const context = await queryGraphContext(entityId, 2); // Depth 2
    console.log(`Graph Context (2 hops) for ${entityId}:`, JSON.stringify(context, null, 2));
  }

  console.log('\n=== Memory Deletion Test ===');
  await deleteMemory(memory1.id);
  const resultsAfterDelete = await searchMemory('session-1', '日本の首都は？');
  console.log(
    `Results length after delete: ${resultsAfterDelete.length} (memory1 string missing here is expected)`,
  );

  process.exit(0);
}

test().catch(console.error);
