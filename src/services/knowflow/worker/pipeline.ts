import type { BudgetConfig } from '../../../config';
import type { TopicTask } from '../domain/task';
import { runCronFlow } from '../flows/cronFlow';
import type { CronFlowRepository } from '../flows/cronFlow';
import type { FlowResult } from '../flows/result';
import type { FlowEvidence } from '../flows/types';
import { runUserFlow } from '../flows/userFlow';
import type { UserFlowRepository } from '../flows/userFlow';
import type { GapPlanner } from '../gap/planner';
import type { StructuredLogger } from '../ops/logger';
import type { MetricsCollector } from '../ops/metrics';
import type { EvidenceProvider, KnowledgeRepositoryLike } from './knowFlowHandler';

// KnowledgeRepositoryLike satisfies both CronFlowRepository and UserFlowRepository
type FlowRepository = KnowledgeRepositoryLike & CronFlowRepository & UserFlowRepository;

export type PipelinePhase = 'evidence_collection' | 'flow_execution' | 'followup_planning';

export type PhaseResult<T = unknown> = {
  ok: boolean;
  error?: string;
  data?: T;
  durationMs: number;
};

export type PipelineResult = {
  taskId: string;
  topic: string;
  ok: boolean;
  summary: string;
  phases: {
    evidenceCollection: PhaseResult<FlowEvidence>;
    flowExecution: PhaseResult<FlowResult>;
    followupPlanning: PhaseResult<{ plannedTasks: number; hadErrors: boolean }>;
  };
};

export type PipelineOptions = {
  task: TopicTask;
  repository: FlowRepository;
  evidenceProvider: EvidenceProvider;
  gapPlanner: GapPlanner;
  budget: BudgetConfig;
  cronRunConsumed: number;
  logger: StructuredLogger;
  metrics: MetricsCollector;
  now: () => number;
  signal?: AbortSignal;
  evaluateRegistration?: (input: {
    topic: string;
    acceptedClaims: Array<{ text: string; confidence: number; sourceIds: string[] }>;
    sources: Array<{
      id: string;
      url?: string;
      domain?: string;
      fetchedAt?: number;
      publishedAt?: number;
    }>;
    verifierSummary: string;
  }) => Promise<{ allow: boolean; reason: string; confidence: number }>;
};

/**
 * KnowFlow 処理パイプラインのオーケストレーター
 */
export class PipelineOrchestrator {
  constructor(private options: PipelineOptions) {}

  async run(): Promise<PipelineResult> {
    const { task, logger, now, signal } = this.options;
    const startTime = now();

    const result: PipelineResult = {
      taskId: task.id,
      topic: task.topic,
      ok: false,
      summary: '',
      phases: {
        evidenceCollection: { ok: false, durationMs: 0 },
        flowExecution: { ok: false, durationMs: 0 },
        followupPlanning: { ok: false, durationMs: 0 },
      },
    };

    try {
      // Phase 1: Evidence Collection
      const phase1Start = now();
      try {
        const evidence = await this.options.evidenceProvider(task, signal);
        result.phases.evidenceCollection = {
          ok: true,
          data: evidence,
          durationMs: now() - phase1Start,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        result.phases.evidenceCollection = {
          ok: false,
          error: msg,
          durationMs: now() - phase1Start,
        };
        throw new Error(`Evidence collection failed: ${msg}`);
      }

      // Phase 2: Flow Execution (Verification & Merge)
      const phase2Start = now();
      try {
        const evidence = result.phases.evidenceCollection.data;
        if (!evidence) {
          throw new Error('Internal error: evidence data missing after successful collection');
        }
        let flowResult: FlowResult;

        if (task.source === 'user') {
          flowResult = await runUserFlow({
            topic: task.topic,
            evidence,
            repository: this.options.repository,
            userBudget: this.options.budget.userBudget,
            now: now(),
          });
        } else {
          // cron mode (default)
          flowResult = await runCronFlow({
            topic: task.topic,
            evidence,
            repository: this.options.repository,
            cronBudget: this.options.budget.cronBudget,
            cronRunBudget: this.options.budget.cronRunBudget,
            cronRunConsumed: this.options.cronRunConsumed,
            now: now(),
            evaluateRegistration: this.options.evaluateRegistration,
          });
        }

        result.phases.flowExecution = {
          ok: true,
          data: flowResult,
          durationMs: now() - phase2Start,
        };
        result.ok = true; // Phase 2 まで成功すれば、タスク全体は成功とみなす
        result.summary = flowResult.summary;

        // メトリクス記録
        this.options.metrics.record({
          taskId: task.id,
          source: task.source,
          ok: true,
          changed: flowResult.changed,
          retries: task.attempts,
          acceptedClaims: flowResult.acceptedClaims,
          rejectedClaims: flowResult.rejectedClaims,
          conflicts: flowResult.conflicts,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        result.phases.flowExecution = {
          ok: false,
          error: msg,
          durationMs: now() - phase2Start,
        };
        throw new Error(`Flow execution failed: ${msg}`);
      }

      // Phase 3: Follow-up Planning (Best-effort)
      const phase3Start = now();
      const flowResult = result.phases.flowExecution.data;
      if (!flowResult) {
        throw new Error('Internal error: flow execution result missing');
      }
      try {
        const planned = await this.options.gapPlanner.planAndEnqueueSafe(
          task,
          flowResult.gaps,
          signal,
        );
        result.phases.followupPlanning = {
          ok: true,
          data: { plannedTasks: planned.plannedTasks, hadErrors: planned.hadErrors },
          durationMs: now() - phase3Start,
        };
        result.summary += `; followups=${planned.plannedTasks}${
          planned.hadErrors ? ' (with errors)' : ''
        }`;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger({
          event: 'pipeline.followup.error',
          taskId: task.id,
          message: `Follow-up planning failed but task is kept as success: ${msg}`,
          level: 'warn',
        });
        result.phases.followupPlanning = {
          ok: false,
          error: msg,
          data: { plannedTasks: 0, hadErrors: true },
          durationMs: now() - phase3Start,
        };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.ok = false;
      result.summary = msg;

      this.options.metrics.record({
        taskId: task.id,
        source: task.source,
        ok: false,
        retries: task.attempts,
        acceptedClaims: 0,
        rejectedClaims: 0,
        conflicts: 0,
      });

      logger({
        event: 'pipeline.error',
        taskId: task.id,
        message: msg,
        level: 'error',
      });
    }

    return result;
  }
}
