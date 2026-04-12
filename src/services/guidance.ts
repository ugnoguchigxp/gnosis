import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { syncState, vibeMemories } from '../db/schema.js';
import { generateEmbedding } from './memory.js';

export const DEFAULT_GUIDANCE_SESSION_ID = 'guidance-registry';

type GuidanceType = 'rule' | 'skill';
type GuidanceScope = 'always' | 'on_demand';

type GuidanceManifest = {
  packId?: string;
  sourceRepo?: string;
  license?: string;
  defaultScope?: GuidanceScope;
  defaultGuidanceType?: GuidanceType;
  defaultPriority?: number;
  project?: string;
  tags?: string[];
};

type GuidanceChunk = {
  docPath: string;
  title: string;
  content: string;
  guidanceType: GuidanceType;
  scope: GuidanceScope;
  priority: number;
  tags: string[];
};

type GuidanceImportState = {
  zipHash?: string;
  mtimeMs?: number;
  size?: number;
  importedChunks?: number;
  importedAt?: string;
  archiveKey?: string;
};

export type GuidanceImportItemResult = {
  zipPath: string;
  status: 'unchanged' | 'imported' | 'updated' | 'failed';
  chunkCount: number;
  error?: string;
};

export type GuidanceImportSummary = {
  scanned: number;
  imported: number;
  updated: number;
  unchanged: number;
  failed: number;
  chunksImported: number;
  results: GuidanceImportItemResult[];
};

export type ImportGuidanceOptions = {
  inboxDir?: string;
  guidanceSessionId?: string;
  maxFilesPerZip?: number;
  maxZipSizeBytes?: number;
  maxChunkChars?: number;
  maxFileChars?: number;
  dryRun?: boolean;
  project?: string;
  maxZips?: number;
};

type GuidanceArchiveFile = {
  zipPath: string;
  size: number;
  mtimeMs: number;
};

type GuidanceMemoryRow = {
  sessionId: string;
  content: string;
  embedding: number[];
  dedupeKey: string;
  metadata: Record<string, unknown>;
};

type PersistImportInput = {
  stateId: string;
  stateExists: boolean;
  guidanceSessionId: string;
  archiveKey: string;
  previousArchiveKey?: string;
  rows: GuidanceMemoryRow[];
  cursor: GuidanceImportState;
  now: Date;
};

type GuidanceImportRepository = {
  getState: (stateId: string) => Promise<{ cursor: unknown } | null>;
  persistImport: (input: PersistImportInput) => Promise<void>;
};

type GuidanceImportDependencies = {
  listArchiveFiles: (inboxDir: string) => Promise<GuidanceArchiveFile[]>;
  listZipEntries: (zipPath: string) => Promise<string[]>;
  readZipEntryText: (zipPath: string, entry: string) => Promise<string>;
  computeFileHash: (zipPath: string) => Promise<string>;
  generateEmbedding: (text: string) => Promise<number[]>;
  repository: GuidanceImportRepository;
  now: () => Date;
};

const ManifestSchema = z
  .object({
    packId: z.string().min(1).optional(),
    sourceRepo: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
    defaultScope: z.enum(['always', 'on_demand']).optional(),
    defaultGuidanceType: z.enum(['rule', 'skill']).optional(),
    defaultPriority: z.number().finite().optional(),
    project: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

const runCommand = async (
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr });
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      settleReject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        settleReject(new Error(`${command} failed: ${detail}`));
        return;
      }
      settleResolve();
    });
  });

const toNormalizedZipEntryPath = (entry: string): string => entry.trim().replaceAll('\\', '/');

const isSafeZipEntryPath = (entry: string): boolean => {
  if (!entry || entry.includes('\u0000')) return false;
  const normalized = path.posix.normalize(toNormalizedZipEntryPath(entry));
  if (normalized.startsWith('../')) return false;
  if (path.posix.isAbsolute(normalized)) return false;
  return normalized.length > 0;
};

const listZipEntries = async (zipPath: string): Promise<string[]> => {
  const { stdout } = await runCommand('unzip', ['-Z1', zipPath]);
  return stdout
    .split(/\r?\n/)
    .map((entry) => toNormalizedZipEntryPath(entry))
    .filter((entry) => entry.length > 0 && !entry.endsWith('/'));
};

const readZipEntryText = async (zipPath: string, entry: string): Promise<string> => {
  const { stdout } = await runCommand('unzip', ['-p', zipPath, entry]);
  return stdout.toString().replaceAll('\r\n', '\n');
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const computeFileHash = async (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);

    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('error', (error) => reject(error));
    stream.on('end', () => resolve(hash.digest('hex')));
  });

const uniqueStrings = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));

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
  if (scope === 'always' && guidanceType === 'rule') return 100;
  if (guidanceType === 'rule') return 80;
  return 50;
};

const hardSplitText = (text: string, maxChars: number): string[] => {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxChars) {
    chunks.push(text.slice(index, index + maxChars));
  }
  return chunks;
};

const splitMarkdownIntoChunks = (
  markdown: string,
  docTitle: string,
  maxChunkChars: number,
): Array<{ title: string; content: string }> => {
  const normalized = markdown.replaceAll('\r\n', '\n').trim();
  if (normalized.length === 0) return [];

  const lines = normalized.split('\n');
  const sections: Array<{ title: string; content: string }> = [];
  let currentTitle = docTitle;
  let currentLines: string[] = [];

  const flushSection = () => {
    const content = currentLines.join('\n').trim();
    if (content.length > 0) {
      sections.push({
        title: currentTitle,
        content,
      });
    }
    currentLines = [];
  };

  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      flushSection();
      currentTitle = heading[1] ? `${docTitle} / ${heading[1]}` : docTitle;
      currentLines.push(line);
      continue;
    }
    currentLines.push(line);
  }
  flushSection();

  if (sections.length === 0) {
    sections.push({ title: docTitle, content: normalized });
  }

  const chunks: Array<{ title: string; content: string }> = [];
  for (const section of sections) {
    const paragraphs = section.content
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0);

    if (paragraphs.length === 0) continue;

    let current = '';
    for (const paragraph of paragraphs) {
      if (paragraph.length > maxChunkChars) {
        if (current.length > 0) {
          chunks.push({ title: section.title, content: current });
          current = '';
        }
        const parts = hardSplitText(paragraph, maxChunkChars);
        for (const part of parts) {
          chunks.push({ title: section.title, content: part });
        }
        continue;
      }

      const next = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
      if (next.length > maxChunkChars) {
        chunks.push({ title: section.title, content: current });
        current = paragraph;
        continue;
      }
      current = next;
    }

    if (current.length > 0) {
      chunks.push({ title: section.title, content: current });
    }
  }

  return chunks;
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
        docPath: entry,
        title: sectionChunk.title,
        content: sectionChunk.content,
        guidanceType,
        scope,
        priority,
        tags,
      });
    }
  }

  if (forcedProject && forcedProject.trim().length > 0) {
    const project = forcedProject.trim();
    for (const chunk of chunks) {
      if (!chunk.tags.includes(project)) {
        chunk.tags = [...chunk.tags, project];
      }
    }
  }

  return { chunks, manifest };
};

const ensureDirectory = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
};

const getZipStateId = (zipPath: string): string => `guidance:zip:${sha256(path.resolve(zipPath))}`;

const buildContentFingerprint = (chunks: GuidanceChunk[]): string => {
  const normalized = chunks
    .map((chunk) => `${chunk.guidanceType}\n${chunk.scope}\n${chunk.title}\n${chunk.content}`)
    .sort((a, b) => a.localeCompare(b))
    .join('\n---\n');
  return sha256(normalized);
};

const getArchiveKey = (
  chunks: GuidanceChunk[],
  manifest: GuidanceManifest | null,
  zipHash: string,
): string => {
  const packId = manifest?.packId?.trim();
  if (packId && packId.length > 0) {
    return `archive:pack:${sha256(packId.toLowerCase())}`;
  }
  if (chunks.length === 0) {
    return `archive:empty:${zipHash}`;
  }
  return `archive:content:${buildContentFingerprint(chunks)}`;
};

const listArchiveFiles = async (inboxDir: string): Promise<GuidanceArchiveFile[]> => {
  const entries = await readdir(inboxDir, { withFileTypes: true });
  const zipEntries = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))
    .map((entry) => path.resolve(inboxDir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  const files: GuidanceArchiveFile[] = [];
  for (const zipPath of zipEntries) {
    const fileStat = await stat(zipPath);
    files.push({
      zipPath,
      size: fileStat.size,
      mtimeMs: Math.trunc(fileStat.mtimeMs),
    });
  }
  return files;
};

const createDefaultRepository = (): GuidanceImportRepository => ({
  getState: async (stateId) => {
    const [state] = await db.select().from(syncState).where(eq(syncState.id, stateId)).limit(1);
    return state ?? null;
  },
  persistImport: async (input) => {
    await db.transaction(async (tx) => {
      await tx
        .delete(vibeMemories)
        .where(
          sql`${vibeMemories.sessionId} = ${input.guidanceSessionId} AND ${
            vibeMemories.metadata
          } @> ${JSON.stringify({ kind: 'guidance', archiveKey: input.archiveKey })}::jsonb`,
        );

      if (input.previousArchiveKey && input.previousArchiveKey !== input.archiveKey) {
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
        await tx.insert(vibeMemories).values(row);
      }

      if (!input.stateExists) {
        await tx.insert(syncState).values({
          id: input.stateId,
          lastSyncedAt: input.now,
          cursor: input.cursor,
          updatedAt: input.now,
        });
        return;
      }

      await tx
        .update(syncState)
        .set({
          lastSyncedAt: input.now,
          cursor: input.cursor,
          updatedAt: input.now,
        })
        .where(eq(syncState.id, input.stateId));
    });
  },
});

const createDefaultDependencies = (): GuidanceImportDependencies => ({
  listArchiveFiles,
  listZipEntries,
  readZipEntryText,
  computeFileHash,
  generateEmbedding,
  repository: createDefaultRepository(),
  now: () => new Date(),
});

export async function importGuidanceArchives(
  options: ImportGuidanceOptions = {},
  deps: Partial<GuidanceImportDependencies> = {},
): Promise<GuidanceImportSummary> {
  const resolvedDeps: GuidanceImportDependencies = {
    ...createDefaultDependencies(),
    ...deps,
    repository: deps.repository ?? createDefaultRepository(),
  };

  const inboxDir = options.inboxDir ?? config.guidance.inboxDir;
  const guidanceSessionId = options.guidanceSessionId ?? config.guidance.sessionId;
  const maxFilesPerZip = Math.max(
    1,
    Math.trunc(options.maxFilesPerZip ?? config.guidance.maxFilesPerZip),
  );
  const maxZipSizeBytes = Math.max(
    1,
    Math.trunc(options.maxZipSizeBytes ?? config.guidance.maxZipSizeBytes),
  );
  const maxChunkChars = Math.max(
    200,
    Math.trunc(options.maxChunkChars ?? config.guidance.maxChunkChars),
  );
  const maxFileChars = Math.max(
    200,
    Math.trunc(options.maxFileChars ?? config.guidance.maxFileChars),
  );
  const dryRun = options.dryRun ?? false;
  const project = options.project?.trim() || undefined;
  const maxZips = options.maxZips ?? 1000;

  await ensureDirectory(inboxDir);

  const allZipFiles = await resolvedDeps.listArchiveFiles(inboxDir);
  const zipFiles = allZipFiles.slice(0, maxZips);

  const summary: GuidanceImportSummary = {
    scanned: allZipFiles.length,
    imported: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    chunksImported: 0,
    results: [],
  };

  for (const zipFile of zipFiles) {
    const { zipPath, size, mtimeMs } = zipFile;
    try {
      if (size > maxZipSizeBytes) {
        summary.failed += 1;
        summary.results.push({
          zipPath,
          status: 'failed',
          chunkCount: 0,
          error: `zip size exceeds limit (${size} > ${maxZipSizeBytes})`,
        });
        continue;
      }

      const zipHash = await resolvedDeps.computeFileHash(zipPath);
      const stateId = getZipStateId(zipPath);

      const currentState = await resolvedDeps.repository.getState(stateId);
      const cursor = parseSyncStateCursor(currentState?.cursor);
      const unchanged =
        (typeof cursor.zipHash === 'string' && cursor.zipHash === zipHash) ||
        (cursor.zipHash === undefined && cursor.mtimeMs === mtimeMs && cursor.size === size);

      if (unchanged) {
        summary.unchanged += 1;
        summary.results.push({
          zipPath,
          status: 'unchanged',
          chunkCount: cursor.importedChunks ?? 0,
        });
        continue;
      }

      const zipEntries = await resolvedDeps.listZipEntries(zipPath);
      const { chunks, manifest } = await createChunksFromZip(
        zipPath,
        zipEntries,
        maxFilesPerZip,
        maxFileChars,
        maxChunkChars,
        resolvedDeps.readZipEntryText,
        project,
      );
      const archiveKey = getArchiveKey(chunks, manifest, zipHash);
      const previousArchiveKey = cursor.archiveKey;

      const now = resolvedDeps.now();

      if (!dryRun) {
        const rows: GuidanceMemoryRow[] = [];

        for (const [index, chunk] of chunks.entries()) {
          const contentHash = sha256(chunk.content);
          const dedupeKey = sha256(
            `${archiveKey}:${chunk.docPath}:${index}:${contentHash}:${chunk.scope}:${chunk.guidanceType}`,
          );
          const embedding = await resolvedDeps.generateEmbedding(chunk.content);
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
              docPath: chunk.docPath,
              chunkIndex: index + 1,
              chunkCount: chunks.length,
              tags: chunk.tags,
              project: project ?? manifest?.project ?? null,
              packId: manifest?.packId ?? path.basename(zipPath, '.zip'),
              sourceZip: zipPath,
              sourceRepo: manifest?.sourceRepo ?? null,
              license: manifest?.license ?? null,
              archiveKey,
              zipHash,
              importedAt: now.toISOString(),
            },
          });
        }

        await resolvedDeps.repository.persistImport({
          stateId,
          stateExists: Boolean(currentState),
          guidanceSessionId,
          archiveKey,
          previousArchiveKey,
          rows,
          cursor: {
            zipHash,
            mtimeMs,
            size,
            importedChunks: rows.length,
            importedAt: now.toISOString(),
            archiveKey,
          },
          now,
        });
      }

      const status: GuidanceImportItemResult['status'] = currentState ? 'updated' : 'imported';
      if (status === 'imported') {
        summary.imported += 1;
      } else {
        summary.updated += 1;
      }
      summary.chunksImported += chunks.length;
      summary.results.push({
        zipPath,
        status,
        chunkCount: chunks.length,
      });
    } catch (error) {
      summary.failed += 1;
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

/**
 * 常時適用（Always-on）のガイダンスを取得します。
 * メタデータフィルタリングのみを使用し、ベクトル検索は行いません。
 */
export async function getAlwaysOnGuidance(
  limit = config.guidance.alwaysLimit,
  sessionId = config.guidance.sessionId,
) {
  const results = await db
    .select({
      content: vibeMemories.content,
      metadata: vibeMemories.metadata,
      priority: sql<number>`(${vibeMemories.metadata}->>'priority')::int`,
    })
    .from(vibeMemories)
    .where(
      sql`${vibeMemories.sessionId} = ${sessionId} AND ${
        vibeMemories.metadata
      } @> ${JSON.stringify({
        kind: 'guidance',
        scope: 'always',
      })}::jsonb`,
    )
    .orderBy((fields) => desc(fields.priority))
    .limit(limit);

  return results;
}

/**
 * オンデマンド（On-demand）のガイダンスをセマンティック検索で取得します。
 */
export async function getOnDemandGuidance(
  query: string,
  limit = config.guidance.onDemandLimit,
  minSimilarity = config.guidance.minSimilarity,
  sessionId = config.guidance.sessionId,
) {
  const embedding = await generateEmbedding(query);
  const embeddingStr = JSON.stringify(embedding);
  const similarity = sql<number>`1 - (${vibeMemories.embedding} <=> ${embeddingStr}::vector)`;

  const results = await db
    .select({
      content: vibeMemories.content,
      metadata: vibeMemories.metadata,
      similarity,
    })
    .from(vibeMemories)
    .where(
      sql`${vibeMemories.sessionId} = ${sessionId} AND ${
        vibeMemories.metadata
      } @> ${JSON.stringify({
        kind: 'guidance',
        scope: 'on_demand',
      })}::jsonb AND ${similarity} >= ${minSimilarity}`,
    )
    .orderBy((fields) => desc(fields.similarity))
    .limit(limit);

  return results;
}

/**
 * 常時適用とオンデマンド適用を組み合わせたプロンプト用テキストを生成します。
 */
export async function getGuidanceContext(query: string): Promise<string> {
  const [always, onDemand] = await Promise.all([
    getAlwaysOnGuidance().catch(() => []),
    getOnDemandGuidance(query).catch(() => []),
  ]);

  if (always.length === 0 && onDemand.length === 0) {
    return '';
  }

  const sections: string[] = [];

  if (always.length > 0) {
    sections.push('## Core Safety & Architecture Rules (Always-on)');
    sections.push(always.map((g) => g.content).join('\n---\n'));
  }

  if (onDemand.length > 0) {
    sections.push('## Relevant Skills & Guidelines (On-demand)');
    sections.push(onDemand.map((g) => g.content).join('\n---\n'));
  }

  return sections.join('\n\n');
}

/**
 * 単独のガイダンス（ルールやスキル）をレジストリに直接登録します。
 */
export async function saveGuidance(
  input: {
    title: string;
    content: string;
    guidanceType: GuidanceType;
    scope: GuidanceScope;
    priority: number;
    tags?: string[];
    archiveKey?: string;
    sessionId?: string;
  },
  deps: Partial<GuidanceImportDependencies> = {},
): Promise<{ id: string; archiveKey: string }> {
  const resolvedDeps = {
    generateEmbedding: deps.generateEmbedding ?? generateEmbedding,
    now: deps.now ?? (() => new Date()),
  };

  const sessionId = input.sessionId ?? config.guidance.sessionId;
  const now = resolvedDeps.now();
  const archiveKey = input.archiveKey ?? `manual:${sha256(input.title.toLowerCase())}`;
  const tags = uniqueStrings([...(input.tags ?? []), 'manual-entry']);

  const embedding = await resolvedDeps.generateEmbedding(input.content);
  const contentHash = sha256(input.content);
  const dedupeKey = sha256(`manual:${archiveKey}:${contentHash}:${input.scope}`);

  const metadata = {
    kind: 'guidance',
    guidanceType: input.guidanceType,
    scope: input.scope,
    priority: input.priority,
    title: input.title,
    tags,
    archiveKey,
    importedAt: now.toISOString(),
  };

  const row: GuidanceMemoryRow = {
    sessionId,
    content: input.content,
    embedding,
    dedupeKey,
    metadata,
  };

  // 同一アーカイブキーの既存エントリーを削除して更新（簡易的な実装）
  await db.transaction(async (tx) => {
    await tx
      .delete(vibeMemories)
      .where(
        sql`${vibeMemories.sessionId} = ${sessionId} AND ${
          vibeMemories.metadata
        } @> ${JSON.stringify({ kind: 'guidance', archiveKey })}::jsonb`,
      );
    await tx.insert(vibeMemories).values(row);
  });

  return { id: dedupeKey, archiveKey };
}

