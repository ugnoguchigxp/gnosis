import { z } from 'zod';

/**
 * Guidance & Skills
 */
export const GuidanceTypeSchema = z.enum(['rule', 'skill']);
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
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type EntityInput = z.infer<typeof EntityInputSchema>;

export const RelationInputSchema = z.object({
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  relationType: z.string().min(1),
  weight: z.union([z.number(), z.string()]).optional(),
});
export type RelationInput = z.infer<typeof RelationInputSchema>;

/**
 * Memory
 */
export const VibeMemoryInputSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
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
  entities: z.array(
    z.object({
      id: z.string().min(1),
      type: z.string().min(1),
      name: z.string().min(1),
      description: z.string().min(1),
    }),
  ),
  relations: z.array(
    z.object({
      sourceId: z.string().min(1),
      targetId: z.string().min(1),
      relationType: z.string().min(1),
      weight: z.number().optional(),
    }),
  ),
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
