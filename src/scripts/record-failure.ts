import { saveMemory } from '../services/memory.js';

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (key: string) => {
    const idx = argv.indexOf(key);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };

  const sessionId = getArg('--session-id') || 'llmharness-failures';
  const content = getArg('--content');
  const metadataRaw = getArg('--metadata');

  if (!content) {
    console.error(
      'Usage: bun run src/scripts/record-failure.ts --content "..." [--session-id "..."] [--metadata "{...}"]',
    );
    process.exit(1);
  }

  try {
    let metadata = {};
    if (metadataRaw) {
      try {
        metadata = JSON.parse(metadataRaw);
      } catch (e) {
        console.warn('Metadata parsing failed, using empty object');
      }
    }
    const memory = await saveMemory(sessionId, content, {
      ...metadata,
      status: 'failure',
      type: 'lesson_learned',
    });
    console.log(`Failure recorded: ${memory.id}`);
  } catch (error) {
    console.error('Record failure error:', error);
    process.exit(1);
  }
}

main();
