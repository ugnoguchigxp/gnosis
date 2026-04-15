import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
    dedupeKey: text('dedupe_key'),
    metadata: jsonb('metadata').default({}),
    referenceCount: integer('reference_count').default(0).notNull(),
    lastReferencedAt: timestamp('last_referenced_at').defaultNow().notNull(),
    isSynthesized: boolean('is_synthesized').default(false).notNull(),
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
    sessionDedupeUnique: unique('vibe_memories_session_dedupe_key_unique').on(
      table.sessionId,
      table.dedupeKey,
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

// 失敗学習ループ (Failure Learning Loop)
export const experienceLogs = pgTable(
  'experience_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: text('session_id').notNull(),
    scenarioId: text('scenario_id').notNull(),
    attempt: integer('attempt').notNull(),
    type: text('type').notNull(), // 'failure' | 'success'
    failureType: text('failure_type'), // e.g., 'RISK_BLOCKING'
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: config.embeddingDimension }),
    metadata: jsonb('metadata').default({}), // riskFindings, applyRejects, patchDigest, etc.
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    sessionScenarioIdx: index('experience_logs_session_scenario_idx').on(
      table.sessionId,
      table.scenarioId,
    ),
    embeddingHnswIdx: index('experience_logs_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
  }),
);

// KnowFlow Queue (JSONB payload)
export const topicTasks = pgTable(
  'topic_tasks',
  {
    id: uuid('id').primaryKey(),
    dedupeKey: text('dedupe_key').notNull(),
    status: text('status').notNull(), // pending | running | done | failed | deferred
    priority: integer('priority').notNull(),
    nextRunAt: bigint('next_run_at', { mode: 'number' }),
    lockedAt: bigint('locked_at', { mode: 'number' }),
    lockOwner: text('lock_owner'),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    statusNextRunPriorityIdx: index('topic_tasks_status_next_run_priority_idx').on(
      table.status,
      table.nextRunAt,
      table.priority,
      table.createdAt,
    ),
    dedupeKeyIdx: index('topic_tasks_dedupe_key_idx').on(table.dedupeKey),
  }),
);

// KnowFlow Knowledge tables
export const knowledgeTopics = pgTable(
  'knowledge_topics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    canonicalTopic: text('canonical_topic').notNull(),
    aliases: jsonb('aliases').default([]).notNull(),
    confidence: real('confidence').default(0).notNull(),
    coverage: real('coverage').default(0).notNull(),
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    canonicalTopicUnique: unique('knowledge_topics_canonical_topic_unique').on(
      table.canonicalTopic,
    ),
    updatedAtIdx: index('knowledge_topics_updated_idx').on(table.updatedAt),
  }),
);

export const knowledgeClaims = pgTable(
  'knowledge_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    topicId: uuid('topic_id')
      .references(() => knowledgeTopics.id, { onDelete: 'cascade' })
      .notNull(),
    text: text('text').notNull(),
    confidence: real('confidence').default(0).notNull(),
    sourceIds: jsonb('source_ids').default([]).notNull(),
    embedding: jsonb('embedding'),
    fingerprint: text('fingerprint').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    topicFingerprintUnique: unique('knowledge_claims_topic_fingerprint_unique').on(
      table.topicId,
      table.fingerprint,
    ),
    topicIdx: index('knowledge_claims_topic_idx').on(table.topicId),
    textFtsIdx: index('knowledge_claims_text_fts_idx').using(
      'gin',
      sql`to_tsvector('simple', ${table.text})`,
    ),
  }),
);

export const knowledgeRelations = pgTable(
  'knowledge_relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    topicId: uuid('topic_id')
      .references(() => knowledgeTopics.id, { onDelete: 'cascade' })
      .notNull(),
    relationType: text('relation_type').notNull(),
    targetTopic: text('target_topic').notNull(),
    confidence: real('confidence').default(0).notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    topicFingerprintUnique: unique('knowledge_relations_topic_fingerprint_unique').on(
      table.topicId,
      table.fingerprint,
    ),
    topicIdx: index('knowledge_relations_topic_idx').on(table.topicId),
  }),
);

export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    topicId: uuid('topic_id')
      .references(() => knowledgeTopics.id, { onDelete: 'cascade' })
      .notNull(),
    sourceId: text('source_id').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    domain: text('domain'),
    fetchedAt: bigint('fetched_at', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    topicSourceUnique: unique('knowledge_sources_topic_source_unique').on(
      table.topicId,
      table.sourceId,
    ),
    topicIdx: index('knowledge_sources_topic_idx').on(table.topicId),
  }),
);

export const reviewCases = pgTable(
  'review_cases',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    repoPath: text('repo_path').notNull(),
    baseRef: text('base_ref'),
    headRef: text('head_ref'),
    taskGoal: text('task_goal'),
    trigger: text('trigger').notNull(),
    status: text('status').notNull().default('running'),
    riskLevel: text('risk_level'),
    reviewStatus: text('review_status'),
    summary: text('summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    taskIdx: index('idx_review_cases_task').on(table.taskId),
    statusIdx: index('idx_review_cases_status').on(table.status),
    repoCreatedAtIdx: index('idx_review_cases_repo').on(table.repoPath, table.createdAt),
  }),
);

export const reviewOutcomes = pgTable(
  'review_outcomes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reviewCaseId: text('review_case_id')
      .references(() => reviewCases.id, { onDelete: 'cascade' })
      .notNull(),
    findingId: text('finding_id').notNull(),
    outcomeType: text('outcome_type').notNull(),
    followupCommitHash: text('followup_commit_hash'),
    resolutionTimestamp: timestamp('resolution_timestamp', { withTimezone: true }),
    guidanceIds: jsonb('guidance_ids').default([]),
    falsePositive: boolean('false_positive').default(false),
    notes: text('notes'),
    autoDetected: boolean('auto_detected').default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => ({
    caseIdx: index('idx_review_outcomes_case').on(table.reviewCaseId),
    outcomeIdx: index('idx_review_outcomes_outcome').on(table.outcomeType),
    falsePositiveIdx: index('idx_review_outcomes_fp')
      .on(table.falsePositive)
      .where(sql`${table.falsePositive} = true`),
    uniqueReviewFinding: unique('review_outcomes_case_finding_unique').on(
      table.reviewCaseId,
      table.findingId,
    ),
  }),
);
