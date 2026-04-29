import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
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
    // Phase 2 additions
    memoryType: text('memory_type').default('raw').notNull(),
    sourceTask: text('source_task'),
    importance: real('importance').default(0.5),
    compressed: boolean('compressed').default(false),
  },
  (table) => ({
    sessionCreatedAtIdx: index('vibe_memories_session_created_at_idx').on(
      table.sessionId,
      table.createdAt,
    ),
    memoryTypeIdx: index('vibe_memories_memory_type_idx').on(table.memoryType),
    sessionRawPendingIdx: index('vibe_memories_session_raw_pending_idx')
      .on(table.sessionId, table.sourceTask, table.createdAt)
      .where(sql`${table.memoryType} = 'raw' AND ${table.isSynthesized} = false`),
    metadataGinIdx: index('vibe_memories_metadata_gin_idx').using('gin', table.metadata),
    metadataKindIdx: index('vibe_memories_metadata_kind_idx').on(sql`(${table.metadata}->>'kind')`),
    guidanceSessionCreatedIdx: index('vibe_memories_guidance_session_created_idx')
      .on(table.sessionId, table.createdAt.desc())
      .where(sql`${table.metadata} @> '{"kind":"guidance"}'::jsonb`),
    embeddingHnswIdx: index('vibe_memories_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
    sessionDedupeUnique: unique('vibe_memories_session_dedupe_key_unique').on(
      table.sessionId,
      table.dedupeKey,
    ),
    memoryTypeCheck: check('vibe_memories_memory_type_check', sql`${table.memoryType} IN ('raw')`),
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
    // Phase 2 additions
    confidence: real('confidence').default(0.5),
    provenance: text('provenance'),
    freshness: timestamp('freshness'),
    scope: text('scope'),
  },
  (table) => ({
    embeddingHnswIdx: index('entities_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
    communityIdIdx: index('entities_community_id_idx').on(table.communityId),
    scopeIdx: index('entities_scope_idx').on(table.scope).where(sql`${table.scope} IS NOT NULL`),
    typeConfidenceIdx: index('entities_type_confidence_idx').on(table.type, table.confidence),
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
    // Phase 2 additions
    confidence: real('confidence').default(0.5),
    recordedAt: timestamp('recorded_at').defaultNow(),
    sourceTask: text('source_task'),
    provenance: text('provenance'),
  },
  (table) => ({
    uniqueRelation: unique('relations_source_target_type_unique').on(
      table.sourceId,
      table.targetId,
      table.relationType,
    ),
    sourceTypeIdx: index('relations_source_type_idx').on(table.sourceId, table.relationType),
    targetTypeIdx: index('relations_target_type_idx').on(table.targetId, table.relationType),
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
    activeDedupeUniqueIdx: uniqueIndex('topic_tasks_active_dedupe_idx')
      .on(table.dedupeKey)
      .where(sql`${table.status} IN ('pending', 'running', 'deferred')`),
    statusNextRunPriorityIdx: index('topic_tasks_status_next_run_priority_idx').on(
      table.status,
      table.nextRunAt,
      table.priority,
      table.createdAt,
    ),
    pendingPriorityCreatedIdx: index('topic_tasks_pending_priority_created_idx')
      .on(table.priority.desc(), table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    deferredNextRunPriorityCreatedIdx: index('topic_tasks_deferred_next_run_priority_created_idx')
      .on(table.nextRunAt, table.priority.desc(), table.createdAt)
      .where(sql`${table.status} = 'deferred' AND ${table.nextRunAt} IS NOT NULL`),
    runningUpdatedAtIdx: index('topic_tasks_running_updated_idx')
      .on(table.updatedAt)
      .where(sql`${table.status} = 'running'`),
    dedupeKeyIdx: index('topic_tasks_dedupe_key_idx').on(table.dedupeKey),
    priorityCheck: check('topic_tasks_priority_check', sql`${table.priority} >= 1`),
  }),
);

export const knowflowKeywordEvaluations = pgTable(
  'knowflow_keyword_evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull(),
    sourceType: text('source_type').notNull(), // experience
    sourceId: text('source_id').notNull(),
    topic: text('topic').notNull(),
    category: text('category').notNull(),
    whyResearch: text('why_research').notNull(),
    searchScore: real('search_score').notNull(),
    termDifficultyScore: real('term_difficulty_score').notNull(),
    uncertaintyScore: real('uncertainty_score').notNull(),
    threshold: real('threshold').default(6.5).notNull(),
    decision: text('decision').notNull(), // enqueued | skipped
    enqueuedTaskId: uuid('enqueued_task_id').references(() => topicTasks.id, {
      onDelete: 'set null',
    }),
    modelAlias: text('model_alias').notNull(), // bonsai | gemma4 | bedrock | openai
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    runDecisionCreatedIdx: index('knowflow_keyword_eval_run_decision_created_idx').on(
      table.runId,
      table.decision,
      table.createdAt,
    ),
    sourceCreatedIdx: index('knowflow_keyword_eval_source_created_idx').on(
      table.sourceType,
      table.sourceId,
      table.createdAt,
    ),
    topicCreatedIdx: index('knowflow_keyword_eval_topic_created_idx').on(
      table.topic,
      table.createdAt,
    ),
    enqueuedTaskIdx: index('knowflow_keyword_eval_enqueued_task_idx')
      .on(table.enqueuedTaskId)
      .where(sql`${table.enqueuedTaskId} IS NOT NULL`),
    uniqueRunSourceTopic: unique('knowflow_keyword_eval_run_source_topic_unique').on(
      table.runId,
      table.sourceType,
      table.sourceId,
      table.topic,
    ),
    sourceTypeCheck: check(
      'knowflow_keyword_eval_source_type_check',
      sql`${table.sourceType} IN ('experience')`,
    ),
    decisionCheck: check(
      'knowflow_keyword_eval_decision_check',
      sql`${table.decision} IN ('enqueued', 'skipped')`,
    ),
    modelAliasCheck: check(
      'knowflow_keyword_eval_model_alias_check',
      sql`${table.modelAlias} IN ('bonsai', 'gemma4', 'bedrock', 'openai')`,
    ),
    searchScoreCheck: check(
      'knowflow_keyword_eval_search_score_check',
      sql`${table.searchScore} >= 0 AND ${table.searchScore} <= 10`,
    ),
    termDifficultyScoreCheck: check(
      'knowflow_keyword_eval_term_difficulty_score_check',
      sql`${table.termDifficultyScore} >= 0 AND ${table.termDifficultyScore} <= 10`,
    ),
    uncertaintyScoreCheck: check(
      'knowflow_keyword_eval_uncertainty_score_check',
      sql`${table.uncertaintyScore} >= 0 AND ${table.uncertaintyScore} <= 10`,
    ),
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
    statusCheck: check(
      'review_cases_status_check',
      sql`${table.status} IN ('running', 'completed')`,
    ),
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
    guidanceIdsGinIdx: index('idx_review_outcomes_guidance_ids_gin').using(
      'gin',
      table.guidanceIds,
    ),
    falsePositiveIdx: index('idx_review_outcomes_fp')
      .on(table.falsePositive)
      .where(sql`${table.falsePositive} = true`),
    uniqueReviewFinding: unique('review_outcomes_case_finding_unique').on(
      table.reviewCaseId,
      table.findingId,
    ),
    outcomeTypeCheck: check(
      'review_outcomes_outcome_type_check',
      sql`${table.outcomeType} IN ('pending', 'adopted', 'ignored', 'dismissed', 'resolved')`,
    ),
  }),
);

export const failureFirewallGoldenPaths = pgTable(
  'failure_firewall_golden_paths',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    pathType: text('path_type').notNull(),
    appliesWhen: jsonb('applies_when').default([]).notNull(),
    requiredSteps: jsonb('required_steps').default([]).notNull(),
    allowedAlternatives: jsonb('allowed_alternatives').default([]).notNull(),
    blockWhenMissing: jsonb('block_when_missing').default([]).notNull(),
    severityWhenMissing: text('severity_when_missing').notNull().default('warning'),
    riskSignals: jsonb('risk_signals').default([]).notNull(),
    languages: jsonb('languages').default([]).notNull(),
    frameworks: jsonb('frameworks').default([]).notNull(),
    tags: jsonb('tags').default([]).notNull(),
    status: text('status').notNull().default('active'),
    sourceEntityId: text('source_entity_id'),
    sourceExperienceId: uuid('source_experience_id'),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    statusIdx: index('failure_firewall_golden_paths_status_idx').on(table.status),
    pathTypeIdx: index('failure_firewall_golden_paths_path_type_idx').on(table.pathType),
    riskSignalsGinIdx: index('failure_firewall_golden_paths_risk_signals_gin_idx').using(
      'gin',
      table.riskSignals,
    ),
    statusCheck: check(
      'failure_firewall_golden_paths_status_check',
      sql`${table.status} IN ('active', 'needs_review', 'deprecated')`,
    ),
    severityCheck: check(
      'failure_firewall_golden_paths_severity_check',
      sql`${table.severityWhenMissing} IN ('error', 'warning', 'info')`,
    ),
  }),
);

export const failureFirewallPatterns = pgTable(
  'failure_firewall_patterns',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    patternType: text('pattern_type').notNull(),
    severity: text('severity').notNull().default('warning'),
    riskSignals: jsonb('risk_signals').default([]).notNull(),
    languages: jsonb('languages').default([]).notNull(),
    frameworks: jsonb('frameworks').default([]).notNull(),
    matchHints: jsonb('match_hints').default([]).notNull(),
    requiredEvidence: jsonb('required_evidence').default([]).notNull(),
    goldenPathId: text('golden_path_id'),
    status: text('status').notNull().default('active'),
    falsePositiveCount: integer('false_positive_count').default(0).notNull(),
    sourceEntityId: text('source_entity_id'),
    sourceExperienceId: uuid('source_experience_id'),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    statusIdx: index('failure_firewall_patterns_status_idx').on(table.status),
    patternTypeIdx: index('failure_firewall_patterns_pattern_type_idx').on(table.patternType),
    goldenPathIdx: index('failure_firewall_patterns_golden_path_idx').on(table.goldenPathId),
    riskSignalsGinIdx: index('failure_firewall_patterns_risk_signals_gin_idx').using(
      'gin',
      table.riskSignals,
    ),
    statusCheck: check(
      'failure_firewall_patterns_status_check',
      sql`${table.status} IN ('active', 'needs_review', 'deprecated')`,
    ),
    severityCheck: check(
      'failure_firewall_patterns_severity_check',
      sql`${table.severity} IN ('error', 'warning', 'info')`,
    ),
    falsePositiveCountCheck: check(
      'failure_firewall_patterns_false_positive_count_check',
      sql`${table.falsePositiveCount} >= 0`,
    ),
  }),
);

export const hookExecutions = pgTable(
  'hook_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: text('event_id').notNull(),
    ruleId: text('rule_id').notNull(),
    traceId: text('trace_id').notNull(),
    status: text('status').notNull(),
    errorMessage: text('error_message'),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniqueEventRule: unique('hook_executions_event_rule_unique').on(table.eventId, table.ruleId),
    traceStatusIdx: index('hook_executions_trace_status_idx').on(table.traceId, table.status),
    createdAtIdx: index('hook_executions_created_at_idx').on(table.createdAt),
    statusCheck: check(
      'hook_executions_status_check',
      sql`${table.status} IN ('started', 'succeeded', 'failed', 'blocked', 'skipped')`,
    ),
  }),
);

export const hookCandidates = pgTable(
  'hook_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    traceId: text('trace_id').notNull(),
    sourceEvent: text('source_event').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    severity: text('severity'),
    payload: jsonb('payload').default({}).notNull(),
    score: real('score'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    activeDedupeUnique: uniqueIndex('hook_candidates_active_dedupe_unique')
      .on(table.kind, table.dedupeKey)
      .where(sql`${table.status} IN ('pending', 'scored', 'deduplicated')`),
    traceStatusIdx: index('hook_candidates_trace_status_idx').on(table.traceId, table.status),
    sourceEventIdx: index('hook_candidates_source_event_idx').on(table.sourceEvent),
    kindCheck: check('hook_candidates_kind_check', sql`${table.kind} IN ('lesson')`),
    statusCheck: check(
      'hook_candidates_status_check',
      sql`${table.status} IN ('pending', 'scored', 'deduplicated', 'promoted', 'rejected')`,
    ),
    severityCheck: check(
      'hook_candidates_severity_check',
      sql`${table.severity} IS NULL OR ${table.severity} IN ('low', 'medium', 'high')`,
    ),
  }),
);
