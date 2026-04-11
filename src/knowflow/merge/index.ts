import { canonicalizeTopic, uniqueNormalizedStrings } from '../knowledge/canonicalize';
import { fingerprintText } from '../knowledge/similarity';
import type {
  ClaimInput,
  Knowledge,
  KnowledgeUpsertInput,
  Relation,
  SourceRef,
} from '../knowledge/types';

export type VerifiedMergeInput = {
  topic: string;
  aliases?: string[];
  acceptedClaims: ClaimInput[];
  relations?: Relation[];
  sources?: SourceRef[];
};

export type MergeRepository = {
  merge: (input: KnowledgeUpsertInput) => Promise<{ knowledge: Knowledge; changed: boolean }>;
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const dedupeClaims = (claims: ClaimInput[]): ClaimInput[] => {
  const map = new Map<
    string,
    {
      claim: ClaimInput;
      score: number;
    }
  >();

  for (const claim of claims) {
    const key = fingerprintText(claim.text);
    const score = clamp01(claim.confidence);
    const sourceIds = [...new Set((claim.sourceIds ?? []).filter(Boolean))];
    const normalized: ClaimInput = {
      id: claim.id,
      text: claim.text.trim(),
      confidence: score,
      sourceIds,
      embedding: claim.embedding,
    };

    const existing = map.get(key);
    if (!existing) {
      map.set(key, { claim: normalized, score });
      continue;
    }

    const merged: ClaimInput = {
      id: existing.claim.id ?? normalized.id,
      text:
        normalized.text.length > existing.claim.text.length ? normalized.text : existing.claim.text,
      confidence: Math.max(existing.claim.confidence, normalized.confidence),
      sourceIds: [...new Set([...(existing.claim.sourceIds ?? []), ...sourceIds])],
      embedding: normalized.embedding ?? existing.claim.embedding,
    };
    map.set(key, { claim: merged, score: Math.max(existing.score, score) });
  }

  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value.claim);
};

const dedupeRelations = (relations: Relation[]): Relation[] => {
  const map = new Map<string, Relation>();
  for (const relation of relations) {
    const targetTopic = canonicalizeTopic(relation.targetTopic);
    const key = `${relation.type}:${targetTopic}`;
    const normalized: Relation = {
      type: relation.type,
      targetTopic,
      confidence: clamp01(relation.confidence),
    };
    const existing = map.get(key);
    if (!existing || normalized.confidence > existing.confidence) {
      map.set(key, normalized);
    }
  }

  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, relation]) => relation);
};

const dedupeSources = (sources: SourceRef[]): SourceRef[] => {
  const map = new Map<string, SourceRef>();
  for (const source of sources) {
    const existing = map.get(source.id);
    if (!existing) {
      map.set(source.id, source);
      continue;
    }

    map.set(source.id, {
      ...existing,
      url: source.url || existing.url,
      title: source.title ?? existing.title,
      domain: source.domain ?? existing.domain,
      fetchedAt: Math.max(existing.fetchedAt, source.fetchedAt),
    });
  }

  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, source]) => source);
};

export const normalizeMergeInput = (input: VerifiedMergeInput): KnowledgeUpsertInput => {
  return {
    topic: input.topic.trim(),
    aliases: uniqueNormalizedStrings([input.topic, ...(input.aliases ?? [])]),
    claims: dedupeClaims(input.acceptedClaims),
    relations: dedupeRelations(input.relations ?? []),
    sources: dedupeSources(input.sources ?? []),
  };
};

export const mergeVerifiedKnowledge = async (
  repository: MergeRepository,
  input: VerifiedMergeInput,
): Promise<{ knowledge: Knowledge; changed: boolean }> => {
  const normalized = normalizeMergeInput(input);
  return repository.merge(normalized);
};
