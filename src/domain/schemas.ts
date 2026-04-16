import { z } from 'zod';

// ---------------------------------------------------------------------------
// 制御語彙: エンティティ type の列挙
// ---------------------------------------------------------------------------
export const ENTITY_TYPES = [
  'task',
  'goal',
  'constraint',
  'context',
  'project',
  'library',
  'service',
  'tool',
  'concept',
  'person',
  'pattern',
  'config',
  'episode',
] as const;

export const EntityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof EntityTypeSchema>;

// ---------------------------------------------------------------------------
// 制御語彙: リレーション relationType の列挙
// ---------------------------------------------------------------------------
export const RELATION_TYPES = [
  'has_step',
  'precondition',
  'follows',
  'when',
  'prohibits',
  'learned_from',
  'alternative_to',
  'depends_on',
  'uses',
  'implements',
  'extends',
  'part_of',
  'caused_by',
  'resolved_by',
] as const;

export const RelationTypeSchema = z.enum(RELATION_TYPES);
export type RelationType = z.infer<typeof RelationTypeSchema>;

// ---------------------------------------------------------------------------
// LLM ドラフトスキーマ: id なし、制御語彙の type を使用
// ---------------------------------------------------------------------------

/**
 * LLM が出力するエンティティのドラフト形式。
 * id は含まない — 保存層で generateEntityId(type, name) により解決する。
 */
export const LlmEntityDraftSchema = z.object({
  type: EntityTypeSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});
export type LlmEntityDraft = z.infer<typeof LlmEntityDraftSchema>;

/**
 * LLM が出力するリレーションのドラフト形式。
 * sourceId / targetId ではなく type + name で表現する。
 * 保存層で generateEntityId を使って ID を解決する。
 */
export const LlmRelationDraftSchema = z.object({
  sourceType: z.string().min(1),
  sourceName: z.string().min(1),
  targetType: z.string().min(1),
  targetName: z.string().min(1),
  relationType: RelationTypeSchema,
  weight: z.number().min(0).max(1).optional(),
});
export type LlmRelationDraft = z.infer<typeof LlmRelationDraftSchema>;

/**
 * Guidance & Skills
 */
export const GuidanceTypeSchema = z.enum(['rule', 'skill', 'goal']);
export type GuidanceType = z.infer<typeof GuidanceTypeSchema>;

export const GuidanceScopeSchema = z.enum(['always', 'on_demand']);
export type GuidanceScope = z.infer<typeof GuidanceScopeSchema>;

export const GuidanceManifestSchema = z
  .object({
    packId: z.string().min(1).optional(),
    sourceRepo: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
    defaultScope: GuidanceScopeSchema.optional(),
    defaultGuidanceType: GuidanceTypeSchema.optional(),
    defaultPriority: z.number().finite().optional(),
    project: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .passthrough();
export type GuidanceManifest = z.infer<typeof GuidanceManifestSchema>;

export const GuidanceChunkSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  guidanceType: GuidanceTypeSchema,
  scope: GuidanceScopeSchema,
  priority: z.number().int(),
  tags: z.array(z.string().min(1)),
  entryPath: z.string().min(1),
  project: z.string().optional(),
});
export type GuidanceChunk = z.infer<typeof GuidanceChunkSchema>;

/**
 * Graph Knowledge
 */
export const EntityInputSchema = z.object({
  id: z.string().min(1).optional(), // absent 時は保存層で generateEntityId(type, name) により自動生成
  type: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  // Phase 2 additions
  confidence: z.number().min(0).max(1).optional(),
  provenance: z.string().optional(),
  scope: z.string().optional(),
  freshness: z.date().optional(),
});
export type EntityInput = z.infer<typeof EntityInputSchema>;

/** ID ベース（既存形式、尚前互換用） */
const RelationIdInputSchema = z.object({
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  relationType: z.string().min(1),
  weight: z.union([z.number(), z.string()]).optional(),
});

/** name ベース（LLM ドラフト形式、保存層で ID を解決） */
const RelationNameInputSchema = z.object({
  sourceType: z.string().min(1),
  sourceName: z.string().min(1),
  targetType: z.string().min(1),
  targetName: z.string().min(1),
  relationType: z.string().min(1),
  weight: z.union([z.number(), z.string()]).optional(),
});

export const RelationInputSchema = z.union([RelationIdInputSchema, RelationNameInputSchema]);
export type RelationInput = z.infer<typeof RelationInputSchema>;

/**
 * Memory
 */
export const VibeMemoryInputSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
  // Phase 2 additions
  memoryType: z.enum(['raw', 'episode']).optional().default('raw'),
  episodeAt: z.date().optional(),
  sourceTask: z.string().optional(),
  importance: z.number().min(0).max(1).optional().default(0.5),
  compressed: z.boolean().optional().default(false),
});
export type VibeMemoryInput = z.infer<typeof VibeMemoryInputSchema>;

/**
 * LLM Outputs
 */
export const ExtractedEntitySchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  description: z.string().min(1),
});
export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;

export const MergedEntityResultSchema = z.object({
  shouldMerge: z.boolean(),
  merged: ExtractedEntitySchema.optional(),
});
export type MergedEntityResult = z.infer<typeof MergedEntityResultSchema>;

export const DistilledKnowledgeSchema = z.object({
  memories: z.array(z.string()),
  entities: z.array(LlmEntityDraftSchema),
  relations: z.array(LlmRelationDraftSchema),
});
export type DistilledKnowledge = z.infer<typeof DistilledKnowledgeSchema>;

/**
 * Knowledge & Community
 */
export const KnowledgeClaimResultSchema = z.object({
  topic: z.string(),
  text: z.string(),
  confidence: z.number(),
  score: z.number(),
});
export type KnowledgeClaimResult = z.infer<typeof KnowledgeClaimResultSchema>;

export const DetailedKnowledgeSchema = z.object({
  topic: z.string(),
  aliases: z.array(z.string()),
  confidence: z.number(),
  coverage: z.number(),
  claims: z.array(
    z.object({
      text: z.string(),
      confidence: z.number(),
      sourceIds: z.array(z.string()),
    }),
  ),
  relations: z.array(
    z.object({
      type: z.string(),
      targetTopic: z.string(),
      confidence: z.number(),
    }),
  ),
  sources: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullable(),
      domain: z.string().nullable(),
    }),
  ),
});
export type DetailedKnowledge = z.infer<typeof DetailedKnowledgeSchema>;

export const CommunityRebuildResultSchema = z.object({
  message: z.string(),
  count: z.number().optional(),
});
export type CommunityRebuildResult = z.infer<typeof CommunityRebuildResultSchema>;
