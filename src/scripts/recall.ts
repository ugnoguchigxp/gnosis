import { searchKnowledgeClaims } from '../services/knowledge.js';
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
    const [memories, claims] = await Promise.all([
      searchMemory(sessionId, queryRaw, limit),
      searchKnowledgeClaims(queryRaw, limit),
    ]);

    const parts: string[] = [];

    for (const [i, m] of memories.entries()) {
      const score = Number(m.similarity).toFixed(4);
      parts.push(`[Memory #${i + 1} score=${score}]\n${m.content}`);
    }

    for (const [i, c] of claims.entries()) {
      const conf = Number(c.confidence).toFixed(4);
      parts.push(`[Knowledge #${i + 1} topic=${c.topic} confidence=${conf}]\n${c.text}`);
    }

    process.stdout.write(parts.join('\n\n'));
  } catch (error) {
    console.error('Recall error:', error);
    process.exit(1);
  }
}

main();
