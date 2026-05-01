import { db } from '../../../db/index.js';
import { reviewCases, reviewOutcomes } from '../../../db/schema.js';
import { saveExperience } from '../../experience.js';
import { saveMemory } from '../../memory.js';
import type { Finding, ReviewOutput, ReviewRequest } from '../types.js';

export interface ReviewPersistenceDependencies {
  database?: typeof db;
  saveExperience?: typeof saveExperience;
  saveMemory?: typeof saveMemory;
  now?: () => Date;
}

export function getProjectKey(repoPath: string): string {
  const base = repoPath.split('/').filter(Boolean).at(-1) ?? 'repo';
  return base.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase();
}

function classifyReviewExperience(result: ReviewOutput): {
  type: 'success' | 'failure';
  failureType?: string;
} {
  if (result.review_status === 'changes_requested') {
    return { type: 'failure', failureType: 'REVIEW_BLOCKING' };
  }
  if (result.review_status === 'needs_confirmation') {
    return { type: 'failure', failureType: 'REVIEW_INCONCLUSIVE' };
  }
  if (result.metadata.degraded_mode) {
    return { type: 'failure', failureType: 'REVIEW_DEGRADED' };
  }
  return { type: 'success' };
}

function mapFindingMemoryContent(finding: Finding): string {
  return `[${finding.severity}:${finding.category}] ${finding.title}: ${finding.rationale}`;
}

async function persistReviewOutcomes(
  database: typeof db,
  reviewCaseId: string,
  findings: Finding[],
  now: Date,
): Promise<void> {
  for (const finding of findings) {
    await database
      .insert(reviewOutcomes)
      .values({
        reviewCaseId,
        findingId: finding.id,
        outcomeType: finding.severity === 'error' ? 'pending' : 'adopted',
        followupCommitHash: null,
        resolutionTimestamp: null,
        guidanceIds: finding.knowledge_refs ?? [],
        falsePositive: false,
        notes: finding.rationale,
        autoDetected: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [reviewOutcomes.reviewCaseId, reviewOutcomes.findingId],
        set: {
          outcomeType: finding.severity === 'error' ? 'pending' : 'adopted',
          guidanceIds: finding.knowledge_refs ?? [],
          notes: finding.rationale,
          updatedAt: now,
        },
      });
  }
}

async function persistFindingMemories(
  projectKey: string,
  reviewCaseId: string,
  findings: Finding[],
  deps: Required<Pick<ReviewPersistenceDependencies, 'saveMemory'>>,
): Promise<void> {
  for (const finding of findings) {
    await deps.saveMemory(`code-review-${projectKey}`, mapFindingMemoryContent(finding), {
      reviewCaseId,
      filePath: finding.file_path,
      category: finding.category,
      guidanceRefs: finding.knowledge_refs ?? [],
      fingerprint: finding.fingerprint,
      severity: finding.severity,
    });
  }
}

async function persistGuidanceRelations(
  findings: Finding[],
  deps: Required<Pick<ReviewPersistenceDependencies, 'saveMemory'>>,
): Promise<void> {
  for (const finding of findings) {
    if (!finding.knowledge_refs?.length) continue;

    await deps.saveMemory(
      'code-review-kg',
      `Finding "${finding.title}" (${
        finding.category
      }) was guided by: ${finding.knowledge_refs.join(', ')}`,
      {
        entities: [
          { id: `finding:${finding.fingerprint}`, type: 'finding', name: finding.title },
          ...finding.knowledge_refs.map((ref) => ({
            id: `guidance:${ref}`,
            type: 'guidance',
            name: ref,
          })),
        ],
        relations: finding.knowledge_refs.map((ref) => ({
          sourceId: `finding:${finding.fingerprint}`,
          targetId: `guidance:${ref}`,
          relationType: 'derived_from',
        })),
      },
    );
  }
}

export async function persistReviewCase(
  req: ReviewRequest,
  result: ReviewOutput,
  deps: ReviewPersistenceDependencies = {},
): Promise<void> {
  const database = deps.database ?? db;
  const saveExperienceImpl = deps.saveExperience ?? saveExperience;
  const saveMemoryImpl = deps.saveMemory ?? saveMemory;
  const now = deps.now ?? (() => new Date());
  const timestamp = now();
  const projectKey = getProjectKey(req.repoPath);

  await database
    .insert(reviewCases)
    .values({
      id: result.review_id,
      taskId: req.taskId,
      repoPath: req.repoPath,
      baseRef: req.baseRef,
      headRef: req.headRef,
      taskGoal: req.taskGoal,
      trigger: req.trigger,
      status: 'completed',
      riskLevel: result.metadata.risk_level,
      reviewStatus: result.review_status,
      summary: result.summary,
      createdAt: timestamp,
      completedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: reviewCases.id,
      set: {
        status: 'completed',
        riskLevel: result.metadata.risk_level,
        reviewStatus: result.review_status,
        summary: result.summary,
        completedAt: timestamp,
      },
    });

  await saveExperienceImpl(
    {
      sessionId: `code-review-${projectKey}`,
      scenarioId: result.review_id,
      attempt: 1,
      ...classifyReviewExperience(result),
      content: result.summary,
      metadata: {
        findingsCount: result.findings.length,
        riskLevel: result.metadata.risk_level,
        guidanceApplied: result.metadata.knowledge_applied,
        degradedModes: result.metadata.degraded_reasons,
        reviewDurationMs: result.metadata.review_duration_ms,
      },
    },
    database,
  );

  await persistReviewOutcomes(database, result.review_id, result.findings, timestamp);
  await persistFindingMemories(projectKey, result.review_id, result.findings, {
    saveMemory: saveMemoryImpl,
  });
  await persistGuidanceRelations(result.findings, {
    saveMemory: saveMemoryImpl,
  });
}

export async function recordFeedback(
  reviewCaseId: string,
  findingId: string,
  outcomeType: 'adopted' | 'ignored' | 'dismissed' | 'resolved' | 'pending',
  options: { notes?: string; falsePositive?: boolean; guidanceIds?: string[] } = {},
  database: typeof db = db,
): Promise<void> {
  const now = new Date();
  await database
    .insert(reviewOutcomes)
    .values({
      reviewCaseId,
      findingId,
      outcomeType,
      followupCommitHash: null,
      resolutionTimestamp: null,
      guidanceIds: options.guidanceIds ?? [],
      falsePositive: options.falsePositive ?? false,
      notes: options.notes,
      autoDetected: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [reviewOutcomes.reviewCaseId, reviewOutcomes.findingId],
      set: {
        outcomeType,
        guidanceIds: options.guidanceIds ?? [],
        falsePositive: options.falsePositive ?? false,
        notes: options.notes,
        updatedAt: now,
      },
    });
}

export async function detectFeedbackFromCommit(
  reviewCaseId: string,
  commitHash: string,
  repoPath: string,
): Promise<void> {
  void reviewCaseId;
  void commitHash;
  void repoPath;
  // Stage C does not require auto-detection wiring in this iteration.
}
