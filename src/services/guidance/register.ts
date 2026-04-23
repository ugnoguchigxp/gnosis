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
      excludes?: {
        signals?: string[];
        fileTypes?: string[];
        languages?: string[];
        frameworks?: string[];
        projects?: string[];
        domains?: string[];
        environments?: string[];
        repos?: string[];
        paths?: string[];
      };
    };
    validationCriteria?: string[];
    dependsOn?: string[];
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
        validationCriteria: input.validationCriteria,
        dependsOn: input.dependsOn,
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
          validationCriteria: input.validationCriteria,
          dependsOn: input.dependsOn,
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
          validationCriteria: input.validationCriteria,
          dependsOn: input.dependsOn,
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

  // excludes がある場合: context エンティティ + when_not 関係
  const excludeConditions: string[] = [];
  if (input.applicability?.excludes?.signals)
    excludeConditions.push(...input.applicability.excludes.signals);
  if (input.applicability?.excludes?.languages)
    excludeConditions.push(...input.applicability.excludes.languages);
  if (input.applicability?.excludes?.frameworks)
    excludeConditions.push(...input.applicability.excludes.frameworks);
  if (input.applicability?.excludes?.projects)
    excludeConditions.push(...input.applicability.excludes.projects);
  if (input.applicability?.excludes?.domains)
    excludeConditions.push(...input.applicability.excludes.domains);
  if (input.applicability?.excludes?.environments)
    excludeConditions.push(...input.applicability.excludes.environments);
  if (input.applicability?.excludes?.repos)
    excludeConditions.push(...input.applicability.excludes.repos);
  if (input.applicability?.excludes?.paths)
    excludeConditions.push(...input.applicability.excludes.paths);

  for (const condition of new Set(excludeConditions)) {
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
      [{ sourceId: ctxId, targetId: entityId, relationType: 'when_not', weight: 1.0 }],
      resolvedDeps.database,
    );
  }

  // dependsOn がある場合: depends_on 関係
  if (input.dependsOn?.length) {
    for (const dependency of input.dependsOn) {
      // 依存先が ID かタイトルか不明なため、とりあえず title から ID を生成して張る
      // (本来は検索して正確な ID を取得すべきだが、まずは簡易実装)
      // guidanceType は不明だが、一般的は task (skill) か constraint (rule)
      // ここでは dependency を名前として扱い、IDを推測する。
      // もし正確な依存関係を張るなら、ここで DB 検索が必要。
      const depId = generateEntityId('task', dependency); // 仮で task とする
      await saveRelations(
        [{ sourceId: entityId, targetId: depId, relationType: 'depends_on', weight: 1.0 }],
        resolvedDeps.database,
      );
    }
  }

  return { id: entityId, archiveKey };
}
