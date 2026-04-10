import { saveMemory, searchMemory } from './services/memory.js';
import { saveEntities, saveRelations, queryGraphContext } from './services/graph.js';

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
    { id: 'Tokyo', type: 'City', name: '東京' },
    { id: 'Japan', type: 'Country', name: '日本' },
  ]);
  await saveRelations([
    { sourceId: 'Tokyo', targetId: 'Japan', relationType: 'capital_of', weight: '1.0' },
  ]);

  const context = await queryGraphContext('Tokyo');
  console.log('Graph Context for Tokyo:', JSON.stringify(context, null, 2));

  process.exit(0);
}

test().catch(console.error);
