import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { importGuidanceArchives } from '../src/services/guidance';
import type { PersistImportInput } from '../src/services/guidance';

const toStateId = (zipPath: string): string => {
  const resolved = path.resolve(zipPath);
  const digest = createHash('sha256').update(resolved).digest('hex');
  return `guidance:zip:${digest}`;
};

describe('importGuidanceArchives', () => {
  it('skips re-import when zip hash is unchanged', async () => {
    const zipPath = '/tmp/inbox/rules.zip';
    const stateId = toStateId(zipPath);

    const persistCalls: unknown[] = [];
    const summary = await importGuidanceArchives(
      {
        inboxDir: '/tmp/inbox',
      },
      {
        listArchiveFiles: async () => [{ zipPath, size: 120, mtimeMs: 1000 }],
        computeFileHash: async () => 'same-hash',
        listZipEntries: async () => ['rules.md'],
        readZipEntryText: async () => '# Rules\n\nAlways log safely.',
        generateEmbedding: async () => [0.1, 0.2, 0.3],
        repository: {
          getState: async (id: string) =>
            id === stateId
              ? {
                  cursor: {
                    zipHash: 'same-hash',
                    mtimeMs: 1000,
                    size: 120,
                    archiveKey: 'archive:content:old',
                  },
                }
              : null,
          persistImport: async (input: PersistImportInput) => {
            persistCalls.push(input);
          },
        },
      },
    );

    expect(summary.unchanged).toBe(1);
    expect(summary.imported).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.chunksImported).toBe(0);
    expect(persistCalls.length).toBe(0);
  });

  it('updates existing archive and passes previous archive key for overwrite', async () => {
    const zipPath = '/tmp/inbox/rules.zip';
    const stateId = toStateId(zipPath);
    const persisted: Array<{
      archiveKey: string;
      previousArchiveKey?: string;
      stateExists: boolean;
      rowsLength: number;
      cursorArchiveKey?: string;
    }> = [];

    const summary = await importGuidanceArchives(
      {
        inboxDir: '/tmp/inbox',
      },
      {
        listArchiveFiles: async () => [{ zipPath, size: 150, mtimeMs: 2000 }],
        computeFileHash: async () => 'new-hash',
        listZipEntries: async () => ['rules.md'],
        readZipEntryText: async () => '# Updated Rules\n\nDo not leak tokens.',
        generateEmbedding: async () => [0.9, 0.8, 0.7],
        repository: {
          getState: async (id: string) =>
            id === stateId
              ? {
                  cursor: {
                    zipHash: 'old-hash',
                    mtimeMs: 1000,
                    size: 100,
                    archiveKey: 'archive:content:old-key',
                  },
                }
              : null,
          persistImport: async (input: PersistImportInput) => {
            persisted.push({
              archiveKey: input.archiveKey,
              previousArchiveKey: input.previousArchiveKey,
              stateExists: input.stateExists,
              rowsLength: input.rows.length,
              cursorArchiveKey: input.cursor.archiveKey,
            });
          },
        },
      },
    );

    expect(summary.updated).toBe(1);
    expect(summary.imported).toBe(0);
    expect(persisted.length).toBe(1);
    expect(persisted[0]?.stateExists).toBe(true);
    expect(persisted[0]?.previousArchiveKey).toBe('archive:content:old-key');
    expect(persisted[0]?.archiveKey.startsWith('archive:content:')).toBe(true);
    expect(persisted[0]?.archiveKey).not.toBe('archive:content:old-key');
    expect(persisted[0]?.rowsLength).toBeGreaterThan(0);
    expect(persisted[0]?.cursorArchiveKey).toBe(persisted[0]?.archiveKey);
  });

  it('falls back without manifest using filename title and directory tags', async () => {
    const zipPath = '/tmp/inbox/react-pack.zip';
    const persisted: Array<{ metadata: Record<string, unknown> }> = [];

    const summary = await importGuidanceArchives(
      {
        inboxDir: '/tmp/inbox',
      },
      {
        listArchiveFiles: async () => [{ zipPath, size: 140, mtimeMs: 3000 }],
        computeFileHash: async () => 'react-hash',
        listZipEntries: async () => ['frontend/react-best.md'],
        readZipEntryText: async () => '# React Best\n\nPrefer small composable hooks.',
        generateEmbedding: async () => [0.2, 0.3, 0.4],
        repository: {
          getState: async () => null,
          persistImport: async (input: PersistImportInput) => {
            for (const row of input.rows) {
              persisted.push({ metadata: row.metadata });
            }
          },
        },
      },
    );

    expect(summary.imported).toBe(1);
    expect(summary.failed).toBe(0);
    expect(persisted.length).toBeGreaterThan(0);

    const metadata = persisted[0]?.metadata ?? {};
    expect(String(metadata.title)).toContain('react-best');
    expect(metadata.entryPath).toBe('frontend/react-best.md');
    expect(metadata.guidanceType).toBe('skill');
    expect(Array.isArray(metadata.tags)).toBe(true);
    expect((metadata.tags as string[]).includes('frontend')).toBe(true);
  });
});
