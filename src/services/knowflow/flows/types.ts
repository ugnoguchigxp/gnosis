import type { Relation, SourceRef } from '../knowledge/types';
import type { EvidenceClaim, EvidenceSource } from '../verifier';

export type FlowEvidence = {
  claims: EvidenceClaim[];
  sources: EvidenceSource[];
  relations?: Relation[];
  normalizedSources?: SourceRef[];
  queryCountUsed?: number;
};
