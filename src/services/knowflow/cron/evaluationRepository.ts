import { desc, eq } from 'drizzle-orm';
import { db as defaultDb } from '../../../db/index.js';
import { knowflowKeywordEvaluations } from '../../../db/schema.js';
import { type KeywordEvaluationRow, KeywordEvaluationRowSchema } from './types.js';

type DatabaseLike = typeof defaultDb;

export class KeywordEvaluationRepository {
  private database: DatabaseLike;

  constructor(database: DatabaseLike = defaultDb) {
    this.database = database;
  }

  async saveEvaluations(rows: KeywordEvaluationRow[]): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }

    const normalized = rows.map((row) => {
      const parsed = KeywordEvaluationRowSchema.parse(row);
      return {
        runId: parsed.runId,
        sourceType: parsed.sourceType,
        sourceId: parsed.sourceId,
        topic: parsed.topic,
        category: parsed.category,
        whyResearch: parsed.whyResearch,
        searchScore: parsed.searchScore,
        termDifficultyScore: parsed.termDifficultyScore,
        uncertaintyScore: parsed.uncertaintyScore,
        threshold: parsed.threshold,
        decision: parsed.decision,
        enqueuedTaskId: parsed.enqueuedTaskId,
        modelAlias: parsed.modelAlias,
        createdAt: parsed.createdAt ?? new Date(),
      };
    });

    const inserted = await this.database
      .insert(knowflowKeywordEvaluations)
      .values(normalized)
      .onConflictDoNothing()
      .returning({ id: knowflowKeywordEvaluations.id });

    return inserted.length;
  }

  async attachEnqueuedTaskId(evaluationId: string, taskId: string): Promise<boolean> {
    const updated = await this.database
      .update(knowflowKeywordEvaluations)
      .set({ enqueuedTaskId: taskId })
      .where(eq(knowflowKeywordEvaluations.id, evaluationId))
      .returning({ id: knowflowKeywordEvaluations.id });

    return updated.length > 0;
  }

  async listRecent(limit = 20): Promise<Array<typeof knowflowKeywordEvaluations.$inferSelect>> {
    const safeLimit = Math.max(1, Math.trunc(limit));
    return this.database
      .select()
      .from(knowflowKeywordEvaluations)
      .orderBy(desc(knowflowKeywordEvaluations.createdAt))
      .limit(safeLimit);
  }

  /** Alias for listRecent to match implementation plan naming */
  async listRecentEvaluations(
    limit = 20,
  ): Promise<Array<typeof knowflowKeywordEvaluations.$inferSelect>> {
    return this.listRecent(limit);
  }

  async listByRun(runId: string): Promise<Array<typeof knowflowKeywordEvaluations.$inferSelect>> {
    return this.database
      .select()
      .from(knowflowKeywordEvaluations)
      .where(eq(knowflowKeywordEvaluations.runId, runId))
      .orderBy(desc(knowflowKeywordEvaluations.createdAt));
  }
}
