import { randomUUID } from 'node:crypto';
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import {
  knowledgeClaims,
  knowledgeRelations,
  knowledgeSources,
  knowledgeTopics,
} from '../../../db/schema.js';
import { canonicalizeTopic, uniqueNormalizedStrings } from './canonicalize';
import { fingerprintText, shouldMergeClaim } from './similarity';
import {
  type Claim,
  ClaimSchema,
  type Knowledge,
  KnowledgeSchema,
  type KnowledgeUpsertInput,
  KnowledgeUpsertInputSchema,
  type Relation,
  RelationSchema,
  type SourceRef,
  SourceRefSchema,
} from './types';

export type KnowledgeRepositoryOptions = {
  claimSimilarityThreshold?: number;
  claimEmbeddingSimilarityThreshold?: number;
};

export type MergeKnowledgeResult = {
  knowledge: Knowledge;
  changed: boolean;
};

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type KnowledgeTopicRow = typeof knowledgeTopics.$inferSelect;
type KnowledgeClaimRow = typeof knowledgeClaims.$inferSelect;
type KnowledgeRelationRow = typeof knowledgeRelations.$inferSelect;
type KnowledgeSourceRow = typeof knowledgeSources.$inferSelect;

const parseStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
};

const parseSourceIds = (value: unknown): string[] => {
  return parseStringArray(value).filter((id) => id.length > 0);
};

const parseEmbedding = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter(
    (item): item is number => typeof item === 'number' && Number.isFinite(item),
  );
  return out.length > 0 ? out : undefined;
};

const unionStrings = (...inputs: string[][]): string[] => {
  const set = new Set<string>();
  for (const list of inputs) {
    for (const item of list) {
      if (item && item.trim().length > 0) {
        set.add(item);
      }
    }
  }
  return [...set];
};

const toEpochMs = (value: Date): number => value.getTime();

export class PgKnowledgeRepository {
  private readonly claimSimilarityThreshold: number;
  private readonly claimEmbeddingSimilarityThreshold: number;
  private readonly database: typeof db;

  constructor(options: KnowledgeRepositoryOptions = {}, database: typeof db = db) {
    this.claimSimilarityThreshold = options.claimSimilarityThreshold ?? 0.85;
    this.claimEmbeddingSimilarityThreshold = options.claimEmbeddingSimilarityThreshold ?? 0.92;
    this.database = database;
  }

  async getByTopic(topic: string): Promise<Knowledge | null> {
    const canonicalTopic = canonicalizeTopic(topic);

    return this.database.transaction(async (tx) => {
      const topicRows = await tx
        .select()
        .from(knowledgeTopics)
        .where(eq(knowledgeTopics.canonicalTopic, canonicalTopic))
        .limit(1);

      const topicRow = topicRows[0];
      if (!topicRow) {
        return null;
      }

      return this.buildKnowledge(tx, topicRow);
    });
  }

  async searchTopics(query: string, limit = 10): Promise<Knowledge[]> {
    const keyword = `%${canonicalizeTopic(query)}%`;

    return this.database.transaction(async (tx) => {
      const result = await tx
        .select()
        .from(knowledgeTopics)
        .where(
          or(
            ilike(knowledgeTopics.canonicalTopic, keyword),
            sql`${knowledgeTopics.aliases}::text ILIKE ${keyword}`,
          ),
        )
        .orderBy(knowledgeTopics.updatedAt)
        .limit(Math.max(1, Math.trunc(limit)));

      const out: Knowledge[] = [];
      for (const row of result) {
        out.push(await this.buildKnowledge(tx, row));
      }
      return out;
    });
  }

  async merge(input: KnowledgeUpsertInput): Promise<MergeKnowledgeResult> {
    const parsed = KnowledgeUpsertInputSchema.parse(input);
    const canonicalTopic = canonicalizeTopic(parsed.topic);

    return this.database.transaction(async (tx) => {
      const existingTopics = await tx
        .select()
        .from(knowledgeTopics)
        .where(eq(knowledgeTopics.canonicalTopic, canonicalTopic))
        .limit(1)
        .for('update');

      let topicRow = existingTopics[0];

      if (!topicRow) {
        const inserted = await tx
          .insert(knowledgeTopics)
          .values({
            canonicalTopic,
            aliases: uniqueNormalizedStrings([parsed.topic]),
            confidence: 0,
            coverage: 0,
            version: 1,
          })
          .returning();
        topicRow = inserted[0];
      }

      if (!topicRow) {
        throw new Error('Failed to initialize topic row');
      }

      const existing = await this.buildKnowledge(tx, topicRow);
      const merged = this.mergeKnowledge(existing, parsed);

      const changed =
        JSON.stringify(existing.claims) !== JSON.stringify(merged.claims) ||
        JSON.stringify(existing.relations) !== JSON.stringify(merged.relations) ||
        JSON.stringify(existing.sources) !== JSON.stringify(merged.sources) ||
        JSON.stringify(existing.aliases) !== JSON.stringify(merged.aliases);

      if (changed) {
        await this.persistKnowledge(tx, merged);
      }

      const latestTopicRows = await tx
        .select()
        .from(knowledgeTopics)
        .where(eq(knowledgeTopics.id, topicRow.id));
      const latestTopic = latestTopicRows[0];
      if (!latestTopic) {
        throw new Error('Failed to load merged knowledge');
      }
      const latestKnowledge = await this.buildKnowledge(tx, latestTopic);

      return {
        knowledge: latestKnowledge,
        changed,
      };
    });
  }

  private async buildKnowledge(tx: DbTransaction, topic: KnowledgeTopicRow): Promise<Knowledge> {
    const [claimsRows, relationsRows, sourcesRows] = await Promise.all([
      tx
        .select()
        .from(knowledgeClaims)
        .where(eq(knowledgeClaims.topicId, topic.id))
        .orderBy(asc(knowledgeClaims.createdAt)),
      tx
        .select()
        .from(knowledgeRelations)
        .where(eq(knowledgeRelations.topicId, topic.id))
        .orderBy(asc(knowledgeRelations.createdAt)),
      tx
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.topicId, topic.id))
        .orderBy(asc(knowledgeSources.createdAt)),
    ]);

    const claims = claimsRows.map((row: KnowledgeClaimRow) =>
      ClaimSchema.parse({
        id: row.id,
        text: row.text,
        confidence: row.confidence,
        sourceIds: parseSourceIds(row.sourceIds),
        embedding: parseEmbedding(row.embedding),
      }),
    );

    const relations = relationsRows.map((row: KnowledgeRelationRow) =>
      RelationSchema.parse({
        type: row.relationType,
        targetTopic: row.targetTopic,
        confidence: row.confidence,
      }),
    );

    const sources = sourcesRows.map((row: KnowledgeSourceRow) =>
      SourceRefSchema.parse({
        id: row.sourceId,
        url: row.url,
        title: row.title ?? undefined,
        domain: row.domain ?? undefined,
        fetchedAt: row.fetchedAt,
      }),
    );

    return KnowledgeSchema.parse({
      id: topic.id,
      canonicalTopic: topic.canonicalTopic,
      aliases: parseStringArray(topic.aliases),
      claims,
      relations,
      sources,
      confidence: topic.confidence,
      coverage: topic.coverage,
      version: topic.version,
      createdAt: toEpochMs(topic.createdAt),
      updatedAt: toEpochMs(topic.updatedAt),
    });
  }

  private mergeKnowledge(existing: Knowledge, incoming: KnowledgeUpsertInput): Knowledge {
    const aliases = uniqueNormalizedStrings([
      existing.canonicalTopic,
      ...existing.aliases,
      incoming.topic,
      ...incoming.aliases,
    ]);

    const mergedSources = [...existing.sources];
    for (const source of incoming.sources) {
      const index = mergedSources.findIndex((item) => item.id === source.id);
      if (index < 0) {
        mergedSources.push(source);
        continue;
      }

      const prev = mergedSources[index];
      if (!prev) continue;

      mergedSources[index] = {
        ...prev,
        url: source.url || prev.url,
        title: source.title ?? prev.title,
        domain: source.domain ?? prev.domain,
        fetchedAt: Math.max(prev.fetchedAt, source.fetchedAt),
      };
    }

    const mergedClaims = [...existing.claims];
    for (const claim of incoming.claims) {
      const exactIndex = mergedClaims.findIndex(
        (item) => fingerprintText(item.text) === fingerprintText(claim.text),
      );

      const similarityIndex =
        exactIndex >= 0
          ? exactIndex
          : mergedClaims.findIndex((item) =>
              shouldMergeClaim(item, claim, {
                textThreshold: this.claimSimilarityThreshold,
                embeddingThreshold: this.claimEmbeddingSimilarityThreshold,
              }),
            );

      if (similarityIndex < 0) {
        mergedClaims.push({
          ...claim,
          id: claim.id || randomUUID(),
        });
        continue;
      }

      const current = mergedClaims[similarityIndex];
      if (!current) continue;

      const sourceIds = unionStrings(current.sourceIds, claim.sourceIds);
      const text = claim.text.length > current.text.length ? claim.text : current.text;
      mergedClaims[similarityIndex] = {
        ...current,
        text,
        confidence: Math.max(current.confidence, claim.confidence),
        sourceIds,
        embedding: claim.embedding ?? current.embedding,
      };
    }

    const mergedRelations = [...existing.relations];
    for (const relation of incoming.relations) {
      const targetTopic = canonicalizeTopic(relation.targetTopic);
      const fingerprint = `${relation.type}:${targetTopic}`;
      const existingIndex = mergedRelations.findIndex(
        (item) => `${item.type}:${canonicalizeTopic(item.targetTopic)}` === fingerprint,
      );

      if (existingIndex < 0) {
        mergedRelations.push({
          ...relation,
          targetTopic,
        });
        continue;
      }

      const current = mergedRelations[existingIndex];
      if (!current) continue;

      mergedRelations[existingIndex] = {
        ...current,
        targetTopic,
        confidence: Math.max(current.confidence, relation.confidence),
      };
    }

    const confidence =
      mergedClaims.length > 0
        ? mergedClaims.reduce((sum, claim) => sum + claim.confidence, 0) / mergedClaims.length
        : 0;

    const coverage = Math.min(1, (mergedClaims.length + mergedRelations.length) / 10);

    return KnowledgeSchema.parse({
      ...existing,
      aliases,
      claims: mergedClaims,
      relations: mergedRelations,
      sources: mergedSources,
      confidence,
      coverage,
      version: existing.version + 1,
      updatedAt: Date.now(),
    });
  }

  private async persistKnowledge(tx: DbTransaction, knowledge: Knowledge): Promise<void> {
    await tx
      .update(knowledgeTopics)
      .set({
        aliases: knowledge.aliases,
        confidence: knowledge.confidence,
        coverage: knowledge.coverage,
        version: knowledge.version,
        updatedAt: new Date(),
      })
      .where(eq(knowledgeTopics.id, knowledge.id));

    await tx.delete(knowledgeClaims).where(eq(knowledgeClaims.topicId, knowledge.id));
    await tx.delete(knowledgeRelations).where(eq(knowledgeRelations.topicId, knowledge.id));
    await tx.delete(knowledgeSources).where(eq(knowledgeSources.topicId, knowledge.id));

    if (knowledge.claims.length > 0) {
      await tx.insert(knowledgeClaims).values(
        knowledge.claims.map((claim) => ({
          id: claim.id,
          topicId: knowledge.id,
          text: claim.text,
          confidence: claim.confidence,
          sourceIds: claim.sourceIds,
          embedding: claim.embedding ?? null,
          fingerprint: fingerprintText(claim.text),
        })),
      );
    }

    if (knowledge.relations.length > 0) {
      await tx.insert(knowledgeRelations).values(
        knowledge.relations.map((relation) => {
          const targetTopic = canonicalizeTopic(relation.targetTopic);
          return {
            topicId: knowledge.id,
            relationType: relation.type,
            targetTopic,
            confidence: relation.confidence,
            fingerprint: `${relation.type}:${targetTopic}`,
          };
        }),
      );
    }

    if (knowledge.sources.length > 0) {
      await tx.insert(knowledgeSources).values(
        knowledge.sources.map((source) => ({
          topicId: knowledge.id,
          sourceId: source.id,
          url: source.url,
          title: source.title ?? null,
          domain: source.domain ?? null,
          fetchedAt: source.fetchedAt,
        })),
      );
    }
  }
}
