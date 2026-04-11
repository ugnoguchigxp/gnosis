import { z } from 'zod';

export const RelationTypeSchema = z.enum(['related_to', 'compares_with', 'depends_on', 'used_for']);

export const SourceRefSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().url(),
    title: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    fetchedAt: z.number().int().nonnegative(),
  })
  .strict();

export const ClaimSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    confidence: z.number().min(0).max(1),
    sourceIds: z.array(z.string().min(1)).default([]),
    embedding: z.array(z.number()).optional(),
  })
  .strict();

export const ClaimInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    text: z.string().min(1),
    confidence: z.number().min(0).max(1),
    sourceIds: z.array(z.string().min(1)).default([]),
    embedding: z.array(z.number()).optional(),
  })
  .strict();

export const RelationSchema = z
  .object({
    type: RelationTypeSchema,
    targetTopic: z.string().min(1),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const KnowledgeSchema = z
  .object({
    id: z.string().min(1),
    canonicalTopic: z.string().min(1),
    aliases: z.array(z.string().min(1)).default([]),
    claims: z.array(ClaimSchema).default([]),
    relations: z.array(RelationSchema).default([]),
    sources: z.array(SourceRefSchema).default([]),
    confidence: z.number().min(0).max(1),
    coverage: z.number().min(0).max(1),
    version: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const KnowledgeUpsertInputSchema = z
  .object({
    topic: z.string().min(1),
    aliases: z.array(z.string().min(1)).default([]),
    claims: z.array(ClaimInputSchema).default([]),
    relations: z.array(RelationSchema).default([]),
    sources: z.array(SourceRefSchema).default([]),
  })
  .strict();

export type SourceRef = z.infer<typeof SourceRefSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type ClaimInput = z.infer<typeof ClaimInputSchema>;
export type Relation = z.infer<typeof RelationSchema>;
export type Knowledge = z.infer<typeof KnowledgeSchema>;
export type KnowledgeUpsertInput = z.infer<typeof KnowledgeUpsertInputSchema>;
