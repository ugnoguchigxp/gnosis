import { digestTextIntelligence, saveEntities } from '../services/graph.js';
import { saveMemory } from '../services/memory.js';

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (key: string) => {
    const idx = argv.indexOf(key);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };

  const sessionId = getArg('--session-id') || 'llmharness-verified';
  const content = getArg('--content');
  const metadataRaw = getArg('--metadata');

  if (!content) {
    console.error(
      'Usage: bun run src/scripts/ingest-verified.ts --content "..." [--session-id "..."] [--metadata "{...}"]',
    );
    process.exit(1);
  }

  try {
    let metadata: Record<string, unknown> = {};
    if (metadataRaw) {
      try {
        const parsed = JSON.parse(metadataRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        } else {
          console.warn('Metadata must be a JSON object, using empty object');
        }
      } catch (e) {
        console.warn('Metadata parsing failed, using empty object');
      }
    }

    // 1. Textual Memory
    const memory = await saveMemory(sessionId, content, {
      ...metadata,
      status: 'verified',
      type: 'solution_pattern',
    });

    // 2. Try to extract and save entities/relations to Graph if possible
    try {
      const gIntelligence = await digestTextIntelligence(content);
      const extractedEntities = gIntelligence.map((item) => item.extracted);

      if (extractedEntities.length > 0) {
        await saveEntities(
          extractedEntities.map((entity) => ({
            id: entity.name.toLowerCase().replace(/\s+/g, '-'),
            type: entity.type,
            name: entity.name,
            description: entity.description,
          })),
        );
        // We could also link them here, but keeping it simple for now
      }
    } catch (e) {
      console.warn('Graph ingestion failed (skipping):', e);
    }

    console.log(`Verified solution ingested: ${memory.id}`);
  } catch (error) {
    console.error('Ingest verified error:', error);
    process.exit(1);
  }
}

main();
