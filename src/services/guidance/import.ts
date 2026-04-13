import { createHash } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { syncState, vibeMemories } from '../../db/schema.js';
import {
  GuidanceChunkSchema,
  GuidanceManifestSchema,
  GuidanceScopeSchema,
  GuidanceTypeSchema,
} from '../../domain/schemas.js';
import type {
  GuidanceChunk,
  GuidanceManifest,
  GuidanceScope,
  GuidanceType,
} from '../../domain/schemas.js';
import { sha256 } from '../../utils/crypto.js';
import { generateEmbedding } from '../memory.js';
import { splitMarkdownIntoChunks, uniqueStrings } from './chunking.js';
import type {
  GuidanceArchiveFile,
  GuidanceImportDependencies,
  GuidanceImportItemResult,
  GuidanceImportState,
  GuidanceImportSummary,
  GuidanceMemoryRow,
  ImportGuidanceOptions,
  PersistImportInput,
} from './types.js';
import { computeFileHash, isSafeZipEntryPath, listZipEntries, readZipEntryText } from './zip.js';

const ManifestSchema = GuidanceManifestSchema;

const inferGuidanceType = (entryPath: string): GuidanceType => {
  const lower = entryPath.toLowerCase();
  if (lower.includes('rule') || lower.includes('agent')) return 'rule';
  if (lower.includes('skill')) return 'skill';
  return 'skill';
};

const inferScope = (entryPath: string, guidanceType: GuidanceType): GuidanceScope => {
  const basename = path.posix.basename(entryPath).toLowerCase();
  if (basename === 'agents.md') return 'always';
  if (guidanceType === 'rule') return 'on_demand';
  return 'on_demand';
};

const inferPriority = (guidanceType: GuidanceType, scope: GuidanceScope): number => {
  if (scope === 'always' && guidanceType === 'rule') return config.guidance.priorityHigh;
  if (guidanceType === 'rule') return config.guidance.priorityMid;
  return config.guidance.priorityLow;
};

const parseManifest = async (
  zipPath: string,
  entries: string[],
  readEntryText: (zipPath: string, entry: string) => Promise<string>,
): Promise<GuidanceManifest | null> => {
  const manifestEntry = entries
    .filter((entry) => path.posix.basename(entry).toLowerCase() === 'manifest.json')
    .sort((a, b) => a.split('/').length - b.split('/').length)[0];

  if (!manifestEntry) return null;

  try {
    const text = await readEntryText(zipPath, manifestEntry);
    const parsed = JSON.parse(text) as unknown;
    return ManifestSchema.parse(parsed);
  } catch {
    return null;
  }
};

const parseSyncStateCursor = (cursor: unknown): GuidanceImportState => {
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
    return {};
  }

  const raw = cursor as Record<string, unknown>;
  return {
    zipHash: typeof raw.zipHash === 'string' ? raw.zipHash : undefined,
    mtimeMs: typeof raw.mtimeMs === 'number' ? raw.mtimeMs : undefined,
    size: typeof raw.size === 'number' ? raw.size : undefined,
    importedChunks: typeof raw.importedChunks === 'number' ? raw.importedChunks : undefined,
    importedAt: typeof raw.importedAt === 'string' ? raw.importedAt : undefined,
    archiveKey: typeof raw.archiveKey === 'string' ? raw.archiveKey : undefined,
  };
};

const createChunksFromZip = async (
  zipPath: string,
  entries: string[],
  maxFilesPerZip: number,
  maxFileChars: number,
  maxChunkChars: number,
  readEntryText: (zipPath: string, entry: string) => Promise<string>,
  forcedProject?: string,
): Promise<{
  chunks: GuidanceChunk[];
  manifest: GuidanceManifest | null;
}> => {
  const manifest = await parseManifest(zipPath, entries, readEntryText);

  const excludeBasenames = new Set([
    'readme',
    'license',
    'licence',
    'contributing',
    'changelog',
    'security',
    'code_of_conduct',
  ]);

  const markdownEntries = entries
    .filter((entry) => {
      const lowerEntry = entry.toLowerCase();
      if (!lowerEntry.endsWith('.md')) return false;

      const basename = path.posix.basename(lowerEntry, '.md');
      if (excludeBasenames.has(basename)) return false;

      if (basename.startsWith('.')) return false;

      return isSafeZipEntryPath(entry);
    })
    .slice(0, maxFilesPerZip);

  const chunks: GuidanceChunk[] = [];

  for (const entry of markdownEntries) {
    const rawContent = await readEntryText(zipPath, entry);
    const content = rawContent.slice(0, maxFileChars).trim();
    if (content.length === 0) continue;

    const baseName = path.posix.basename(entry, path.posix.extname(entry));
    const dirName = path.posix.dirname(entry);
    const dirTags = dirName === '.' ? [] : dirName.split('/').filter((segment) => segment !== '.');
    const tags = uniqueStrings([...(manifest?.tags ?? []), ...dirTags]);

    const guidanceType = manifest?.defaultGuidanceType ?? inferGuidanceType(entry);
    const scope = manifest?.defaultScope ?? inferScope(entry, guidanceType);
    const priority =
      typeof manifest?.defaultPriority === 'number'
        ? manifest.defaultPriority
        : inferPriority(guidanceType, scope);

    const docTitle = baseName || 'untitled';
    const sectionChunks = splitMarkdownIntoChunks(content, docTitle, maxChunkChars);

    for (const sectionChunk of sectionChunks) {
      chunks.push({
        title: sectionChunk.title,
        content: sectionChunk.content,
        guidanceType,
        scope,
        priority,
        tags,
        entryPath: entry,
        project: forcedProject ?? manifest?.project,
      });
    }
  }

  return { chunks, manifest };
};

const defaultListArchiveFiles = async (inboxDir: string): Promise<GuidanceArchiveFile[]> => {
  const entries = await readdir(inboxDir, { withFileTypes: true });
  const archives: GuidanceArchiveFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.zip')) continue;
    const zipPath = path.join(inboxDir, entry.name);
    const stats = await stat(zipPath);
    archives.push({ zipPath, size: stats.size, mtimeMs: stats.mtimeMs });
  }
  return archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
};

const defaultPersistImport = async (input: PersistImportInput): Promise<void> => {
  await db.transaction(async (tx) => {
    if (input.previousArchiveKey) {
      await tx.delete(vibeMemories).where(
        sql`${vibeMemories.sessionId} = ${input.guidanceSessionId} AND ${
          vibeMemories.metadata
        } @> ${JSON.stringify({
          kind: 'guidance',
          archiveKey: input.previousArchiveKey,
        })}::jsonb`,
      );
    }

    for (const row of input.rows) {
      await tx
        .insert(vibeMemories)
        .values(row)
        .onConflictDoNothing({
          target: [vibeMemories.sessionId, vibeMemories.dedupeKey],
        });
    }

    if (!input.stateExists) {
      await tx.insert(syncState).values({
        id: input.stateId,
        lastSyncedAt: input.now,
        cursor: input.cursor,
        updatedAt: input.now,
      });
    } else {
      await tx
        .update(syncState)
        .set({ lastSyncedAt: input.now, cursor: input.cursor, updatedAt: input.now })
        .where(eq(syncState.id, input.stateId));
    }
  });
};

const defaultGetState = async (stateId: string): Promise<{ cursor: unknown } | null> => {
  const results = await db.select().from(syncState).where(eq(syncState.id, stateId)).limit(1);
  return results[0] ?? null;
};

export async function importGuidanceArchives(
  options: ImportGuidanceOptions = {},
  deps?: Partial<GuidanceImportDependencies>,
): Promise<GuidanceImportSummary> {
  const inboxDir = options.inboxDir ?? config.guidance.inboxDir;
  const guidanceSessionId = options.guidanceSessionId ?? config.guidance.sessionId;
  const maxFilesPerZip = options.maxFilesPerZip ?? config.guidance.maxFilesPerZip;
  const maxZipSizeBytes = options.maxZipSizeBytes ?? config.guidance.maxZipSizeBytes;
  const maxChunkChars = options.maxChunkChars ?? config.guidance.maxChunkChars;
  const maxFileChars = options.maxFileChars ?? config.guidance.maxFileChars;
  const maxZips = options.maxZips ?? config.guidance.maxZips;
  const dryRun = options.dryRun ?? false;

  const resolvedDeps = {
    listArchiveFiles: deps?.listArchiveFiles ?? defaultListArchiveFiles,
    listZipEntries: deps?.listZipEntries ?? listZipEntries,
    readZipEntryText: deps?.readZipEntryText ?? readZipEntryText,
    computeFileHash: deps?.computeFileHash ?? computeFileHash,
    generateEmbedding: deps?.generateEmbedding ?? generateEmbedding,
    repository: deps?.repository ?? {
      getState: defaultGetState,
      persistImport: defaultPersistImport,
    },
    now: deps?.now ?? (() => new Date()),
  };

  await mkdir(inboxDir, { recursive: true });

  const allArchives = await resolvedDeps.listArchiveFiles(inboxDir);
  const archives = allArchives.slice(0, maxZips);

  const summary: GuidanceImportSummary = {
    scanned: archives.length,
    imported: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    chunksImported: 0,
    results: [],
  };

  for (const archive of archives) {
    const zipPath = archive.zipPath;

    if (archive.size > maxZipSizeBytes) {
      summary.failed++;
      summary.results.push({
        zipPath,
        status: 'failed',
        chunkCount: 0,
        error: `ZIP exceeds ${maxZipSizeBytes} bytes`,
      });
      continue;
    }

    const resolved = path.resolve(zipPath);
    const digest = createHash('sha256').update(resolved).digest('hex');
    const stateId = `guidance:zip:${digest}`;

    try {
      const state = await resolvedDeps.repository.getState(stateId);
      const previousCursor = parseSyncStateCursor(state?.cursor);

      const zipHash = await resolvedDeps.computeFileHash(zipPath);

      if (
        state &&
        previousCursor.zipHash === zipHash &&
        previousCursor.mtimeMs === archive.mtimeMs &&
        previousCursor.size === archive.size
      ) {
        summary.unchanged++;
        summary.results.push({
          zipPath,
          status: 'unchanged',
          chunkCount: previousCursor.importedChunks ?? 0,
        });
        continue;
      }

      const entries = await resolvedDeps.listZipEntries(zipPath);
      const { chunks } = await createChunksFromZip(
        zipPath,
        entries,
        maxFilesPerZip,
        maxFileChars,
        maxChunkChars,
        resolvedDeps.readZipEntryText,
        options.project,
      );

      if (chunks.length === 0) {
        summary.failed++;
        summary.results.push({
          zipPath,
          status: 'failed',
          chunkCount: 0,
          error: 'No valid chunks found',
        });
        continue;
      }

      const contentHash = sha256(chunks.map((c) => c.content).join('\n'));
      const archiveKey = `archive:content:${contentHash}`;

      const rows: GuidanceMemoryRow[] = [];
      for (const chunk of chunks) {
        const embedding = await resolvedDeps.generateEmbedding(chunk.content);
        const chunkDigest = sha256(
          `${archiveKey}:${chunk.entryPath}:${chunk.title}:${chunk.content}`,
        );
        const dedupeKey = `guidance:${chunkDigest}`;

        rows.push({
          sessionId: guidanceSessionId,
          content: chunk.content,
          embedding,
          dedupeKey,
          metadata: {
            kind: 'guidance',
            guidanceType: chunk.guidanceType,
            scope: chunk.scope,
            priority: chunk.priority,
            title: chunk.title,
            tags: chunk.tags ?? [],
            archiveKey,
            project: chunk.project,
            entryPath: chunk.entryPath,
            importedAt: resolvedDeps.now().toISOString(),
          },
        });
      }

      const newCursor: GuidanceImportState = {
        zipHash,
        mtimeMs: archive.mtimeMs,
        size: archive.size,
        importedChunks: chunks.length,
        importedAt: resolvedDeps.now().toISOString(),
        archiveKey,
      };

      if (!dryRun) {
        await resolvedDeps.repository.persistImport({
          stateId,
          stateExists: state !== null,
          guidanceSessionId,
          archiveKey,
          previousArchiveKey: previousCursor.archiveKey,
          rows,
          cursor: newCursor,
          now: resolvedDeps.now(),
        });
      }

      summary.chunksImported += chunks.length;

      if (state) {
        summary.updated++;
        summary.results.push({
          zipPath,
          status: 'updated',
          chunkCount: chunks.length,
        });
      } else {
        summary.imported++;
        summary.results.push({
          zipPath,
          status: 'imported',
          chunkCount: chunks.length,
        });
      }
    } catch (error) {
      summary.failed++;
      summary.results.push({
        zipPath,
        status: 'failed',
        chunkCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}
