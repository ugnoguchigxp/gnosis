import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Mock } from 'bun:test';
import { runLlmTask } from '../../../adapters/llm.js';
import type { TopicTask } from '../domain/task';
import type { GapPlanner } from '../gap/planner';
import type { StructuredLogEvent } from '../ops/logger';
import { MetricsCollector } from '../ops/metrics';
import type { KnowledgeRepositoryLike } from './knowFlowHandler';
import { PipelineOrchestrator } from './pipeline';

vi.mock('../../../adapters/llm.js', () => ({
  runLlmTask: vi.fn(),
}));

describe('KnowFlow Pipeline Smoke Test', () => {
  const mockRepo: KnowledgeRepositoryLike = {
    getByTopic: vi.fn(),
    merge: vi.fn(),
  };

  const mockEvidenceProvider = vi.fn();
  const mockGapPlanner: Pick<GapPlanner, 'planAndEnqueueSafe'> = {
    planAndEnqueueSafe: vi.fn(),
  };

  const defaultTask: TopicTask = {
    id: 'smoke-task-1',
    topic: 'Smoke Test Topic',
    mode: 'explore',
    source: 'cron',
    status: 'pending',
    priority: 10,
    attempts: 0,
    dedupeKey: 'smoke-test-topic:explore:cron',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const testLogger = (_event: StructuredLogEvent): void => {};

  beforeEach(() => {
    vi.clearAllMocks();
    (runLlmTask as unknown as Mock<typeof runLlmTask>).mockResolvedValue({
      task: 'gap_planner' as const,
      output: { queries: [], steps: [] } as unknown as Awaited<
        ReturnType<typeof runLlmTask>
      >['output'],
      backend: 'api' as const,
      degraded: false,
      warnings: [],
    });
  });

  it('orchestrates all phases in sequence', async () => {
    const orchestrator = new PipelineOrchestrator({
      task: defaultTask,
      repository: mockRepo,
      evidenceProvider: mockEvidenceProvider,
      gapPlanner: mockGapPlanner as GapPlanner,
      budget: { cronBudget: 100, cronRunBudget: 50, userBudget: 50 },
      cronRunConsumed: 0,
      logger: testLogger,
      metrics: new MetricsCollector(),
      now: () => Date.now(),
    });

    mockEvidenceProvider.mockResolvedValue({
      claims: [{ text: 'Found something', confidence: 0.8, sourceIds: ['s1'] }],
      sources: [{ id: 's1', domain: 'example.com', fetchedAt: Date.now(), qualityScore: 0.9 }],
      normalizedSources: [],
      relations: [],
      queryCountUsed: 1,
    });

    (mockRepo.getByTopic as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockRepo.merge as ReturnType<typeof vi.fn>).mockResolvedValue({
      knowledge: {},
      changed: true,
    });
    (mockGapPlanner.planAndEnqueueSafe as ReturnType<typeof vi.fn>).mockResolvedValue({
      plannedTasks: 2,
      hadErrors: false,
    });

    const result = await orchestrator.run();

    expect(result.ok).toBe(true);
    expect(result.phases.evidenceCollection.ok).toBe(true);
    expect(result.phases.flowExecution.ok).toBe(true);
    expect(result.phases.followupPlanning.ok).toBe(true);
    expect(result.phases.followupPlanning.data?.plannedTasks).toBe(2);

    expect(mockEvidenceProvider).toHaveBeenCalled();
    expect(mockRepo.merge).toHaveBeenCalled();
    expect(mockGapPlanner.planAndEnqueueSafe).toHaveBeenCalled();
  });

  it('fails gracefully if evidence collection fails', async () => {
    const orchestrator = new PipelineOrchestrator({
      task: defaultTask,
      repository: mockRepo,
      evidenceProvider: mockEvidenceProvider,
      gapPlanner: mockGapPlanner as GapPlanner,
      budget: { cronBudget: 100, cronRunBudget: 50, userBudget: 50 },
      cronRunConsumed: 0,
      logger: testLogger,
      metrics: new MetricsCollector(),
      now: () => Date.now(),
    });

    mockEvidenceProvider.mockRejectedValue(new Error('Network error'));

    const result = await orchestrator.run();

    expect(result.ok).toBe(false);
    expect(result.phases.evidenceCollection.ok).toBe(false);
    expect(result.phases.evidenceCollection.error).toBe('Network error');
    expect(result.phases.flowExecution.ok).toBe(false);
  });
});
