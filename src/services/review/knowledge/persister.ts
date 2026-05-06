import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { reviewCases, reviewOutcomes, vibeMemories } from '../../../db/schema.js';
import { saveExperience } from '../../experience.js';
import { saveMemory } from '../../memory.js';
import type { Finding, ReviewOutput, ReviewRequest } from '../types.js';

const execFileAsync = promisify(execFile);

export interface ReviewPersistenceDependencies {
  database?: typeof db;
  saveExperience?: typeof saveExperience;
  saveMemory?: typeof saveMemory;
  now?: () => Date;
}

export type ReviewOutcomeType = 'adopted' | 'ignored' | 'dismissed' | 'resolved' | 'pending';

export type ReviewFeedbackOptions = {
  notes?: string;
  falsePositive?: boolean;
  guidanceIds?: string[];
  followupCommitHash?: string;
  resolutionTimestamp?: Date;
  autoDetected?: boolean;
};

type FindingMemoryMetadata = {
  reviewCaseId?: string;
  findingId?: string;
  filePath?: string;
  category?: string;
  guidanceRefs?: string[];
  fingerprint?: string;
  severity?: string;
  title?: string;
  lineNew?: number;
  evidence?: string;
};

type CommitEvidence = {
  message: string;
  changedFiles: string[];
  committedAt: Date;
};

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
        outcomeType: 'pending',
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
          guidanceIds: finding.knowledge_refs ?? [],
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
      findingId: finding.id,
      filePath: finding.file_path,
      category: finding.category,
      guidanceRefs: finding.knowledge_refs ?? [],
      fingerprint: finding.fingerprint,
      severity: finding.severity,
      title: finding.title,
      lineNew: finding.line_new,
      evidence: finding.evidence,
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
  outcomeType: ReviewOutcomeType,
  options: ReviewFeedbackOptions = {},
  database: typeof db = db,
): Promise<void> {
  const notes = options.notes?.trim();
  const followupCommitHash = options.followupCommitHash?.trim();
  if (outcomeType !== 'pending' && !notes) {
    throw new Error(`${outcomeType} review feedback requires notes evidence`);
  }
  if (outcomeType === 'resolved' && !followupCommitHash) {
    throw new Error('resolved review feedback requires followupCommitHash evidence');
  }
  if (outcomeType !== 'resolved' && followupCommitHash) {
    throw new Error('followupCommitHash is only valid for resolved review feedback');
  }
  const now = new Date();
  const resolutionTimestamp =
    outcomeType === 'resolved' ? options.resolutionTimestamp ?? now : null;
  await database
    .insert(reviewOutcomes)
    .values({
      reviewCaseId,
      findingId,
      outcomeType,
      followupCommitHash: followupCommitHash ?? null,
      resolutionTimestamp,
      guidanceIds: options.guidanceIds ?? [],
      falsePositive: options.falsePositive ?? false,
      notes,
      autoDetected: options.autoDetected ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [reviewOutcomes.reviewCaseId, reviewOutcomes.findingId],
      set: {
        outcomeType,
        followupCommitHash: followupCommitHash ?? null,
        resolutionTimestamp,
        guidanceIds: options.guidanceIds ?? [],
        falsePositive: options.falsePositive ?? false,
        notes,
        autoDetected: options.autoDetected ?? false,
        updatedAt: now,
      },
    });
}

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function metadataRecord(value: unknown): FindingMemoryMetadata {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as FindingMemoryMetadata)
    : {};
}

export function shouldResolveFindingFromCommit(input: {
  reviewCaseId: string;
  findingId: string;
  filePath?: string | null;
  commitMessage: string;
  changedFiles: string[];
}): boolean {
  const message = input.commitMessage.toLowerCase();
  const findingId = input.findingId.toLowerCase();
  const reviewCaseId = input.reviewCaseId.toLowerCase();
  const mentionsFinding = message.includes(findingId);
  const mentionsReviewCase = message.includes(reviewCaseId);
  if (!mentionsFinding || !mentionsReviewCase || !input.filePath) return false;

  const findingPath = normalizeRepoPath(input.filePath);
  return input.changedFiles.some((filePath) => normalizeRepoPath(filePath) === findingPath);
}

async function readCommitEvidence(repoPath: string, commitHash: string): Promise<CommitEvidence> {
  const [{ stdout: message }, { stdout: changedFiles }, { stdout: committedAtSeconds }] =
    await Promise.all([
      execFileAsync('git', ['-C', repoPath, 'show', '--format=%B', '--no-patch', commitHash]),
      execFileAsync('git', ['-C', repoPath, 'show', '--format=', '--name-only', commitHash]),
      execFileAsync('git', ['-C', repoPath, 'show', '--format=%ct', '--no-patch', commitHash]),
    ]);
  const timestamp = Number.parseInt(committedAtSeconds.trim(), 10);
  return {
    message,
    changedFiles: changedFiles
      .split(/\r?\n/)
      .map((filePath) => filePath.trim())
      .filter(Boolean),
    committedAt: Number.isFinite(timestamp) ? new Date(timestamp * 1000) : new Date(),
  };
}

export async function detectFeedbackFromCommit(
  reviewCaseId: string,
  commitHash: string,
  repoPath: string,
  database: typeof db = db,
): Promise<number> {
  const [commit, outcomes, memoryRows] = await Promise.all([
    readCommitEvidence(repoPath, commitHash),
    database
      .select({
        findingId: reviewOutcomes.findingId,
        guidanceIds: reviewOutcomes.guidanceIds,
      })
      .from(reviewOutcomes)
      .where(
        and(
          eq(reviewOutcomes.reviewCaseId, reviewCaseId),
          inArray(reviewOutcomes.outcomeType, ['pending', 'adopted']),
        ),
      ),
    database
      .select({
        content: vibeMemories.content,
        metadata: vibeMemories.metadata,
      })
      .from(vibeMemories)
      .where(sql`${vibeMemories.metadata}->>'reviewCaseId' = ${reviewCaseId}`),
  ]);

  const memoryByFindingId = new Map(
    memoryRows
      .map((row) => {
        const metadata = metadataRecord(row.metadata);
        return metadata.findingId ? [metadata.findingId, { content: row.content, metadata }] : null;
      })
      .filter((entry): entry is [string, { content: string; metadata: FindingMemoryMetadata }] =>
        Boolean(entry),
      ),
  );

  let resolvedCount = 0;
  for (const outcome of outcomes) {
    const findingMemory = memoryByFindingId.get(outcome.findingId);
    if (
      !shouldResolveFindingFromCommit({
        reviewCaseId,
        findingId: outcome.findingId,
        filePath: findingMemory?.metadata.filePath,
        commitMessage: commit.message,
        changedFiles: commit.changedFiles,
      })
    ) {
      continue;
    }

    await recordFeedback(
      reviewCaseId,
      outcome.findingId,
      'resolved',
      {
        notes: [
          'auto_detected_from_commit',
          `commit=${commitHash}`,
          findingMemory?.metadata.filePath ? `file=${findingMemory.metadata.filePath}` : null,
          findingMemory?.metadata.title ? `title=${findingMemory.metadata.title}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        guidanceIds: Array.isArray(outcome.guidanceIds)
          ? outcome.guidanceIds.filter((item): item is string => typeof item === 'string')
          : [],
        followupCommitHash: commitHash,
        resolutionTimestamp: commit.committedAt,
        autoDetected: true,
      },
      database,
    );
    resolvedCount += 1;
  }
  return resolvedCount;
}
