import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { vibeMemories } from '../../db/schema.js';
import type { GuidanceScope, GuidanceType } from '../../domain/schemas.js';
import { sha256 } from '../../utils/crypto.js';
import { generateEntityId } from '../../utils/entityId.js';
import { saveEntities, saveRelations } from '../graph.js';
import { generateEmbedding } from '../memory.js';

type SaveGuidanceDependencies = {
  generateEmbedding: (text: string) => Promise<number[]>;
  now: () => Date;
  database: typeof db;
};

/**
 * Guidance を entities / relations に保存する（Phase 4-3）。
 *
 * guidanceType → entity type マッピング:
 *   rule  → constraint
 *   skill → task
 *   goal  → goal
 */
export async function saveGuidance(
  input: {
    title: string;
    content: string;
    guidanceType: GuidanceType;
    scope: GuidanceScope;
    priority: number;
    tags?: string[];
    applicability?: {
      signals?: string[];
      fileTypes?: string[];
      languages?: string[];
      frameworks?: string[];
      excludedFrameworks?: string[];
      projects?: string[];
      domains?: string[];
      environments?: string[];
      repos?: string[];
    };
    archiveKey?: string;
    sessionId?: string;
  },
  deps: Partial<SaveGuidanceDependencies> = {},
): Promise<{ id: string; archiveKey: string }> {
  const resolvedDeps = {
    generateEmbedding: deps.generateEmbedding ?? generateEmbedding,
    now: deps.now ?? (() => new Date()),
    database: deps.database ?? db,
  };

  const archiveKey = input.archiveKey ?? `manual:${sha256(input.title.toLowerCase())}`;

  // guidanceType → entity type
  const typeMap: Record<GuidanceType, string> = {
    rule: 'constraint',
    skill: 'task',
    goal: 'goal',
  };
  const entityType = typeMap[input.guidanceType];
  const entityId = generateEntityId(entityType, input.title);

  const tags = input.tags ?? [];
  const embedding = await resolvedDeps.generateEmbedding(input.content);

  // vibe_memories に保存（UI用）
  const dedupeKey = `guidance:${sha256(`${archiveKey}:${input.title}:${input.content}`)}`;
  const [memory] = await resolvedDeps.database
    .insert(vibeMemories)
    .values({
      sessionId: input.sessionId ?? config.guidance.sessionId,
      content: input.content,
      embedding,
      dedupeKey,
      metadata: {
        kind: 'guidance',
        guidanceType: input.guidanceType,
        scope: input.scope,
        priority: input.priority,
        title: input.title,
        tags,
        archiveKey,
        updatedAt: resolvedDeps.now().toISOString(),
        source: 'manual',
      },
    })
    .onConflictDoUpdate({
      target: [vibeMemories.sessionId, vibeMemories.dedupeKey],
      set: {
        content: input.content,
        embedding: embedding,
        metadata: {
          kind: 'guidance',
          guidanceType: input.guidanceType,
          scope: input.scope,
          priority: input.priority,
          title: input.title,
          tags,
          archiveKey,
          updatedAt: resolvedDeps.now().toISOString(),
          source: 'manual',
        },
      },
    })
    .returning();

  // entities に保存
  await saveEntities(
    [
      {
        id: entityId,
        type: entityType,
        name: input.title,
        description: input.content,
        metadata: {
          tags,
          archiveKey,
          priority: input.priority,
          applicability: input.applicability,
          importedAt: resolvedDeps.now().toISOString(),
        },
        confidence: 0.5,
        scope: input.scope,
        provenance: 'manual',
      },
    ],
    resolvedDeps.database,
    async () => embedding,
  );

  // applicability がある場合: context エンティティ + when 関係
  const contextConditions: string[] = [];
  if (input.applicability?.signals) contextConditions.push(...input.applicability.signals);
  if (input.applicability?.languages) contextConditions.push(...input.applicability.languages);
  if (input.applicability?.frameworks) contextConditions.push(...input.applicability.frameworks);
  if (input.applicability?.projects) contextConditions.push(...input.applicability.projects);
  if (input.applicability?.domains) contextConditions.push(...input.applicability.domains);
  if (input.applicability?.environments)
    contextConditions.push(...input.applicability.environments);
  if (input.applicability?.repos) contextConditions.push(...input.applicability.repos);

  for (const condition of new Set(contextConditions)) {
    const ctxId = generateEntityId('context', condition);
    const ctxEmbedding = await resolvedDeps.generateEmbedding(condition);
    await saveEntities(
      [
        {
          id: ctxId,
          type: 'context',
          name: condition,
          description: condition,
          confidence: 0.5,
          provenance: 'manual',
        },
      ],
      resolvedDeps.database,
      async () => ctxEmbedding,
    );
    await saveRelations(
      [{ sourceId: ctxId, targetId: entityId, relationType: 'when', weight: 0.8 }],
      resolvedDeps.database,
    );
  }

  return { id: entityId, archiveKey };
}
