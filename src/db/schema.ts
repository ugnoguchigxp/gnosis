import { pgTable, uuid, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { vector } from 'drizzle-orm/pg-core'; // Drizzle supports pgvector

// 非構造化メモリ (Vibe Memory)
export const vibeMemories = pgTable('vibe_memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: text('session_id').notNull(),
  content: text('content').notNull(),
  // 384 dimensions matching intfloat/multilingual-e5-small
  embedding: vector('embedding', { dimensions: 384 }),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 構造化知識 (Knowledge Graph)
// TypeGraph連携のために最低限のメタデータを保存します
export const entities = pgTable('entities', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const relations = pgTable('relations', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: text('source_id')
    .references(() => entities.id, { onDelete: 'cascade' })
    .notNull(),
  targetId: text('target_id')
    .references(() => entities.id, { onDelete: 'cascade' })
    .notNull(),
  relationType: text('relation_type').notNull(),
  weight: text('weight'), // or numeric
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
