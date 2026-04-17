import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export type MigrationJournalEntry = {
  idx: number;
  when: number;
  tag: string;
};

export type MigrationMetaValidation = {
  missingSqlForJournal: string[];
  orphanSqlWithoutJournal: string[];
  duplicateJournalTags: string[];
  nonContiguousIndexes: Array<{ expected: number; actual: number; tag: string }>;
  latestJournalTagWithoutSnapshot: string | null;
};

export type ExpectedMigration = MigrationJournalEntry & {
  hash: string;
  filePath: string;
};

export type LoadMetaOptions = {
  journalPath?: string;
  migrationsDir?: string;
  snapshotsDir?: string;
};

const defaultJournalPath = () => resolve(process.cwd(), 'drizzle/meta/_journal.json');
const defaultMigrationsDir = () => resolve(process.cwd(), 'drizzle');
const defaultSnapshotsDir = () => resolve(process.cwd(), 'drizzle/meta');

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function toMigrationTag(fileName: string): string | null {
  return /^\d+_.+\.sql$/.test(fileName) ? fileName.replace(/\.sql$/, '') : null;
}

export function toSnapshotTag(fileName: string): string | null {
  const matched = fileName.match(/^(\d+)_snapshot\.json$/);
  return matched?.[1] ?? null;
}

export async function loadJournalEntries(
  journalPath = defaultJournalPath(),
): Promise<MigrationJournalEntry[]> {
  const raw = await readFile(journalPath, 'utf-8');
  const parsed = JSON.parse(raw) as {
    entries?: Array<{ idx?: unknown; when?: unknown; tag?: unknown }>;
  };

  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];

  return entries
    .map((entry) => ({
      idx: Number(entry.idx),
      when: Number(entry.when),
      tag: String(entry.tag ?? ''),
    }))
    .filter(
      (entry) => Number.isInteger(entry.idx) && Number.isFinite(entry.when) && entry.tag.length > 0,
    )
    .sort((a, b) => a.idx - b.idx);
}

export async function loadSqlTags(migrationsDir = defaultMigrationsDir()): Promise<string[]> {
  const names = await readdir(migrationsDir);
  return names
    .map(toMigrationTag)
    .filter((tag): tag is string => Boolean(tag))
    .sort((a, b) => a.localeCompare(b));
}

export async function loadSnapshotIndexes(snapshotsDir = defaultSnapshotsDir()): Promise<string[]> {
  const names = await readdir(snapshotsDir);
  return names
    .map(toSnapshotTag)
    .filter((tag): tag is string => Boolean(tag))
    .sort((a, b) => a.localeCompare(b));
}

export function validateMigrationMeta(
  journalEntries: MigrationJournalEntry[],
  sqlTags: string[],
  snapshotIndexes: string[] = [],
): MigrationMetaValidation {
  const journalTags = journalEntries.map((entry) => entry.tag);
  const journalSet = new Set(journalTags);
  const sqlSet = new Set(sqlTags);

  const duplicateJournalTags = Array.from(
    journalTags.reduce(
      (acc, tag) => acc.set(tag, (acc.get(tag) ?? 0) + 1),
      new Map<string, number>(),
    ),
  )
    .filter(([, count]) => count > 1)
    .map(([tag]) => tag)
    .sort((a, b) => a.localeCompare(b));

  const missingSqlForJournal = journalTags
    .filter((tag) => !sqlSet.has(tag))
    .filter((tag, idx, arr) => arr.indexOf(tag) === idx)
    .sort((a, b) => a.localeCompare(b));

  const orphanSqlWithoutJournal = sqlTags
    .filter((tag) => !journalSet.has(tag))
    .sort((a, b) => a.localeCompare(b));

  const nonContiguousIndexes = journalEntries
    .map((entry, index) => ({ expected: index, actual: entry.idx, tag: entry.tag }))
    .filter((entry) => entry.expected !== entry.actual);

  const latestEntry = journalEntries.at(-1);
  const latestJournalTagWithoutSnapshot =
    latestEntry && !snapshotIndexes.includes(String(latestEntry.idx).padStart(4, '0'))
      ? latestEntry.tag
      : null;

  return {
    missingSqlForJournal,
    orphanSqlWithoutJournal,
    duplicateJournalTags,
    nonContiguousIndexes,
    latestJournalTagWithoutSnapshot,
  };
}

export async function buildExpectedMigrations(
  options: LoadMetaOptions = {},
): Promise<ExpectedMigration[]> {
  const journalPath = options.journalPath ?? defaultJournalPath();
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();
  const entries = await loadJournalEntries(journalPath);

  const expected: ExpectedMigration[] = [];

  for (const entry of entries) {
    const filePath = resolve(migrationsDir, `${entry.tag}.sql`);
    const content = await readFile(filePath, 'utf-8');
    expected.push({
      ...entry,
      filePath,
      hash: sha256Hex(content),
    });
  }

  return expected;
}
