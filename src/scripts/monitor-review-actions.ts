import { eq } from 'drizzle-orm';
import { closeDbPool, db } from '../db/index.js';
import { reviewCases, reviewOutcomes, vibeMemories } from '../db/schema.js';
import { parseArgMap, readStringFlag } from '../services/knowflow/utils/args.js';
import { renderOutput, resolveOutputFormat } from '../services/knowflow/utils/output.js';
import { detectFeedbackFromCommit } from '../services/review/knowledge/persister.js';
import { sha256 } from '../utils/crypto.js';

const REVIEW_NOTE_SESSION = 'monitor-review-notes';

const run = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const outputFormat = resolveOutputFormat(args);
  const action = readStringFlag(args, 'action');
  const reviewCaseId = readStringFlag(args, 'review-case-id');
  const commitHash = readStringFlag(args, 'commit-hash');
  const repoPath = readStringFlag(args, 'repo-path');

  if (action !== 'create-task-note' && action !== 'detect-feedback-from-commit') {
    throw new Error('--action must be create-task-note|detect-feedback-from-commit');
  }
  if (!reviewCaseId) {
    throw new Error('--review-case-id is required');
  }

  const caseRows = await db
    .select({
      id: reviewCases.id,
      taskId: reviewCases.taskId,
      repoPath: reviewCases.repoPath,
      status: reviewCases.status,
      summary: reviewCases.summary,
    })
    .from(reviewCases)
    .where(eq(reviewCases.id, reviewCaseId))
    .limit(1);
  const reviewCase = caseRows[0];
  if (!reviewCase) {
    throw new Error(`review case not found: ${reviewCaseId}`);
  }

  if (action === 'detect-feedback-from-commit') {
    if (!commitHash) {
      throw new Error('--commit-hash is required');
    }
    const targetRepoPath = repoPath ?? reviewCase.repoPath;
    const resolvedCount = await detectFeedbackFromCommit(reviewCaseId, commitHash, targetRepoPath);
    process.stdout.write(
      renderOutput(
        {
          success: true,
          action,
          reviewCaseId,
          commitHash,
          repoPath: targetRepoPath,
          resolvedCount,
        },
        outputFormat,
      ),
    );
    return;
  }

  const outcomeRows = await db
    .select({
      outcomeType: reviewOutcomes.outcomeType,
      notes: reviewOutcomes.notes,
    })
    .from(reviewOutcomes)
    .where(eq(reviewOutcomes.reviewCaseId, reviewCaseId));

  const pending = outcomeRows.filter((row) => row.outcomeType === 'pending').length;
  const note = [
    `review_case_id=${reviewCase.id}`,
    `task_id=${reviewCase.taskId}`,
    `repo_path=${reviewCase.repoPath}`,
    `status=${reviewCase.status}`,
    `pending_outcomes=${pending}`,
    `summary=${reviewCase.summary ?? '-'}`,
  ].join('\n');

  const dedupeKey = sha256(`review-note:${reviewCase.id}:${note}`);
  await db
    .insert(vibeMemories)
    .values({
      sessionId: REVIEW_NOTE_SESSION,
      content: note,
      dedupeKey,
      metadata: {
        kind: 'task_note',
        source: 'monitor_review',
        reviewCaseId: reviewCase.id,
        taskId: reviewCase.taskId,
      },
    })
    .onConflictDoNothing({ target: [vibeMemories.sessionId, vibeMemories.dedupeKey] });

  process.stdout.write(
    renderOutput(
      { success: true, action, reviewCaseId, sessionId: REVIEW_NOTE_SESSION },
      outputFormat,
    ),
  );
};

run()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
