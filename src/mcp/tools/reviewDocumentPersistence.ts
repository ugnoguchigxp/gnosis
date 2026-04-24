import { randomUUID } from 'node:crypto';
import type { Finding, FindingCategory, ReviewOutput } from '../../services/review/types.js';
import type { ReviewDocumentFinding } from '../../services/reviewAgent/documentReviewer.js';
import { sha256 } from '../../utils/crypto.js';

function mapCategory(category: string): FindingCategory {
  switch (category) {
    case 'ambiguity':
      return 'design';
    case 'missing_requirement':
      return 'validation';
    case 'operability':
      return 'maintainability';
    case 'maintainability':
      return 'maintainability';
    case 'security':
      return 'security';
    case 'testability':
      return 'test';
    case 'inconsistency':
      return 'design';
    case 'risk':
      return 'validation';
    default:
      return 'maintainability';
  }
}

export function toReviewFindingFromDocument(
  reviewId: string,
  finding: ReviewDocumentFinding,
  documentPath: string | undefined,
  reviewType: 'implementation_plan' | 'spec_document',
): Finding {
  const line = finding.location?.line && finding.location.line > 0 ? finding.location.line : 1;
  const fingerprint = sha256(
    `${reviewId}:${finding.title}:${finding.rationale}:${documentPath ?? 'inline'}:${line}`,
  );

  return {
    id: randomUUID(),
    title: finding.title,
    severity: finding.severity,
    confidence: finding.confidence,
    file_path: documentPath?.trim() || `inline:${reviewType}`,
    line_new: line,
    category: mapCategory(finding.category),
    rationale: finding.rationale,
    suggested_fix: finding.suggestedFix,
    evidence: finding.evidence ?? finding.rationale,
    knowledge_refs: finding.knowledgeRefs,
    fingerprint,
    needsHumanConfirmation: finding.severity !== 'error',
    source: 'local_llm',
    metadata: {
      reviewType,
    },
  };
}

export function toReviewOutputFromDocument(
  reviewId: string,
  summary: string,
  status: 'changes_requested' | 'needs_confirmation' | 'no_major_findings',
  findings: Finding[],
  nextActions: string[],
): ReviewOutput {
  return {
    review_id: reviewId,
    review_status: status,
    findings,
    summary,
    next_actions: nextActions,
    rerun_review: findings.some((finding) => finding.severity === 'error'),
    metadata: {
      reviewed_files: 1,
      risk_level: findings.some((finding) => finding.severity === 'error')
        ? 'high'
        : findings.length > 0
          ? 'medium'
          : 'low',
      static_analysis_used: false,
      knowledge_applied: [],
      degraded_mode: false,
      degraded_reasons: [],
      local_llm_used: true,
      heavy_llm_used: false,
      review_duration_ms: 0,
    },
    markdown: '',
  };
}
