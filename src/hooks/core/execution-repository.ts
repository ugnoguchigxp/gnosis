import { and, eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { db as defaultDb } from '../../db/index.js';
import { hookExecutions } from '../../db/schema.js';
import type { HookExecutionRepository, HookExecutionStartResult } from './hook-types.js';

type DbLike = Pick<typeof defaultDb, 'insert' | 'update'>;
const recentExecutionKeys = new Map<string, true>();

function rememberExecutionKey(key: string): void {
  recentExecutionKeys.delete(key);
  recentExecutionKeys.set(key, true);
  while (recentExecutionKeys.size > config.hooks.executionCacheSize) {
    const oldestKey = recentExecutionKeys.keys().next().value;
    if (!oldestKey) break;
    recentExecutionKeys.delete(oldestKey);
  }
}

export class PgHookExecutionRepository implements HookExecutionRepository {
  constructor(private readonly database: DbLike = defaultDb) {}

  async tryStartExecution(input: {
    eventId: string;
    ruleId: string;
    traceId: string;
  }): Promise<HookExecutionStartResult> {
    const cacheKey = `${input.eventId}::${input.ruleId}`;
    if (recentExecutionKeys.has(cacheKey)) {
      return { started: false };
    }

    const inserted = await this.database
      .insert(hookExecutions)
      .values({
        eventId: input.eventId,
        ruleId: input.ruleId,
        traceId: input.traceId,
        status: 'started',
      })
      .onConflictDoNothing()
      .returning({ id: hookExecutions.id });

    if (inserted.length > 0) {
      rememberExecutionKey(cacheKey);
    }

    return {
      started: inserted.length > 0,
    };
  }

  async completeExecution(input: {
    eventId: string;
    ruleId: string;
    status: 'succeeded' | 'failed' | 'blocked' | 'skipped';
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.database
      .update(hookExecutions)
      .set({
        status: input.status,
        errorMessage: input.errorMessage,
        metadata: input.metadata ?? {},
        updatedAt: new Date(),
      })
      .where(
        and(eq(hookExecutions.eventId, input.eventId), eq(hookExecutions.ruleId, input.ruleId)),
      );
  }
}

export class InMemoryHookExecutionRepository implements HookExecutionRepository {
  private readonly keys = new Set<string>();

  async tryStartExecution(input: {
    eventId: string;
    ruleId: string;
    traceId: string;
  }): Promise<HookExecutionStartResult> {
    void input.traceId;
    const key = `${input.eventId}::${input.ruleId}`;
    if (this.keys.has(key)) {
      return { started: false };
    }
    this.keys.add(key);
    rememberExecutionKey(key);
    return { started: true };
  }

  async completeExecution(): Promise<void> {
    return;
  }
}
