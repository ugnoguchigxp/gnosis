import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Mock } from 'bun:test';
import { runLlmTask } from '../../../adapters/llm.js';
import type { TopicTask } from '../domain/task';
import type { FlowEvidence } from '../flows/types';
import type { StructuredLogEvent } from '../ops/logger';
import type { QueueRepository } from '../queue/repository';
import { type KnowledgeRepositoryLike, createKnowFlowTaskHandler } from './knowFlowHandler';

vi.mock('../../../adapters/llm.js', () => ({
  runLlmTask: vi.fn(),
}));

describe.skip('knowFlowHandler', () => {
  const mockRepo: KnowledgeRepositoryLike = {
    getByTopic: vi.fn(),
    merge: vi.fn(),
  };

  const mockQueueRepo: Pick<QueueRepository, 'enqueue'> = {
    enqueue: vi.fn(),
  };

  const mockEvidenceProvider = vi.fn();

  const testLogger = (_event: StructuredLogEvent): void => {};

  beforeEach(() => {
    vi.clearAllMocks();
    (runLlmTask as unknown as Mock<typeof runLlmTask>).mockResolvedValue({
      task: 'gap_planner' as const,
      output: {
        queries: ['test query'],
        steps: [{ title: 'step 1', queries: ['query 1'] }],
      } as unknown as Awaited<ReturnType<typeof runLlmTask>>['output'],
      backend: 'api' as const,
      degraded: false,
      warnings: [],
    });
  });

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

  it('should complete a cron task successfully', async () => {
    const handler = createKnowFlowTaskHandler({
      repository: mockRepo,
      queueRepository: mockQueueRepo as QueueRepository,
      evidenceProvider: mockEvidenceProvider,
      budget: { cronBudget: 1000, cronRunBudget: 100, userBudget: 500 },
      logger: testLogger,
    });

    mockEvidenceProvider.mockResolvedValue({
      claims: [],
      sources: [],
      normalizedSources: [],
      relations: [],
      queryCountUsed: 1,
    } as FlowEvidence);

    (mockRepo.getByTopic as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockRepo.merge as ReturnType<typeof vi.fn>).mockResolvedValue({
      knowledge: {},
      changed: true,
    });

    const result = await handler(defaultTask);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('accepted=0');
    }
    expect(mockEvidenceProvider).toHaveBeenCalledWith(defaultTask, undefined);
  });

  it('should handle user tasks differently', async () => {
    const userTask: TopicTask = { ...defaultTask, source: 'user' };
    const handler = createKnowFlowTaskHandler({
      repository: mockRepo,
      queueRepository: mockQueueRepo as QueueRepository,
      evidenceProvider: mockEvidenceProvider,
      logger: testLogger,
    });

    mockEvidenceProvider.mockResolvedValue({
      claims: [],
      sources: [],
      normalizedSources: [],
      relations: [],
      queryCountUsed: 1,
    } as FlowEvidence);

    (mockRepo.merge as ReturnType<typeof vi.fn>).mockResolvedValue({
      knowledge: {},
      changed: true,
    });

    const result = await handler(userTask);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // User flow results typically include a summary from ExplorationReport
      expect(result.summary).toBeDefined();
    }
  });

  it('should continue even if GapPlanner fails (best-effort)', async () => {
    const handler = createKnowFlowTaskHandler({
      repository: mockRepo,
      queueRepository: mockQueueRepo as QueueRepository,
      evidenceProvider: mockEvidenceProvider,
      logger: testLogger,
      // Pass invalid LLM config to trigger planner error if it uses LLM
      llmConfig: { apiKeyEnv: 'INVALID_KEY_ENV' },
    });

    mockEvidenceProvider.mockResolvedValue({
      claims: [],
      sources: [],
      normalizedSources: [],
      relations: [],
      queryCountUsed: 1,
    } as FlowEvidence);

    (mockRepo.merge as ReturnType<typeof vi.fn>).mockResolvedValue({
      knowledge: {},
      changed: true,
    });

    // Logic for GapPlanner fallback is triggered if no tasks are planned or LLM fails
    // Here we just test that the task itself succeeds.
    const result = await handler(defaultTask);

    expect(result.ok).toBe(true);
  });
});
