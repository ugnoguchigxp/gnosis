import { toolEntries } from './src/mcp/tools/index.js';

async function test() {
  const tool = toolEntries.find(t => t.name === 'digest_text');
  if (!tool) throw new Error('Tool not found');

  try {
    console.log('--- Calling tool handler ---');
    const result = await tool.handler({ text: 'Health check from scratch script' });
    console.log('--- Result ---');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('--- Error ---');
    console.error(err);
  }
}

test();
