#!/usr/bin/env bun

import { and, inArray, sql } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { communities, entities, relations } from '../db/schema.js';
import { buildCommunities } from '../services/community.js';
import { generateEmbedding } from '../services/memory.js';
import { contentFingerprint } from '../utils/contentFingerprint.js';
import { generateEntityId } from '../utils/entityId.js';

type CliArgs = {
  command:
    | 'diagnose'
    | 'backfill-task-relations'
    | 'dedupe-guidance'
    | 'normalize-guidance'
    | 'link-similar-guidance'
    | 'rebuild-communities'
    | 'help';
  apply: boolean;
  json: boolean;
  deterministicSummary: boolean;
  threshold: number;
  samePrincipleThreshold: number;
  limit: number;
  includeSameProject: boolean;
  skipSimilarLinking: boolean;
};

type BackfillCandidate = {
  sourceId: string;
  targetId: string;
  targetType: string;
};

type SimilarGuidanceCandidate = {
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  sourceProject: string | null;
  targetProject: string | null;
  similarity: number;
  anchors: string[];
  relationType: 'same_principle_as' | 'similar_to';
  weight: number;
};

type DedupeEntity = {
  id: string;
  type: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
  confidence: number | null;
  referenceCount: number;
  createdAt: Date;
  normalizedContentHash: string;
};

type DedupeGroup = {
  normalizedContentHash: string;
  type: string;
  canonical: DedupeEntity;
  duplicates: DedupeEntity[];
};

type GuidanceEntity = {
  id: string;
  type: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
  confidence: number | null;
  referenceCount: number;
};

type CompoundRuleItem = {
  title: string;
  body: string;
  content: string;
  sourceEntity: GuidanceEntity;
  sourceArchiveIds: string[];
};

type GuidanceEntityUpsertInput = {
  id: string;
  type: string;
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  confidence: number;
  sourceArchiveIds: string[];
};

const parseArgs = (argv: string[]): CliArgs => {
  const command = argv[0] as CliArgs['command'] | undefined;
  const getNumberArg = (name: string, fallback: number): number => {
    const index = argv.indexOf(name);
    if (index < 0 || index + 1 >= argv.length) return fallback;
    const parsed = Number(argv[index + 1]);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    command:
      command === 'diagnose' ||
      command === 'backfill-task-relations' ||
      command === 'dedupe-guidance' ||
      command === 'normalize-guidance' ||
      command === 'link-similar-guidance' ||
      command === 'rebuild-communities'
        ? command
        : 'help',
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    deterministicSummary: argv.includes('--deterministic-summary'),
    threshold: getNumberArg('--threshold', 0.9),
    samePrincipleThreshold: getNumberArg('--same-principle-threshold', 0.925),
    limit: Math.max(1, Math.trunc(getNumberArg('--limit', 500))),
    includeSameProject: argv.includes('--include-same-project'),
    skipSimilarLinking: argv.includes('--skip-similar-linking'),
  };
};

const firstCount = (rows: Array<{ count: number }>) => rows[0]?.count ?? 0;

const relationTypeForTarget = (targetType: string): string => {
  if (targetType === 'lesson') return 'captured_lesson';
  if (targetType === 'rule') return 'captured_rule';
  if (targetType === 'procedure' || targetType === 'skill' || targetType === 'command_recipe') {
    return 'captured_procedure';
  }
  if (targetType === 'decision') return 'captured_decision';
  if (targetType === 'risk') return 'captured_risk';
  return 'captured_knowledge';
};

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

const uniqueStrings = (values: string[]): string[] =>
  values.filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);

const sourceFingerprint = (source: Record<string, unknown>): string =>
  JSON.stringify({
    archiveKey: source.archiveKey,
    project: source.project,
    entryPath: source.entryPath,
    title: source.title,
  });

const mergeSources = (
  left: Record<string, unknown>[],
  right: Record<string, unknown>[],
): Record<string, unknown>[] => {
  const seen = new Set<string>();
  return [...left, ...right].filter((source) => {
    const key = sourceFingerprint(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const stripMarkdown = (value: string): string =>
  value
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

const compactTitle = (value: string, maxLength = 96): string => {
  const title = stripMarkdown(value)
    .replace(/[。.]$/, '')
    .trim();
  if (title.length <= maxLength) return title;
  return `${title.slice(0, maxLength - 1)}…`;
};

const sourceArchiveMetadata = (entity: GuidanceEntity): Record<string, unknown>[] => {
  const sources = metadataObjectArray(entity.metadata, 'sources');
  if (sources.length > 0) return sources;

  const archiveKey = metadataString(entity.metadata, 'archiveKey');
  const project = metadataString(entity.metadata, 'project');
  return archiveKey
    ? [
        {
          archiveKey,
          project,
          title: entity.name,
        },
      ]
    : [];
};

const guidanceProjects = (items: GuidanceEntity[], sources: Record<string, unknown>[]): string[] =>
  uniqueStrings([
    ...items.flatMap((item) => metadataStringArray(item.metadata, 'projects')),
    ...items
      .map((item) => metadataString(item.metadata, 'project') ?? '')
      .filter((project) => project.length > 0),
    ...sources
      .map((source) => (typeof source.project === 'string' ? source.project : ''))
      .filter((project) => project.length > 0),
  ]);

const splitRuleLine = (line: string): { title: string; body: string } | null => {
  const trimmed = line.trim();
  const numbered = trimmed.match(/^\d+\.\s+\*\*(.+?)\*\*[:：]\s*(.+)$/);
  if (numbered?.[1] && numbered[2]) {
    return { title: stripMarkdown(numbered[1]), body: stripMarkdown(numbered[2]) };
  }

  const bullet = trimmed.match(/^[-*+]\s+\*\*(.+?)\*\*[:：]\s*(.+)$/);
  if (bullet?.[1] && bullet[2]) {
    return { title: stripMarkdown(bullet[1]), body: stripMarkdown(bullet[2]) };
  }

  const plainNumbered = trimmed.match(/^\d+\.\s+(.+?)[:：]\s*(.+)$/);
  if (plainNumbered?.[1] && plainNumbered[2]) {
    return { title: stripMarkdown(plainNumbered[1]), body: stripMarkdown(plainNumbered[2]) };
  }

  const plainBullet = trimmed.match(/^[-*+]\s+(.+)$/);
  if (plainBullet?.[1]) {
    const body = stripMarkdown(plainBullet[1]);
    return { title: body, body };
  }

  return null;
};

const extractCompoundRuleItems = (entity: GuidanceEntity, sourceArchiveIds: string[]) => {
  const description = entity.description ?? '';
  const items = description
    .split('\n')
    .map(splitRuleLine)
    .filter((item): item is { title: string; body: string } => item !== null)
    .filter((item) => item.title.length > 0 && item.body.length > 0);

  if (items.length < 3 && !entity.name.includes(' / ')) return [];

  return items.map<CompoundRuleItem>((item) => ({
    ...item,
    content: item.title === item.body ? item.body : `${item.title}: ${item.body}`,
    sourceEntity: entity,
    sourceArchiveIds,
  }));
};

const LOGGING_TITLE_PATTERN =
  /console\.log|@logger|\blogger\b|logger使用|log\.(?:debug|info|warn|error)|ログ出力|ロガー/i;
const ANY_TITLE_PATTERN = /\bany\b|unknown|typescript strict/i;
const TARGET_COMPOUND_PATTERN =
  /console\.log禁止.*any禁止|any禁止.*console\.log禁止|必須コーディング規約.*any禁止/i;

const isLoggingGuidance = (name: string): boolean => LOGGING_TITLE_PATTERN.test(name);
const isAnyGuidance = (text: string): boolean => ANY_TITLE_PATTERN.test(text);

const isCompoundEntity = (entity: GuidanceEntity, extractedItems: CompoundRuleItem[]): boolean =>
  extractedItems.length >= 3 || entity.name.includes(' / ');

const isTargetCompoundGuidance = (entity: GuidanceEntity): boolean =>
  TARGET_COMPOUND_PATTERN.test(entity.name);

const isAtomicLoggingEntity = (entity: GuidanceEntity): boolean => {
  if (!isLoggingGuidance(entity.name)) return false;
  if (isTargetCompoundGuidance(entity)) return false;
  if (
    /try-catch|error boundary|監査証跡|ログイン|privacy|安全設計|ロールバック/i.test(entity.name)
  ) {
    return false;
  }
  return true;
};

const canonicalLoggingTitle = 'console.log禁止とlogger使用必須';
const canonicalAnyTitle = 'any禁止とunknown利用';

const loggingDescription = (items: Array<{ title: string; body: string }>): string => {
  const points = uniqueStrings(
    items.flatMap((item) =>
      `${item.title}: ${item.body}`
        .split('\n')
        .map(stripMarkdown)
        .filter((line) => line.length > 0),
    ),
  );
  return [
    `${canonicalLoggingTitle}: console.log は原則禁止し、logger 系 API を使って文脈付きで記録する。`,
    ...points.slice(0, 12).map((point) => `- ${point}`),
  ].join('\n');
};

const anyDescription = (items: Array<{ title: string; body: string }>): string => {
  const points = uniqueStrings(
    items.flatMap((item) =>
      `${item.title}: ${item.body}`
        .split('\n')
        .map(stripMarkdown)
        .filter((line) => line.length > 0),
    ),
  );
  return [
    `${canonicalAnyTitle}: TypeScript strict を前提に any を避け、適切な型定義または unknown を使う。`,
    ...points.slice(0, 12).map((point) => `- ${point}`),
  ].join('\n');
};

const isAtomicAnyEntity = (entity: GuidanceEntity): boolean => {
  if (!isAnyGuidance(entity.name)) return false;
  if (isTargetCompoundGuidance(entity)) return false;
  return true;
};

const SIMILARITY_ANCHORS: Array<{ key: string; pattern: RegExp }> = [
  {
    key: 'console.log/logger',
    pattern: /console\.log|@logger|\blogger\b|log\.(info|warn|error|debug)/i,
  },
  { key: 'any/unknown', pattern: /\bany\b|\bunknown\b/i },
  { key: 'i18n', pattern: /i18next|i18n|国際化|多言語/i },
  { key: 'schema/zod', pattern: /schema|スキーマ|zod/i },
  {
    key: 'tanstack-query',
    pattern: /tanstack|react query|usequery|queryclient|invalidatequeries|query key/i,
  },
  { key: 'fetch-direct-use', pattern: /\bfetch\b|直接使用/i },
  { key: 'local-storage', pattern: /localstorage|sessionstorage|ブラウザストレージ/i },
  { key: 'server-start', pattern: /サーバー.*起動|起動.*サーバー|server.*start/i },
  { key: 'auth-bypass', pattern: /認証バイパス|バイパス禁止|auth.*bypass/i },
  { key: 'circular-import', pattern: /循環参照|循環.*import|circular/i },
  { key: 'design-system', pattern: /design system|@gxp\/design-system|汎用ui/i },
  { key: 'module-placement', pattern: /src\/modules|flat-first|コンポーネント配置/i },
  { key: 'repository', pattern: /repository|repositories|データアクセス層/i },
  { key: 'mock-real-repository', pattern: /mockrepository|realrepository|standalone|prd|uat|dev/i },
  { key: 'api-client', pattern: /api client|apiclient|統合api|src\/lib\/api/i },
  { key: 'websocket', pattern: /websocket|src\/lib\/websocket/i },
  { key: 'vitest-testing-library', pattern: /vitest|testing-library|@testing-library/i },
  { key: 'db-direct-write', pattern: /実db|本番db|直接操作|直接書込|prisma migrate/i },
  { key: 'msal', pattern: /msal/i },
  { key: 'jsdoc-openapi', pattern: /jsdoc|openapi/i },
  { key: 'aria-a11y', pattern: /aria|アクセシビリティ|キーボード|focus-visible|wcag/i },
  { key: 'tauri-rust-device', pattern: /tauri|rust|デバイス通信/i },
  { key: 'privacy', pattern: /privacy|gdpr|個人情報|機微情報|監査証跡|dompurify/i },
  { key: 'destructive-action', pattern: /破壊的|削除|確認ダイアログ|ロールバック/i },
  {
    key: 'url-query-params',
    pattern: /url.*query|query.*params|クエリパラメータ|uselistqueryparams/i,
  },
  {
    key: 'loading-notification',
    pattern: /loading|spinner|skeleton|通知|notification|読み込み失敗/i,
  },
  {
    key: 'conventional-commits',
    pattern: /conventional commits|コミット規約|<type>\(<scope>\)|feat|fix/i,
  },
  { key: 'biome-eslint', pattern: /biome|eslint|lint|フォーマット/i },
  { key: 'build-test-command', pattern: /pnpm|build|type-check|typecheck|test:coverage/i },
  { key: 'kanban-mcp', pattern: /kanban|mcp|todo|チケット/i },
  { key: 'dependency-injection', pattern: /tsyringe|injectable|container\.resolve|依存性逆転|di/i },
];

const similarityAnchors = (text: string): Set<string> =>
  new Set(
    SIMILARITY_ANCHORS.filter((anchor) => anchor.pattern.test(text)).map((anchor) => anchor.key),
  );

const commonSimilarityAnchors = (left: string, right: string): string[] => {
  const leftAnchors = similarityAnchors(left);
  const rightAnchors = similarityAnchors(right);
  return [...leftAnchors].filter((anchor) => rightAnchors.has(anchor)).sort();
};

const printPayload = (payload: unknown, json: boolean) => {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(payload);
};

async function diagnoseGraph() {
  const [
    entityCount,
    relationCount,
    communityCount,
    entitiesWithCommunity,
    relationTypeRows,
    entityTypeRows,
    orphanRows,
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(entities),
    db.select({ count: sql<number>`count(*)::int` }).from(relations),
    db.select({ count: sql<number>`count(*)::int` }).from(communities),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(entities)
      .where(sql`${entities.communityId} IS NOT NULL`),
    db
      .select({ type: relations.relationType, count: sql<number>`count(*)::int` })
      .from(relations)
      .groupBy(relations.relationType),
    db
      .select({ type: entities.type, count: sql<number>`count(*)::int` })
      .from(entities)
      .groupBy(entities.type),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(entities)
      .where(sql`NOT EXISTS (
        SELECT 1 FROM relations
        WHERE source_id = ${entities.id} OR target_id = ${entities.id}
      )`),
  ]);

  return {
    entities: firstCount(entityCount),
    relations: firstCount(relationCount),
    communities: firstCount(communityCount),
    entitiesWithCommunity: firstCount(entitiesWithCommunity),
    orphanEntities: firstCount(orphanRows),
    relationTypes: relationTypeRows,
    entityTypes: entityTypeRows,
  };
}

async function collectTaskRelationCandidates(): Promise<BackfillCandidate[]> {
  const rows = await db
    .select({
      sourceId: sql<string>`${entities.metadata}->>'taskId'`,
      targetId: entities.id,
      targetType: entities.type,
    })
    .from(entities)
    .where(sql`${entities.metadata}->>'taskId' IS NOT NULL`);

  const candidates = rows.filter(
    (row): row is BackfillCandidate =>
      typeof row.sourceId === 'string' &&
      row.sourceId.length > 0 &&
      row.sourceId !== row.targetId &&
      row.targetType !== 'task_trace',
  );

  const sourceIds = [...new Set(candidates.map((candidate) => candidate.sourceId))];
  if (sourceIds.length === 0) return [];

  const existingSources = await db
    .select({ id: entities.id })
    .from(entities)
    .where(inArray(entities.id, sourceIds));
  const existingSourceIds = new Set(existingSources.map((row) => row.id));

  return candidates.filter((candidate) => existingSourceIds.has(candidate.sourceId));
}

async function backfillTaskRelations(apply: boolean) {
  const candidates = await collectTaskRelationCandidates();
  const sourceIds = [...new Set(candidates.map((candidate) => candidate.sourceId))];
  const targetIds = [...new Set(candidates.map((candidate) => candidate.targetId))];
  const existingRows =
    sourceIds.length > 0 && targetIds.length > 0
      ? await db
          .select({
            sourceId: relations.sourceId,
            targetId: relations.targetId,
            relationType: relations.relationType,
          })
          .from(relations)
          .where(
            and(inArray(relations.sourceId, sourceIds), inArray(relations.targetId, targetIds)),
          )
      : [];
  const existingKeys = new Set(
    existingRows.map((row) => `${row.sourceId}\0${row.targetId}\0${row.relationType}`),
  );
  const missingCandidates = candidates.filter(
    (candidate) =>
      !existingKeys.has(
        `${candidate.sourceId}\0${candidate.targetId}\0${relationTypeForTarget(
          candidate.targetType,
        )}`,
      ),
  );
  let inserted = 0;

  if (apply) {
    for (const candidate of missingCandidates) {
      const result = await db
        .insert(relations)
        .values({
          sourceId: candidate.sourceId,
          targetId: candidate.targetId,
          relationType: relationTypeForTarget(candidate.targetType),
          weight: 1,
          confidence: 0.8,
          sourceTask: candidate.sourceId,
          provenance: 'backfill',
        })
        .onConflictDoNothing()
        .returning({ id: relations.id });
      if (result.length > 0) inserted += 1;
    }
  }

  return {
    dryRun: !apply,
    candidates: candidates.length,
    missing: missingCandidates.length,
    inserted,
    preview: missingCandidates.slice(0, 20),
  };
}

async function collectGuidanceDedupeGroups(): Promise<DedupeGroup[]> {
  const rows = await db
    .select({
      id: entities.id,
      type: entities.type,
      name: entities.name,
      description: entities.description,
      metadata: entities.metadata,
      confidence: entities.confidence,
      referenceCount: entities.referenceCount,
      createdAt: entities.createdAt,
    })
    .from(entities)
    .where(sql`${entities.type} IN ('rule', 'constraint', 'procedure', 'skill', 'command_recipe')
      AND ${entities.description} IS NOT NULL`);

  const grouped = new Map<string, DedupeEntity[]>();
  for (const row of rows) {
    const metadata = metadataRecord(row.metadata);
    const metadataHash =
      typeof metadata.normalizedContentHash === 'string'
        ? metadata.normalizedContentHash
        : undefined;
    const normalizedContentHash =
      metadataHash ?? contentFingerprint(row.description ?? row.name).normalizedContentHash;
    const key = `${row.type}\0${normalizedContentHash}`;
    const item: DedupeEntity = {
      ...row,
      metadata,
      normalizedContentHash,
    };
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }

  const groups: DedupeGroup[] = [];
  for (const items of grouped.values()) {
    if (items.length < 2) continue;
    const sorted = [...items].sort((left, right) => {
      const referenceDelta = right.referenceCount - left.referenceCount;
      if (referenceDelta !== 0) return referenceDelta;
      const confidenceDelta = (right.confidence ?? 0.5) - (left.confidence ?? 0.5);
      if (confidenceDelta !== 0) return confidenceDelta;
      const nameLengthDelta = left.name.length - right.name.length;
      if (nameLengthDelta !== 0) return nameLengthDelta;
      return left.createdAt.getTime() - right.createdAt.getTime();
    });
    const canonical = sorted[0];
    if (!canonical) continue;
    groups.push({
      normalizedContentHash: canonical.normalizedContentHash,
      type: canonical.type,
      canonical,
      duplicates: sorted.slice(1),
    });
  }

  return groups.sort((left, right) => right.duplicates.length - left.duplicates.length);
}

async function redirectRelationsToCanonical(duplicateId: string, canonicalId: string) {
  await db.execute(sql`
    INSERT INTO relations (
      source_id,
      target_id,
      relation_type,
      weight,
      confidence,
      source_task,
      provenance
    )
    SELECT
      moved.source_id,
      moved.target_id,
      moved.relation_type,
      max(moved.weight),
      max(moved.confidence),
      max(moved.source_task),
      'dedupe'
    FROM (
      SELECT
        CASE WHEN source_id = ${duplicateId} THEN ${canonicalId} ELSE source_id END AS source_id,
        CASE WHEN target_id = ${duplicateId} THEN ${canonicalId} ELSE target_id END AS target_id,
        relation_type,
        weight,
        confidence,
        source_task
      FROM relations
      WHERE source_id = ${duplicateId} OR target_id = ${duplicateId}
    ) moved
    WHERE moved.source_id <> moved.target_id
    GROUP BY moved.source_id, moved.target_id, moved.relation_type
    ON CONFLICT (source_id, target_id, relation_type) DO UPDATE SET
      weight = GREATEST(COALESCE(relations.weight, 0), COALESCE(excluded.weight, 0)),
      confidence = GREATEST(COALESCE(relations.confidence, 0), COALESCE(excluded.confidence, 0)),
      provenance = 'dedupe',
      recorded_at = now()
  `);

  await db
    .delete(relations)
    .where(sql`${relations.sourceId} = ${duplicateId} OR ${relations.targetId} = ${duplicateId}`);
}

async function applyGuidanceDedupeGroup(group: DedupeGroup) {
  const allItems = [group.canonical, ...group.duplicates];
  const sources = allItems.reduce<Record<string, unknown>[]>(
    (merged, item) => mergeSources(merged, metadataObjectArray(item.metadata, 'sources')),
    [],
  );
  const projects = uniqueStrings([
    ...allItems.flatMap((item) => metadataStringArray(item.metadata, 'projects')),
    ...sources
      .map((source) => (typeof source.project === 'string' ? source.project : ''))
      .filter((project) => project.length > 0),
  ]);
  const tags = uniqueStrings(
    allItems.flatMap((item) => metadataStringArray(item.metadata, 'tags')),
  );
  const mergedEntityIds = uniqueStrings([
    ...metadataStringArray(group.canonical.metadata, 'mergedEntityIds'),
    ...group.duplicates.map((duplicate) => duplicate.id),
  ]);

  for (const duplicate of group.duplicates) {
    await redirectRelationsToCanonical(duplicate.id, group.canonical.id);
    await db.delete(entities).where(sql`${entities.id} = ${duplicate.id}`);
  }

  await db
    .update(entities)
    .set({
      metadata: {
        ...group.canonical.metadata,
        source: 'guidance_import',
        project: projects.length === 1 ? projects[0] : projects.length > 1 ? 'multiple' : undefined,
        projects,
        tags,
        sources,
        normalizedContentHash: group.normalizedContentHash,
        duplicateSourceCount: sources.length,
        mergedEntityIds,
        dedupedAt: new Date().toISOString(),
      },
      referenceCount:
        group.canonical.referenceCount +
        group.duplicates.reduce((sum, duplicate) => sum + duplicate.referenceCount, 0),
      confidence: Math.max(
        group.canonical.confidence ?? 0.5,
        ...group.duplicates.map((duplicate) => duplicate.confidence ?? 0.5),
      ),
    })
    .where(sql`${entities.id} = ${group.canonical.id}`);
}

async function dedupeGuidance(apply: boolean) {
  const groups = await collectGuidanceDedupeGroups();
  let mergedEntities = 0;

  if (apply) {
    for (const group of groups) {
      await applyGuidanceDedupeGroup(group);
      mergedEntities += group.duplicates.length;
    }
  }

  return {
    dryRun: !apply,
    groups: groups.length,
    duplicateEntities: groups.reduce((sum, group) => sum + group.duplicates.length, 0),
    mergedEntities,
    preview: groups.slice(0, 20).map((group) => ({
      type: group.type,
      normalizedContentHash: group.normalizedContentHash,
      canonical: {
        id: group.canonical.id,
        name: group.canonical.name,
      },
      duplicates: group.duplicates.map((duplicate) => ({
        id: duplicate.id,
        name: duplicate.name,
      })),
    })),
  };
}

async function sourceArchiveIdsForEntity(entityId: string): Promise<string[]> {
  const rows = await db
    .select({ sourceId: relations.sourceId })
    .from(relations)
    .where(sql`${relations.targetId} = ${entityId}
      AND ${relations.relationType} = 'contains_guidance'`);
  return uniqueStrings(rows.map((row) => row.sourceId));
}

async function collectGuidanceEntities(): Promise<GuidanceEntity[]> {
  const rows = await db
    .select({
      id: entities.id,
      type: entities.type,
      name: entities.name,
      description: entities.description,
      metadata: entities.metadata,
      confidence: entities.confidence,
      referenceCount: entities.referenceCount,
    })
    .from(entities)
    .where(sql`${entities.type} IN ('rule', 'constraint', 'procedure', 'skill', 'command_recipe')
      AND ${entities.description} IS NOT NULL`);

  return rows.map((row) => ({
    ...row,
    metadata: metadataRecord(row.metadata),
  }));
}

async function attachArchiveRelations(
  archiveIds: string[],
  targetId: string,
  confidence: number,
  provenance: string,
) {
  for (const archiveId of archiveIds) {
    await db
      .insert(relations)
      .values({
        sourceId: archiveId,
        targetId,
        relationType: 'contains_guidance',
        weight: confidence,
        confidence,
        provenance,
      })
      .onConflictDoNothing();
  }
}

async function upsertGuidanceEntity(input: GuidanceEntityUpsertInput): Promise<string> {
  const fingerprint = contentFingerprint(input.description);
  const existingRows = await db
    .select({
      id: entities.id,
      name: entities.name,
      metadata: entities.metadata,
      confidence: entities.confidence,
      referenceCount: entities.referenceCount,
    })
    .from(entities)
    .where(sql`${entities.type} = ${input.type}
      AND (
        ${entities.id} = ${input.id}
        OR ${entities.metadata}->>'normalizedContentHash' = ${fingerprint.normalizedContentHash}
      )`)
    .limit(1);

  const existing = existingRows[0];
  const entityId = existing?.id ?? input.id;
  const existingMetadata = metadataRecord(existing?.metadata);
  const existingSources = metadataObjectArray(existingMetadata, 'sources');
  const incomingSources = metadataObjectArray(input.metadata, 'sources');
  const sources = mergeSources(existingSources, incomingSources);
  const projects = uniqueStrings([
    ...metadataStringArray(existingMetadata, 'projects'),
    ...metadataStringArray(input.metadata, 'projects'),
    ...sources
      .map((source) => (typeof source.project === 'string' ? source.project : ''))
      .filter((project) => project.length > 0),
  ]);
  const tags = uniqueStrings([
    ...metadataStringArray(existingMetadata, 'tags'),
    ...metadataStringArray(input.metadata, 'tags'),
  ]);
  const mergedEntityIds = uniqueStrings([
    ...metadataStringArray(existingMetadata, 'mergedEntityIds'),
    ...metadataStringArray(input.metadata, 'mergedEntityIds'),
  ]);
  const splitFromEntityIds = uniqueStrings([
    ...metadataStringArray(existingMetadata, 'splitFromEntityIds'),
    ...metadataStringArray(input.metadata, 'splitFromEntityIds'),
  ]);

  const metadata = {
    ...existingMetadata,
    ...input.metadata,
    source: 'guidance_import',
    project: projects.length === 1 ? projects[0] : projects.length > 1 ? 'multiple' : undefined,
    projects,
    tags,
    sources,
    mergedEntityIds,
    splitFromEntityIds,
    contentHash: fingerprint.contentHash,
    normalizedContentHash: fingerprint.normalizedContentHash,
    normalizedAt: new Date().toISOString(),
  };
  const embedding = await generateEmbedding(input.description);

  await db
    .insert(entities)
    .values({
      id: entityId,
      type: input.type,
      name: input.name,
      description: input.description,
      embedding,
      metadata,
      confidence: input.confidence,
      provenance: 'guidance_normalize',
      scope: 'on_demand',
      freshness: new Date(),
      referenceCount: existing?.referenceCount ?? 0,
    })
    .onConflictDoUpdate({
      target: entities.id,
      set: {
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        embedding: sql`excluded.embedding`,
        metadata: sql`excluded.metadata`,
        confidence: sql`GREATEST(COALESCE(${entities.confidence}, 0), excluded.confidence)`,
        provenance: sql`excluded.provenance`,
        scope: sql`excluded.scope`,
        freshness: sql`excluded.freshness`,
      },
    });

  await attachArchiveRelations(
    input.sourceArchiveIds,
    entityId,
    input.confidence,
    'guidance_normalize',
  );
  return entityId;
}

async function deleteGuidanceEntities(entityIds: string[]) {
  for (const entityId of uniqueStrings(entityIds)) {
    await db
      .delete(relations)
      .where(sql`${relations.sourceId} = ${entityId} OR ${relations.targetId} = ${entityId}`);
    await db.delete(entities).where(sql`${entities.id} = ${entityId}`);
  }
}

async function normalizeGuidance(apply: boolean) {
  const guidanceEntities = await collectGuidanceEntities();
  const archiveIdsByEntity = new Map<string, string[]>();
  for (const entity of guidanceEntities) {
    archiveIdsByEntity.set(entity.id, await sourceArchiveIdsForEntity(entity.id));
  }

  const targetCompoundEntities = guidanceEntities.filter(isTargetCompoundGuidance);
  const compoundItems = targetCompoundEntities.flatMap((entity) =>
    extractCompoundRuleItems(entity, archiveIdsByEntity.get(entity.id) ?? []),
  );
  const compoundEntities = targetCompoundEntities.filter((entity) =>
    isCompoundEntity(
      entity,
      compoundItems.filter((item) => item.sourceEntity.id === entity.id),
    ),
  );
  const loggingExistingEntities = guidanceEntities.filter(isAtomicLoggingEntity);
  const loggingSplitItems = compoundItems.filter((item) => isLoggingGuidance(item.title));
  const anyExistingEntities = guidanceEntities.filter(isAtomicAnyEntity);
  const anySplitItems = compoundItems.filter((item) => isAnyGuidance(`${item.title} ${item.body}`));
  const clusteredSplitItems = new Set([...loggingSplitItems, ...anySplitItems]);
  const nonClusteredSplitItems = compoundItems.filter((item) => !clusteredSplitItems.has(item));
  const loggingSourceEntities = uniqueStrings([
    ...loggingExistingEntities.map((entity) => entity.id),
    ...loggingSplitItems.map((item) => item.sourceEntity.id),
  ])
    .map((id) => guidanceEntities.find((entity) => entity.id === id))
    .filter((entity): entity is GuidanceEntity => entity !== undefined);

  const loggingSources = loggingSourceEntities.reduce<Record<string, unknown>[]>(
    (merged, entity) => mergeSources(merged, sourceArchiveMetadata(entity)),
    [],
  );
  const loggingArchiveIds = uniqueStrings(
    loggingSourceEntities.flatMap((entity) => archiveIdsByEntity.get(entity.id) ?? []),
  );
  const loggingMergedEntityIds = uniqueStrings(
    loggingExistingEntities
      .map((entity) => entity.id)
      .filter((id) => id !== generateEntityId('rule', canonicalLoggingTitle)),
  );
  const loggingInput: GuidanceEntityUpsertInput | null =
    loggingSplitItems.length > 0 || loggingExistingEntities.length > 1
      ? {
          id: generateEntityId('rule', canonicalLoggingTitle),
          type: 'rule',
          name: canonicalLoggingTitle,
          description: loggingDescription([
            ...loggingSplitItems.map((item) => ({ title: item.title, body: item.body })),
            ...loggingExistingEntities.map((entity) => ({
              title: entity.name,
              body: entity.description ?? entity.name,
            })),
          ]),
          metadata: {
            tags: ['logging', 'coding-rule'],
            sources: loggingSources,
            projects: guidanceProjects(loggingSourceEntities, loggingSources),
            mergedEntityIds: loggingMergedEntityIds,
            normalizedFrom: 'logging-cluster',
          },
          confidence: Math.max(
            0.8,
            ...loggingSourceEntities.map((entity) => entity.confidence ?? 0.5),
          ),
          sourceArchiveIds: loggingArchiveIds,
        }
      : null;

  const anySourceEntities = uniqueStrings([
    ...anyExistingEntities.map((entity) => entity.id),
    ...anySplitItems.map((item) => item.sourceEntity.id),
  ])
    .map((id) => guidanceEntities.find((entity) => entity.id === id))
    .filter((entity): entity is GuidanceEntity => entity !== undefined);
  const anySources = anySourceEntities.reduce<Record<string, unknown>[]>(
    (merged, entity) => mergeSources(merged, sourceArchiveMetadata(entity)),
    [],
  );
  const anyArchiveIds = uniqueStrings(
    anySourceEntities.flatMap((entity) => archiveIdsByEntity.get(entity.id) ?? []),
  );
  const anyMergedEntityIds = uniqueStrings(
    anyExistingEntities
      .map((entity) => entity.id)
      .filter((id) => id !== generateEntityId('rule', canonicalAnyTitle)),
  );
  const anyInput: GuidanceEntityUpsertInput | null =
    anySplitItems.length > 0 ||
    anyExistingEntities.some((entity) => entity.id !== generateEntityId('rule', canonicalAnyTitle))
      ? {
          id: generateEntityId('rule', canonicalAnyTitle),
          type: 'rule',
          name: canonicalAnyTitle,
          description: anyDescription([
            ...anySplitItems.map((item) => ({ title: item.title, body: item.body })),
            ...anyExistingEntities.map((entity) => ({
              title: entity.name,
              body: entity.description ?? entity.name,
            })),
          ]),
          metadata: {
            tags: ['typescript', 'typing', 'coding-rule'],
            sources: anySources,
            projects: guidanceProjects(anySourceEntities, anySources),
            mergedEntityIds: anyMergedEntityIds,
            normalizedFrom: 'any-unknown-cluster',
          },
          confidence: Math.max(0.8, ...anySourceEntities.map((entity) => entity.confidence ?? 0.5)),
          sourceArchiveIds: anyArchiveIds,
        }
      : null;

  const splitInputs: GuidanceEntityUpsertInput[] = nonClusteredSplitItems.map((item) => {
    const sourceMetadata = item.sourceEntity.metadata;
    const sources = sourceArchiveMetadata(item.sourceEntity).map((source) => ({
      ...source,
      title: item.title,
    }));
    const name =
      item.title !== item.body && item.title.length < 18 && item.body.length > 0
        ? compactTitle(`${item.title}: ${item.body}`, 88)
        : compactTitle(item.title, 88);
    return {
      id: generateEntityId(item.sourceEntity.type, name),
      type: item.sourceEntity.type,
      name,
      description: item.content,
      metadata: {
        ...sourceMetadata,
        tags: uniqueStrings([...metadataStringArray(sourceMetadata, 'tags'), 'coding-rule']),
        sources,
        projects: guidanceProjects([item.sourceEntity], sources),
        splitFromEntityIds: [item.sourceEntity.id],
        normalizedFrom: 'compound-guidance',
      },
      confidence: item.sourceEntity.confidence ?? 0.75,
      sourceArchiveIds: item.sourceArchiveIds,
    };
  });

  let loggingCanonicalId: string | null = null;
  let anyCanonicalId: string | null = null;
  const createdOrUpdatedIds: string[] = [];

  if (apply) {
    if (loggingInput) {
      loggingCanonicalId = await upsertGuidanceEntity(loggingInput);
      createdOrUpdatedIds.push(loggingCanonicalId);
    }

    if (anyInput) {
      anyCanonicalId = await upsertGuidanceEntity(anyInput);
      createdOrUpdatedIds.push(anyCanonicalId);
    }

    for (const input of splitInputs) {
      createdOrUpdatedIds.push(await upsertGuidanceEntity(input));
    }

    const deleteIds = uniqueStrings([
      ...compoundEntities.map((entity) => entity.id),
      ...(loggingInput
        ? loggingExistingEntities
            .map((entity) => entity.id)
            .filter((id) => id !== loggingCanonicalId && !createdOrUpdatedIds.includes(id))
        : []),
      ...(anyInput
        ? anyExistingEntities
            .map((entity) => entity.id)
            .filter((id) => id !== anyCanonicalId && !createdOrUpdatedIds.includes(id))
        : []),
    ]);
    await deleteGuidanceEntities(deleteIds);

    await db.delete(relations).where(sql`${relations.provenance} = 'embedding_similarity'
        AND ${relations.relationType} IN ('same_principle_as', 'similar_to')`);
  }

  return {
    dryRun: !apply,
    compoundEntities: compoundEntities.map((entity) => ({ id: entity.id, name: entity.name })),
    loggingMerge: loggingInput
      ? {
          canonical: { id: loggingInput.id, name: loggingInput.name },
          mergedEntities: loggingMergedEntityIds.map((id) => ({
            id,
            name: guidanceEntities.find((entity) => entity.id === id)?.name ?? id,
          })),
          splitItems: loggingSplitItems.map((item) => item.title),
        }
      : null,
    anyMerge: anyInput
      ? {
          canonical: { id: anyInput.id, name: anyInput.name },
          mergedEntities: anyMergedEntityIds.map((id) => ({
            id,
            name: guidanceEntities.find((entity) => entity.id === id)?.name ?? id,
          })),
          splitItems: anySplitItems.map((item) => item.title),
        }
      : null,
    splitEntities: splitInputs.map((input) => ({
      id: input.id,
      name: input.name,
      splitFromEntityIds: input.metadata.splitFromEntityIds,
    })),
    createdOrUpdated: createdOrUpdatedIds.length,
  };
}

async function collectSimilarGuidanceCandidates(input: {
  threshold: number;
  samePrincipleThreshold: number;
  limit: number;
  includeSameProject: boolean;
}): Promise<SimilarGuidanceCandidate[]> {
  const rows = await db.execute<{
    source_id: string;
    source_name: string;
    source_description: string | null;
    source_project: string | null;
    target_id: string;
    target_name: string;
    target_description: string | null;
    target_project: string | null;
    similarity: number;
  }>(sql`
    SELECT
      source.id AS source_id,
      source.name AS source_name,
      source.description AS source_description,
      source.metadata->>'project' AS source_project,
      target.id AS target_id,
      target.name AS target_name,
      target.description AS target_description,
      target.metadata->>'project' AS target_project,
      (1 - (source.embedding <=> target.embedding))::real AS similarity
    FROM entities source
    JOIN entities target
      ON source.id < target.id
     AND source.embedding IS NOT NULL
     AND target.embedding IS NOT NULL
    WHERE source.type IN ('rule', 'constraint', 'procedure', 'skill', 'command_recipe')
      AND target.type IN ('rule', 'constraint', 'procedure', 'skill', 'command_recipe')
      AND source.description IS NOT NULL
      AND target.description IS NOT NULL
      AND (1 - (source.embedding <=> target.embedding)) >= ${input.threshold}
    ORDER BY similarity DESC, source.name, target.name
    LIMIT ${input.limit * 20}
  `);

  return rows.rows
    .filter(
      (row) =>
        input.includeSameProject ||
        (row.source_project ?? '__none__') !== (row.target_project ?? '__none__'),
    )
    .map((row) => {
      const similarity = Number(row.similarity);
      const anchors = commonSimilarityAnchors(row.source_name, row.target_name);
      const relationType: SimilarGuidanceCandidate['relationType'] =
        similarity >= input.samePrincipleThreshold && anchors.length >= 2
          ? 'same_principle_as'
          : 'similar_to';
      return {
        sourceId: row.source_id,
        sourceName: row.source_name,
        sourceProject: row.source_project,
        targetId: row.target_id,
        targetName: row.target_name,
        targetProject: row.target_project,
        similarity,
        anchors,
        relationType,
        weight: relationType === 'same_principle_as' ? similarity * 2 : similarity * 1.4,
      };
    })
    .filter((candidate) => candidate.anchors.length > 0)
    .slice(0, input.limit);
}

async function linkSimilarGuidance(input: {
  apply: boolean;
  threshold: number;
  samePrincipleThreshold: number;
  limit: number;
  includeSameProject: boolean;
}) {
  const candidates = await collectSimilarGuidanceCandidates(input);
  let deleted = 0;
  let inserted = 0;

  if (input.apply) {
    const deletedRows = await db
      .delete(relations)
      .where(sql`${relations.provenance} = 'embedding_similarity'
        AND ${relations.relationType} IN ('same_principle_as', 'similar_to')`)
      .returning({ id: relations.id });
    deleted = deletedRows.length;

    for (const candidate of candidates) {
      const insertedRows = await db
        .insert(relations)
        .values({
          sourceId: candidate.sourceId,
          targetId: candidate.targetId,
          relationType: candidate.relationType,
          weight: candidate.weight,
          confidence: candidate.similarity,
          provenance: 'embedding_similarity',
        })
        .onConflictDoUpdate({
          target: [relations.sourceId, relations.targetId, relations.relationType],
          set: {
            weight: sql`excluded.weight`,
            confidence: sql`excluded.confidence`,
            provenance: sql`excluded.provenance`,
            recordedAt: sql`now()`,
          },
        })
        .returning({ id: relations.id });
      if (insertedRows.length > 0) inserted += 1;
    }
  }

  return {
    dryRun: !input.apply,
    threshold: input.threshold,
    samePrincipleThreshold: input.samePrincipleThreshold,
    includeSameProject: input.includeSameProject,
    candidates: candidates.length,
    deleted,
    inserted,
    preview: candidates.slice(0, 30),
  };
}

async function rebuildCommunities(input: {
  deterministicSummary: boolean;
  linkSimilarGuidanceFirst: boolean;
  threshold: number;
  samePrincipleThreshold: number;
  limit: number;
  includeSameProject: boolean;
}) {
  let similarGuidance: Awaited<ReturnType<typeof linkSimilarGuidance>> | { skipped: true } = {
    skipped: true,
  };

  if (input.linkSimilarGuidanceFirst) {
    similarGuidance = await linkSimilarGuidance({
      apply: true,
      threshold: input.threshold,
      samePrincipleThreshold: input.samePrincipleThreshold,
      limit: input.limit,
      includeSameProject: input.includeSameProject,
    });
  }

  const result = await buildCommunities({
    summarize: input.deterministicSummary
      ? async (context) => {
          const firstEntity = context
            .split('\n')
            .find((line) => line.startsWith('- '))
            ?.replace(/^- /, '')
            .slice(0, 80);
          return {
            name: firstEntity ? `Community: ${firstEntity}` : 'Knowledge Community',
            summary: context.slice(0, 1200),
          };
        }
      : undefined,
    logger: (message) => console.log(`[community] ${message}`),
  });

  return {
    similarGuidance,
    community: result,
  };
}

function printHelp() {
  console.log(`Usage:
  bun run src/scripts/graph-maintenance.ts diagnose [--json]
  bun run src/scripts/graph-maintenance.ts backfill-task-relations [--apply] [--json]
  bun run src/scripts/graph-maintenance.ts dedupe-guidance [--apply] [--json]
  bun run src/scripts/graph-maintenance.ts normalize-guidance [--apply] [--json]
  bun run src/scripts/graph-maintenance.ts link-similar-guidance [--apply] [--threshold 0.9] [--same-principle-threshold 0.925] [--limit 500] [--include-same-project] [--json]
  bun run src/scripts/graph-maintenance.ts rebuild-communities [--deterministic-summary] [--skip-similar-linking] [--threshold 0.9] [--same-principle-threshold 0.925] [--limit 500] [--include-same-project] [--json]
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  try {
    if (args.command === 'help') {
      printHelp();
      return;
    }

    if (args.command === 'diagnose') {
      printPayload(await diagnoseGraph(), args.json);
      return;
    }

    if (args.command === 'backfill-task-relations') {
      printPayload(await backfillTaskRelations(args.apply), args.json);
      return;
    }

    if (args.command === 'dedupe-guidance') {
      printPayload(await dedupeGuidance(args.apply), args.json);
      return;
    }

    if (args.command === 'normalize-guidance') {
      printPayload(await normalizeGuidance(args.apply), args.json);
      return;
    }

    if (args.command === 'link-similar-guidance') {
      printPayload(
        await linkSimilarGuidance({
          apply: args.apply,
          threshold: args.threshold,
          samePrincipleThreshold: args.samePrincipleThreshold,
          limit: args.limit,
          includeSameProject: args.includeSameProject,
        }),
        args.json,
      );
      return;
    }

    if (args.command === 'rebuild-communities') {
      printPayload(
        await rebuildCommunities({
          deterministicSummary: args.deterministicSummary,
          linkSimilarGuidanceFirst: !args.skipSimilarLinking,
          threshold: args.threshold,
          samePrincipleThreshold: args.samePrincipleThreshold,
          limit: args.limit,
          includeSameProject: args.includeSameProject,
        }),
        args.json,
      );
      return;
    }
  } finally {
    await closeDbPool();
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await closeDbPool();
  process.exit(1);
});
