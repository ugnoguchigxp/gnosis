#!/usr/bin/env bun

import { and, inArray, sql } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { communities, entities, relations } from '../db/schema.js';
import { buildCommunities } from '../services/community.js';

type CliArgs = {
  command:
    | 'diagnose'
    | 'backfill-task-relations'
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
