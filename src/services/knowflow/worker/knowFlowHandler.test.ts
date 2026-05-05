import { describe, expect, it, vi } from 'bun:test';
import type { TopicTask } from '../domain/task';
import type { StructuredLogEvent } from '../ops/logger';
import { type KnowFlowEvidence, createKnowFlowTaskHandler } from './knowFlowHandler';

const testLogger = (_event: StructuredLogEvent): void => {};

const defaultTask: TopicTask = {
  id: 'task-1',
  topic: 'test-topic',
  mode: 'expand',
  source: 'cron',
  status: 'pending',
  priority: 10,
  attempts: 0,
  dedupeKey: 'test-topic:expand:cron',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const makeDatabase = () => {
  const insertedValues: unknown[] = [];
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn((payload: unknown) => {
    insertedValues.push(payload);
    return { onConflictDoUpdate };
  });
  const insert = vi.fn(() => ({ values }));
  return { database: { insert } as never, insertedValues, insert, onConflictDoUpdate };
};

describe('knowFlowHandler', () => {
  it('fails immediately when session_distillation receives an already aborted signal', async () => {
    const systemTask: TopicTask = {
      ...defaultTask,
      id: 'system-task-1',
      topic: '__system__/session_distillation/test-session',
      metadata: {
        systemTask: {
          type: 'session_distillation',
          payload: {
            sessionId: 'test-session',
            provider: 'auto',
            force: false,
            promote: false,
          },
        },
      },
    };
    const abortController = new AbortController();
    abortController.abort();

    const handler = createKnowFlowTaskHandler({
      evidenceProvider: vi.fn(),
      logger: testLogger,
    });

    const result = await handler(systemTask, abortController.signal);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('errorKind=AbortError');
      expect(result.retryable).toBe(false);
    }
  });

  it('records a research note and completes the task', async () => {
    const db = makeDatabase();
    const mockEvidenceProvider = vi.fn().mockResolvedValue({
      researchNote: 'Use a TypeChecker when TypeScript analysis needs semantic symbols.',
      referenceUrls: ['https://typescriptlang.org/docs'],
      fetchedPageCount: 1,
      queryCountUsed: 1,
    } satisfies KnowFlowEvidence);

    const handler = createKnowFlowTaskHandler({
      evidenceProvider: mockEvidenceProvider,
      database: db.database,
      logger: testLogger,
      cronRunWindowMs: 3_600_000,
    });

    const result = await handler(defaultTask);

    expect(result.ok).toBe(true);
    expect(mockEvidenceProvider).toHaveBeenCalledWith(defaultTask, undefined);
    expect(db.insert).toHaveBeenCalledTimes(1);
    const inserted = db.insertedValues[0] as { type: string; confidence: unknown };
    expect(inserted.type).toBe('concept');
    expect(inserted.confidence).toBeNull();
    expect(db.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ confidence: null }),
      }),
    );
  });

  it('does not create an entity when research note is missing', async () => {
    const db = makeDatabase();
    const mockEvidenceProvider = vi.fn().mockResolvedValue({
      referenceUrls: ['https://example.com'],
      fetchedPageCount: 1,
      diagnostics: { outcome: 'no_research_note', messages: [] },
    } satisfies KnowFlowEvidence);

    const handler = createKnowFlowTaskHandler({
      evidenceProvider: mockEvidenceProvider,
      database: db.database,
      logger: testLogger,
      cronRunWindowMs: 3_600_000,
    });

    const result = await handler(defaultTask);

    expect(result.ok).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
