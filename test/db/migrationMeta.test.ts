import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type MigrationJournalEntry,
  buildExpectedMigrations,
  sha256Hex,
  validateMigrationMeta,
} from '../../src/db/migrationMeta.js';

describe('migrationMeta', () => {
  it('calculates SHA-256 hash for migration content', () => {
    const hash = sha256Hex('SELECT 1;\n');
    expect(hash).toBe('b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd');
  });

  it('validates journal/sql metadata consistency', () => {
    const journalEntries: MigrationJournalEntry[] = [
      { idx: 0, when: 1000, tag: '0000_init' },
      { idx: 2, when: 2000, tag: '0000_init' },
      { idx: 3, when: 3000, tag: '0003_add_users' },
    ];

    const sqlTags = ['0000_init', '0001_missing', '0003_add_users'];

    const result = validateMigrationMeta(journalEntries, sqlTags);

    expect(result.duplicateJournalTags).toEqual(['0000_init']);
    expect(result.orphanSqlWithoutJournal).toEqual(['0001_missing']);
    expect(result.missingSqlForJournal).toEqual([]);
    expect(result.nonContiguousIndexes).toEqual([
      { expected: 1, actual: 2, tag: '0000_init' },
      { expected: 2, actual: 3, tag: '0003_add_users' },
    ]);
    expect(result.latestJournalTagWithoutSnapshot).toBe('0003_add_users');
  });

  describe('buildExpectedMigrations', () => {
    let rootDir = '';

    beforeEach(async () => {
      if (rootDir) {
        await rm(rootDir, { recursive: true, force: true });
      }
      rootDir = await mkdtemp(join(tmpdir(), 'gnosis-migration-meta-'));
      await mkdir(join(rootDir, 'drizzle/meta'), { recursive: true });
    });

    it('loads entries from journal and computes hashes from SQL files', async () => {
      const journalPath = join(rootDir, 'drizzle/meta/_journal.json');
      const migrationsDir = join(rootDir, 'drizzle');

      await writeFile(
        journalPath,
        JSON.stringify(
          {
            version: '7',
            dialect: 'postgresql',
            entries: [
              { idx: 0, when: 1000, tag: '0000_init', breakpoints: true },
              { idx: 1, when: 2000, tag: '0001_users', breakpoints: true },
            ],
          },
          null,
          2,
        ),
      );

      await writeFile(join(migrationsDir, '0000_init.sql'), 'SELECT 1;\n');
      await writeFile(join(migrationsDir, '0001_users.sql'), 'SELECT 2;\n');

      const expected = await buildExpectedMigrations({ journalPath, migrationsDir });

      expect(expected).toHaveLength(2);
      expect(expected[0]).toMatchObject({ idx: 0, when: 1000, tag: '0000_init' });
      expect(expected[0]?.hash).toBe(sha256Hex('SELECT 1;\n'));
      expect(expected[1]?.hash).toBe(sha256Hex('SELECT 2;\n'));
    });
  });
});
