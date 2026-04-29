#!/usr/bin/env bun
/**
 * graph-snapshot.ts
 * Knowledge Graph の全体スナップショットを取得する CLI
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { communities, entities, relations } from '../db/schema.js';

type GraphSnapshotPayload = {
  entities: Array<{
    id: string;
    name: string;
    type: string;
    description: string | null;
    confidence: number;
    scope: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    communityId: string | null;
    referenceCount: number;
  }>;
  relations: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    relationType: string;
    weight: number | null;
  }>;
  communities: Array<{
    id: string;
    summary: string | null;
    memberCount: number;
  }>;
  stats: {
    totalEntities: number;
    totalRelations: number;
    totalCommunities: number;
    totalEntitiesInDb: number;
    totalRelationsInDb: number;
    totalCommunitiesInDb: number;
    limitApplied: boolean;
  };
};

const MAX_ENTITIES = Number(process.env.GRAPH_SNAPSHOT_MAX_ENTITIES) || 1000;
const MAX_RELATIONS = Number(process.env.GRAPH_SNAPSHOT_MAX_RELATIONS) || 2000;
const MAX_COMMUNITIES = Number(process.env.GRAPH_SNAPSHOT_MAX_COMMUNITIES) || 100;
const HIDDEN_RELATION_TYPES = new Set(['contains_guidance']);

const metadataRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const isArchiveEntity = (entity: { id: string; type: string; metadata: unknown }): boolean => {
  const metadata = metadataRecord(entity.metadata);
  return (
    entity.type === 'project_doc' &&
    (entity.id.startsWith('project_doc/archive:') || typeof metadata.archiveKey === 'string')
  );
};

async function fetchGraphSnapshot(): Promise<GraphSnapshotPayload> {
  // 総数を取得
  const [entityCount] = await db.select({ count: sql<number>`count(*)::int` }).from(entities);
  const [relationCount] = await db.select({ count: sql<number>`count(*)::int` }).from(relations);
  const [communityCount] = await db.select({ count: sql<number>`count(*)::int` }).from(communities);

  const totalEntitiesInDb = entityCount?.count ?? 0;
  const totalRelationsInDb = relationCount?.count ?? 0;
  const totalCommunitiesInDb = communityCount?.count ?? 0;

  // データ取得
  const [allEntities, allRelations, allCommunities] = await Promise.all([
    db.select().from(entities).limit(MAX_ENTITIES),
    db.select().from(relations).limit(MAX_RELATIONS),
    db.select().from(communities).limit(MAX_COMMUNITIES),
  ]);

  const communityMemberCounts = await db
    .select({
      communityId: entities.communityId,
      count: sql<number>`count(*)::int`,
    })
    .from(entities)
    .where(sql`${entities.communityId} is not null`)
    .groupBy(entities.communityId);

  const memberCountByCommunityId = new Map(
    communityMemberCounts.map((row) => [row.communityId, row.count]),
  );

  const visibleEntities = allEntities.filter((entity) => !isArchiveEntity(entity));
  const visibleEntityIds = new Set(visibleEntities.map((entity) => entity.id));
  const visibleRelations = allRelations.filter(
    (relation) =>
      !HIDDEN_RELATION_TYPES.has(relation.relationType) &&
      visibleEntityIds.has(relation.sourceId) &&
      visibleEntityIds.has(relation.targetId),
  );

  const limitApplied =
    totalEntitiesInDb > MAX_ENTITIES ||
    totalRelationsInDb > MAX_RELATIONS ||
    totalCommunitiesInDb > MAX_COMMUNITIES;

  return {
    entities: visibleEntities.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      description: e.description,
      confidence: e.confidence ?? 0.5,
      scope: e.scope ?? 'on_demand',
      metadata:
        e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata)
          ? (e.metadata as Record<string, unknown>)
          : {},
      createdAt: e.createdAt.toISOString(),
      communityId: e.communityId,
      referenceCount: e.referenceCount,
    })),
    relations: visibleRelations.map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      targetId: r.targetId,
      relationType: r.relationType,
      weight: r.weight ?? 1,
    })),
    communities: allCommunities.map((c) => ({
      id: c.id,
      summary: c.summary,
      memberCount: memberCountByCommunityId.get(c.id) ?? 0,
    })),
    stats: {
      totalEntities: visibleEntities.length,
      totalRelations: visibleRelations.length,
      totalCommunities: allCommunities.length,
      totalEntitiesInDb,
      totalRelationsInDb,
      totalCommunitiesInDb,
      limitApplied,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');

  try {
    const snapshot = await fetchGraphSnapshot();
    if (isJson) {
      console.log(JSON.stringify(snapshot));
    } else {
      console.log('=== Knowledge Graph Snapshot ===');
      console.log(
        `Entities: ${snapshot.stats.totalEntities} / ${snapshot.stats.totalEntitiesInDb}`,
      );
      console.log(
        `Relations: ${snapshot.stats.totalRelations} / ${snapshot.stats.totalRelationsInDb}`,
      );
      console.log(
        `Communities: ${snapshot.stats.totalCommunities} / ${snapshot.stats.totalCommunitiesInDb}`,
      );
      if (snapshot.stats.limitApplied) {
        console.log('⚠️  Limit applied - some data is not displayed');
      }
    }
    process.exit(0);
  } catch (error) {
    if (isJson) {
      console.error(JSON.stringify({ success: false, error: String(error) }));
    } else {
      console.error('Failed to fetch graph snapshot:', error);
    }
    process.exit(1);
  }
}

main();
