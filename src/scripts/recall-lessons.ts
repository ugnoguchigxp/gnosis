import { recallExperienceLessons } from '../services/experience.js';

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (key: string) => {
    const idx = argv.indexOf(key);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };

  const sessionId = getArg('--session-id');
  const query = getArg('--query');
  const limit = Number(getArg('--limit')) || 5;

  if (!sessionId || !query) {
    console.error(
      'Usage: bun run src/scripts/recall-lessons.ts --session-id "..." --query "..." [--limit 5]',
    );
    process.exit(1);
  }

  try {
    const lessons = await recallExperienceLessons(sessionId, query, limit);
    if (lessons.length === 0) {
      console.log('No similar lessons found.');
      return;
    }

    const output = lessons
      .map((lesson, i) => {
        const fail = lesson.failure;
        const score = Number.isFinite(fail.similarity) ? fail.similarity.toFixed(4) : 'N/A';

        let text = `### Lesson #${i + 1} (Similarity: ${score})\n`;
        text += `[Failure] ${fail.failureType || 'UNKNOWN'}: ${fail.content}\n`;

        if (lesson.solutions.length > 0) {
          text += '[Verified Solutions]\n';
          lesson.solutions.forEach((sol, j) => {
            text += `--- Solution #${j + 1} ---\n${sol.content}\n`;
          });
        } else {
          text += '[Solutions] No verified solution linked yet for this failure scenario.\n';
        }
        return text;
      })
      .join('\n\n');

    process.stdout.write(output);
  } catch (error) {
    console.error('Recall lessons error:', error);
    process.exit(1);
  }
}

main();
