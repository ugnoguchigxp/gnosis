import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { config } from '../config.js';

// 非構造化メモリ (Vibe Memory)
export const vibeMemories = pgTable(
  'vibe_memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: text('session_id').notNull(),
    content: text('content').notNull(),
    // Matching configured dimension
    embedding: vector('embedding', { dimensions: config.embeddingDimension }),
    metadata: jsonb('metadata').default({}),
    referenceCount: integer('reference_count').default(0).notNull(),
    lastReferencedAt: timestamp('last_referenced_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    sessionCreatedAtIdx: index('vibe_memories_session_created_at_idx').on(
      table.sessionId,
      table.createdAt,
    ),
    embeddingHnswIdx: index('vibe_memories_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
  }),
);

// ナレッジグラフ内の「知識の塊」を要約して管理する
export const communities = pgTable('communities', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  summary: text('summary').notNull(),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 構造化知識 (Knowledge Graph)
// TypeGraph連携のために最低限のメタデータを保存します
export const entities = pgTable(
  'entities',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    embedding: vector('embedding', { dimensions: config.embeddingDimension }), // nullable
    communityId: uuid('community_id').references(() => communities.id, { onDelete: 'set null' }),
    metadata: jsonb('metadata').default({}),
    referenceCount: integer('reference_count').default(0).notNull(),
    lastReferencedAt: timestamp('last_referenced_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    embeddingHnswIdx: index('entities_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
  }),
);

// 外部データの同期状態（差分同期用）を管理
export const syncState = pgTable('sync_state', {
  id: text('id').primaryKey(), // 'claude_logs', 'antigravity_logs' 等
  lastSyncedAt: timestamp('last_synced_at').notNull(),
  cursor: jsonb('cursor').default({}).notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const relations = pgTable(
  'relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: text('source_id')
      .references(() => entities.id, { onDelete: 'cascade' })
      .notNull(),
    targetId: text('target_id')
      .references(() => entities.id, { onDelete: 'cascade' })
      .notNull(),
    relationType: text('relation_type').notNull(),
    weight: real('weight'), // changed from text to real
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueRelation: unique('relations_source_target_type_unique').on(
      table.sourceId,
      table.targetId,
      table.relationType,
    ),
  }),
);
