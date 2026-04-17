import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { entities } from '../../db/schema.js';
import { generateEntityId } from '../../utils/entityId.js';
import { saveEntities } from '../graph.js';
import { recordOutcome } from '../procedure.js';
import type { ReviewOutput } from './types.js';

const CODE_REVIEW_GOAL_ID = 'goal:gnosis-code-review';

/**
 * Ensures that a global 'Code Review' goal exists in the Knowledge Graph.
 */
export async function ensureCodeReviewGoal() {
  const [existing] = await db
    .select()
    .from(entities)
    .where(eq(entities.id, CODE_REVIEW_GOAL_ID))
    .limit(1);

  if (!existing) {
    await saveEntities([
      {
        id: CODE_REVIEW_GOAL_ID,
        type: 'goal',
        name: 'Gnosis Code Review',
        description:
          'Review code changes for bugs, security, and maintainability using Gnosis memory.',
        confidence: 0.8,
        provenance: 'system_initialization',
      },
    ]);
  }
  return CODE_REVIEW_GOAL_ID;
}

/**
 * Records the outcome of a Stage E review in Gnosis memory.
 */
export async function recordReviewResult(review: ReviewOutput) {
  const goalId = await ensureCodeReviewGoal();

  // Map findings to improvements
  const improvements = review.findings.map((finding) => ({
    type: 'add_constraint' as const,
    suggestion: `Defend against: ${finding.title} - ${finding.rationale}`,
  }));

  // Note: For now, we treat the review as "followed" if findings were produced
  return recordOutcome({
    goalId,
    sessionId: review.review_id || 'review-session',
    taskResults: [
      {
        taskId: goalId, // Linking to the goal itself as a task completion
        followed: true,
        succeeded: review.findings.length === 0,
        note: review.summary,
      },
    ],
    improvements: improvements.length > 0 ? improvements : undefined,
  });
}
