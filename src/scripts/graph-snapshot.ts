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
    communityId: string | null;
    referenceCount: number;
  }>;
  relations: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    relationType: string;
    weight: number;
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

  const limitApplied =
    totalEntitiesInDb > MAX_ENTITIES ||
    totalRelationsInDb > MAX_RELATIONS ||
    totalCommunitiesInDb > MAX_COMMUNITIES;

  return {
    entities: allEntities.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      description: e.description,
      communityId: e.communityId,
      referenceCount: e.referenceCount,
    })),
    relations: allRelations.map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      targetId: r.targetId,
      relationType: r.relationType,
      weight: r.weight,
    })),
    communities: allCommunities.map((c) => ({
      id: c.id,
      summary: c.summary,
      memberCount: c.memberCount,
    })),
    stats: {
      totalEntities: allEntities.length,
      totalRelations: allRelations.length,
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
