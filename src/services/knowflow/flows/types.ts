import type { Relation, SourceRef } from '../knowledge/types';
import type { EvidenceClaim, EvidenceSource } from '../verifier';

export type FlowEvidence = {
  claims: EvidenceClaim[];
  sources: EvidenceSource[];
  relations?: Relation[];
  normalizedSources?: SourceRef[];
  queryCountUsed?: number;
  searchQueries?: string[];
  usefulPageFound?: boolean;
  usefulPageCount?: number;
  requiredUsefulPageCount?: number;
  fetchedPageCount?: number;
  diagnostics?: {
    outcome?:
      | 'ok'
      | 'llm_degraded'
      | 'search_failed'
      | 'no_search_results'
      | 'fetch_failed'
      | 'no_useful_pages'
      | 'no_evidence_collected';
    messages?: string[];
  };
  emergentTopics?: Array<{
    topic: string;
    whyResearch: string;
    relationType?: string;
    score: number;
    noveltyScore?: number;
    specificityScore?: number;
    actionabilityScore?: number;
    communityFitScore?: number;
    sourceUrl?: string;
  }>;
};
