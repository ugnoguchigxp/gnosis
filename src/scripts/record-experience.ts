import { saveExperience } from '../services/experience.js';

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (key: string) => {
    const idx = argv.indexOf(key);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };

  const sessionId = getArg('--session-id');
  const scenarioId = getArg('--scenario-id');
  const attemptRaw = Number(getArg('--attempt'));
  const typeRaw = getArg('--type');
  const content = getArg('--content');
  const failureType = getArg('--failure-type');
  const metadataRaw = getArg('--metadata');

  if (!sessionId || !scenarioId || !typeRaw || !content) {
    console.error(
      'Usage: bun run src/scripts/record-experience.ts --session-id "..." --scenario-id "..." --type "failure|success" --content "..." [--attempt 1] [--failure-type "..."] [--metadata "{...}"]',
    );
    process.exit(1);
  }

  if (typeRaw !== 'failure' && typeRaw !== 'success') {
    console.error(`Invalid --type: ${typeRaw}. Expected "failure" or "success".`);
    process.exit(1);
  }

  const attempt = Number.isFinite(attemptRaw) && attemptRaw > 0 ? Math.floor(attemptRaw) : 1;

  try {
    let metadata = {};
    if (metadataRaw) {
      try {
        metadata = JSON.parse(metadataRaw);
      } catch (e) {
        console.warn('Metadata parsing failed, using empty object');
      }
    }

    const experience = await saveExperience({
      sessionId,
      scenarioId,
      attempt,
      type: typeRaw,
      content,
      failureType,
      metadata,
    });

    console.log(`${typeRaw.toUpperCase()} experience recorded: ${experience.id}`);
  } catch (error) {
    console.error('Record experience error:', error);
    process.exit(1);
  }
}

main();
