import { searchMemory } from '../services/memory.js';

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (key: string) => {
    const idx = argv.indexOf(key);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };

  const sessionId = getArg('--session-id') || 'llmharness';
  const queryRaw = getArg('--query');
  const limit = Number(getArg('--limit')) || 5;

  if (!queryRaw) {
    console.error(
      'Usage: bun run src/scripts/recall.ts --query "..." [--session-id "..."] [--limit 5]',
    );
    process.exit(1);
  }

  try {
    const memories = await searchMemory(sessionId, queryRaw, limit);
    if (memories.length === 0) {
      process.stdout.write('');
      return;
    }

    const context = memories
      .map((m, i) => {
        const score = Number(m.similarity).toFixed(4);
        return `[Memory #${i + 1} score=${score}]\n${m.content}`;
      })
      .join('\n\n');

    process.stdout.write(context);
  } catch (error) {
    console.error('Recall error:', error);
    process.exit(1);
  }
}

main();
