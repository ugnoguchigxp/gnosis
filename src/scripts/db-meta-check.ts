import {
  buildExpectedMigrations,
  loadJournalEntries,
  loadSqlTags,
  validateMigrationMeta,
} from '../db/migrationMeta.js';

async function main() {
  const [journalEntries, sqlTags] = await Promise.all([loadJournalEntries(), loadSqlTags()]);
  const validation = validateMigrationMeta(journalEntries, sqlTags);

  const hasErrors =
    validation.missingSqlForJournal.length > 0 ||
    validation.orphanSqlWithoutJournal.length > 0 ||
    validation.duplicateJournalTags.length > 0 ||
    validation.nonContiguousIndexes.length > 0;

  if (hasErrors) {
    console.error('Migration metadata is inconsistent.');
    if (validation.missingSqlForJournal.length > 0) {
      console.error(
        `- missing SQL files for journal tags: ${validation.missingSqlForJournal.join(', ')}`,
      );
    }
    if (validation.orphanSqlWithoutJournal.length > 0) {
      console.error(
        `- SQL files not registered in _journal.json: ${validation.orphanSqlWithoutJournal.join(
          ', ',
        )}`,
      );
    }
    if (validation.duplicateJournalTags.length > 0) {
      console.error(`- duplicated journal tags: ${validation.duplicateJournalTags.join(', ')}`);
    }
    if (validation.nonContiguousIndexes.length > 0) {
      const detail = validation.nonContiguousIndexes
        .map((entry) => `${entry.tag}(expected ${entry.expected}, actual ${entry.actual})`)
        .join(', ');
      console.error(`- non-contiguous journal indexes: ${detail}`);
    }
    process.exit(1);
  }

  await buildExpectedMigrations();
  console.log(`Migration metadata check passed (${journalEntries.length} entries).`);
}

main().catch((error) => {
  console.error('Failed to check migration metadata:', error);
  process.exit(1);
});
