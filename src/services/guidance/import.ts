import { createHash } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { entities, relations, syncState, vibeMemories } from '../../db/schema.js';
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
import { contentFingerprint } from '../../utils/contentFingerprint.js';
import { sha256 } from '../../utils/crypto.js';
import { generateEntityId } from '../../utils/entityId.js';
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

const metadataRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const metadataString = (metadata: Record<string, unknown>, key: string): string | undefined => {
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
};

const metadataStringArray = (metadata: Record<string, unknown>, key: string): string[] => {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item, index, values) => item.length > 0 && values.indexOf(item) === index);
};

const metadataObjectArray = (
  metadata: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] => {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item),
  );
};

const sourceFingerprint = (source: Record<string, unknown>): string =>
  JSON.stringify({
    archiveKey: source.archiveKey,
    project: source.project,
    entryPath: source.entryPath,
    title: source.title,
  });

const mergeGuidanceSources = (
  existingSources: Record<string, unknown>[],
  incomingSource: Record<string, unknown>,
): Record<string, unknown>[] => {
  const sources = [...existingSources, incomingSource];
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = sourceFingerprint(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const guidanceEntityType = (guidanceType: GuidanceType): string => {
  if (guidanceType === 'rule') return 'rule';
  if (guidanceType === 'goal') return 'goal';
  return 'procedure';
};

const guidanceTypeFromMetadata = (metadata: Record<string, unknown>): GuidanceType => {
  const parsed = GuidanceTypeSchema.safeParse(metadata.guidanceType);
  return parsed.success ? parsed.data : 'skill';
};

const guidanceScopeFromMetadata = (metadata: Record<string, unknown>): GuidanceScope => {
  const parsed = GuidanceScopeSchema.safeParse(metadata.scope);
  return parsed.success ? parsed.data : 'on_demand';
};

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

const stripMarkdownSyntax = (value: string): string =>
  value
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^(?:\p{Extended_Pictographic}\uFE0F?|\s)+/u, '')
    .replace(/\s+/g, ' ')
    .trim();

const isStructuralHeading = (value: string): boolean => {
  const normalized = stripMarkdownSyntax(value).toLowerCase();
  return [
    'api・通信方針',
    '共通部品とテスト',
    'テスト要件',
    'セキュリティ・データ保護',
    'ai運用・開発ワークフロー',
    'チケット・todo管理',
    'mcp操作',
    'チケットmdファイル構成',
    '仕様書作成（必須）',
  ].includes(normalized);
};

const isGenericHeading = (value: string): boolean => {
  const normalized = stripMarkdownSyntax(value).toLowerCase();
  if (/開発ガイドライン$/.test(normalized)) return true;
  if (/coding[_\s-]?rules/i.test(normalized)) return true;

  return [
    '開発ルール',
    '事前知識',
    'プロジェクト概要',
    '必須遵守',
    'コーディング規約',
    'ai動作制約',
    'プロジェクト設定',
    '命名規則',
    '設計原則',
    '実装ルール',
    'ディレクトリ構成',
    'コンポーネント実装',
    'logger',
    'エラーハンドリング',
    '国際化 (i18n)',
    'api実装 (3層アーキテクチャ)',
    'ロジック分離',
    'repository実装ルール',
    '状態管理 & キャッシュ戦略',
    'ローディング表示',
    '初期化エラー通知',
    'ボタンの非同期状態管理',
    'ui/ux & プラットフォーム',
    'タッチファーストデザイン (touch first design)',
    '基本アクセシビリティ',
    'tauri & デバイス通信',
    'コンプライアンス',
    '医療機器認定 (samd)',
    'gdpr & プライバシー',
    'localstorage使用ポリシー',
    'テスト & パフォーマンス',
    'テスト',
    'パフォーマンス',
    '運用ルール',
    'コミット規約 (conventional commits)',
    '共通ルール',
    '必須事項',
    '開発フロー',
    'コードレビュー',
    '編集ルール',
    'todo管理',
    '設定・機能一覧',
    '運用上の注意点',
  ].includes(normalized);
};

const contentSignalLines = (content: string): string[] =>
  content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .filter((line) => !/^```/.test(line))
    .map(stripMarkdownSyntax)
    .filter((line) => line.length > 0)
    .filter((line) => !line.endsWith(':'))
    .filter((line) => !isStructuralHeading(line));

const fixedTitleForHeading = (heading: string, content: string): string | null => {
  const normalized = stripMarkdownSyntax(heading).toLowerCase();
  if (normalized === 'プロジェクト概要' && content.includes('タッチパネル医療画像管理アプリ')) {
    return 'React 19 + Tauriのタッチパネル医療画像管理アプリ構成';
  }
  if (normalized === '命名規則') {
    return 'TypeScript/Reactファイル・型・Query Keyの命名規則';
  }
  if (normalized === 'ロジック分離') {
    return 'Custom HookとRepositoryの責務分離';
  }
  if (normalized.startsWith('コミット規約')) {
    return 'Conventional Commitsのtypeと日本語subject規約';
  }
  return null;
};

const compactTitle = (value: string, maxLength = 96): string => {
  const normalized = stripMarkdownSyntax(value)
    .replace(/^目的[:：]\s*/, '')
    .replace(/\s-\s目的[:：]\s*/g, ' - ')
    .replace(/[。.]$/, '')
    .replace(/すること$/, 'する')
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
};

const buildSemanticTitle = (input: {
  sectionTitle: string;
  content: string;
  entryPath: string;
  project?: string;
}): string | null => {
  const sectionLeaf = input.sectionTitle.split(' / ').pop()?.trim() ?? input.sectionTitle;
  const heading = stripMarkdownSyntax(sectionLeaf);
  const signals = contentSignalLines(input.content);
  const meaningfulSignals = signals
    .filter((line) => line !== heading)
    .filter((line) => !/以下|確認・宣言すること/.test(line));
  const fixedTitle = fixedTitleForHeading(heading, input.content);
  if (fixedTitle) return fixedTitle;

  if (meaningfulSignals.length === 0) {
    return isStructuralHeading(heading) || isGenericHeading(heading) ? null : compactTitle(heading);
  }

  if (heading === '開発ルール') return null;
  if (heading === '事前知識' && input.content.includes('MonoRepo')) {
    return 'MonoRepo構成とfrontend/backend開発ポート';
  }

  const specificSignal = meaningfulSignals.find((line) =>
    /禁止|必須|使用|確認|実行|作成|記録|変更|削除|許可|優先|無効|検証|更新|起動|認証|テスト|ログ|DI|Query|Kanban|MCP|DB|API|React|TypeScript|pnpm|Git/i.test(
      line,
    ),
  );
  const primary = specificSignal ?? meaningfulSignals[0];
  const secondary = meaningfulSignals.find((line) => line !== primary && line.length <= 48);
  const detail = secondary && primary.length < 44 ? `${primary} / ${secondary}` : primary;

  if (
    heading.length > 0 &&
    !isStructuralHeading(heading) &&
    !isGenericHeading(heading) &&
    !detail.includes(heading)
  ) {
    return compactTitle(`${heading} - ${detail}`);
  }

  return compactTitle(detail);
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
      const title = buildSemanticTitle({
        sectionTitle: sectionChunk.title,
        content: sectionChunk.content,
        entryPath: entry,
        project: forcedProject ?? manifest?.project,
      });
      if (!title) continue;

      chunks.push({
        title,
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
    const archiveKeysToReplace = Array.from(
      new Set(
        [input.previousArchiveKey, input.archiveKey].filter((key): key is string => Boolean(key)),
      ),
    );
    const entryPathsToReplace = Array.from(
      new Set(
        input.rows
          .map((row) => metadataString(metadataRecord(row.metadata), 'entryPath'))
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const projectsToReplace = Array.from(
      new Set(
        input.rows
          .map((row) => metadataString(metadataRecord(row.metadata), 'project'))
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const archiveProject = projectsToReplace[0];

    const deleteImportedByMatch = async (match: Record<string, string>) => {
      await tx.delete(vibeMemories).where(
        sql`${vibeMemories.sessionId} = ${input.guidanceSessionId} AND ${
          vibeMemories.metadata
        } @> ${JSON.stringify({
          kind: 'guidance',
          ...match,
        })}::jsonb`,
      );
      await tx.delete(relations).where(sql`${relations.sourceId} IN (
          SELECT id FROM entities WHERE metadata @> ${JSON.stringify({
            source: 'guidance_import',
            ...match,
          })}::jsonb
        ) OR ${relations.targetId} IN (
          SELECT id FROM entities WHERE metadata @> ${JSON.stringify({
            source: 'guidance_import',
            ...match,
          })}::jsonb
        )`);
      await tx.delete(entities).where(
        sql`${entities.metadata} @> ${JSON.stringify({
          source: 'guidance_import',
          ...match,
        })}::jsonb`,
      );
    };

    for (const archiveKey of archiveKeysToReplace) {
      await deleteImportedByMatch({ archiveKey });
    }
    for (const entryPath of entryPathsToReplace) {
      await deleteImportedByMatch({ entryPath });
    }
    for (const project of projectsToReplace) {
      await deleteImportedByMatch({ project });
    }

    await tx.delete(entities).where(sql`${entities.type} = 'project_doc'
      AND ${entities.metadata} @> '{"source":"guidance_import"}'::jsonb
      AND NOT EXISTS (
        SELECT 1 FROM relations
        WHERE source_id = ${entities.id} OR target_id = ${entities.id}
      )`);

    for (const row of input.rows) {
      await tx
        .insert(vibeMemories)
        .values(row)
        .onConflictDoNothing({
          target: [vibeMemories.sessionId, vibeMemories.dedupeKey],
        });
    }

    const archiveEntityId = generateEntityId('project_doc', input.archiveKey);
    await tx
      .insert(entities)
      .values({
        id: archiveEntityId,
        type: 'project_doc',
        name: input.archiveKey,
        description: `Guidance archive imported at ${input.now.toISOString()}`,
        metadata: {
          source: 'guidance_import',
          archiveKey: input.archiveKey,
          project: archiveProject,
          guidanceSessionId: input.guidanceSessionId,
          importedAt: input.now.toISOString(),
        },
        confidence: 0.6,
        provenance: 'guidance_import',
        scope: 'on_demand',
        freshness: input.now,
      })
      .onConflictDoUpdate({
        target: entities.id,
        set: {
          description: sql`excluded.description`,
          metadata: sql`${entities.metadata} || excluded.metadata`,
          freshness: sql`excluded.freshness`,
        },
      });

    for (const row of input.rows) {
      const metadata = metadataRecord(row.metadata);
      const guidanceType = guidanceTypeFromMetadata(metadata);
      const entityType = guidanceEntityType(guidanceType);
      const title = metadataString(metadata, 'title') ?? row.content.slice(0, 80);
      const scope = guidanceScopeFromMetadata(metadata);
      const tags = metadataStringArray(metadata, 'tags');
      const priority = Number(metadata.priority ?? 50);
      const confidence = Number.isFinite(priority)
        ? Math.max(0.1, Math.min(1, priority / 100))
        : 0.5;
      const fallbackFingerprint = contentFingerprint(row.content);
      const contentHash =
        metadataString(metadata, 'contentHash') ?? fallbackFingerprint.contentHash;
      const normalizedContentHash =
        metadataString(metadata, 'normalizedContentHash') ??
        fallbackFingerprint.normalizedContentHash;
      const currentSource = {
        archiveKey: input.archiveKey,
        guidanceSessionId: input.guidanceSessionId,
        project: metadataString(metadata, 'project'),
        entryPath: metadataString(metadata, 'entryPath'),
        title,
        contentHash,
        importedAt: input.now.toISOString(),
      };

      const [duplicateEntity] = await tx
        .select({
          id: entities.id,
          metadata: entities.metadata,
          confidence: entities.confidence,
        })
        .from(entities)
        .where(sql`${entities.type} = ${entityType}
          AND ${entities.metadata}->>'normalizedContentHash' = ${normalizedContentHash}`)
        .limit(1);

      let entityId = generateEntityId(entityType, title);

      if (duplicateEntity) {
        entityId = duplicateEntity.id;
        const existingMetadata = metadataRecord(duplicateEntity.metadata);
        const existingSources = metadataObjectArray(existingMetadata, 'sources');
        const sources = mergeGuidanceSources(existingSources, currentSource);
        const projects = uniqueStrings(
          sources
            .map((source) => (typeof source.project === 'string' ? source.project : ''))
            .filter((project) => project.length > 0),
        );
        const existingTags = metadataStringArray(existingMetadata, 'tags');

        await tx
          .update(entities)
          .set({
            metadata: {
              ...existingMetadata,
              source: 'guidance_import',
              project:
                projects.length === 1 ? projects[0] : projects.length > 1 ? 'multiple' : undefined,
              projects,
              tags: uniqueStrings([...existingTags, ...tags]),
              sources,
              contentHash: metadataString(existingMetadata, 'contentHash') ?? contentHash,
              normalizedContentHash,
              guidanceDedupeKeys: uniqueStrings([
                ...metadataStringArray(existingMetadata, 'guidanceDedupeKeys'),
                row.dedupeKey,
              ]),
              duplicateSourceCount: sources.length,
              lastDuplicateAt: input.now.toISOString(),
            },
            confidence: Math.max(duplicateEntity.confidence ?? 0.5, confidence),
            freshness: input.now,
          })
          .where(eq(entities.id, entityId));

        await tx
          .insert(relations)
          .values({
            sourceId: archiveEntityId,
            targetId: entityId,
            relationType: 'contains_guidance',
            weight: confidence,
            confidence,
            sourceTask: input.stateId,
            provenance: 'guidance_import',
          })
          .onConflictDoNothing();

        continue;
      }

      await tx
        .insert(entities)
        .values({
          id: entityId,
          type: entityType,
          name: title,
          description: row.content,
          embedding: row.embedding,
          metadata: {
            ...metadata,
            tags,
            projects: metadataString(metadata, 'project')
              ? [metadataString(metadata, 'project')]
              : [],
            sources: [currentSource],
            source: 'guidance_import',
            archiveKey: input.archiveKey,
            guidanceSessionId: input.guidanceSessionId,
            guidanceDedupeKey: row.dedupeKey,
            guidanceDedupeKeys: [row.dedupeKey],
            contentHash,
            normalizedContentHash,
          },
          confidence,
          provenance: 'guidance_import',
          scope,
          freshness: input.now,
        })
        .onConflictDoUpdate({
          target: entities.id,
          set: {
            name: sql`excluded.name`,
            description: sql`excluded.description`,
            embedding: sql`excluded.embedding`,
            metadata: sql`${entities.metadata} || excluded.metadata`,
            confidence: sql`GREATEST(COALESCE(${entities.confidence}, 0), excluded.confidence)`,
            provenance: sql`excluded.provenance`,
            scope: sql`excluded.scope`,
            freshness: sql`excluded.freshness`,
          },
        });

      await tx
        .insert(relations)
        .values({
          sourceId: archiveEntityId,
          targetId: entityId,
          relationType: 'contains_guidance',
          weight: confidence,
          confidence,
          sourceTask: input.stateId,
          provenance: 'guidance_import',
        })
        .onConflictDoNothing();
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
        const { contentHash, normalizedContentHash } = contentFingerprint(chunk.content);
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
            contentHash,
            normalizedContentHash,
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
