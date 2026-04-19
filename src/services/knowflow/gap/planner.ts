import { type LlmLogEvent, runLlmTask } from '../../../adapters/llm.js';
import type { LlmClientConfig } from '../../../config.js';
import type { TopicTask } from '../domain/task.js';
import type { QueueRepository } from '../queue/repository.js';
import type { DetectedGap } from './detector.js';

export type GapPlannerOptions = {
  repository?: QueueRepository;
  llmConfig?: Partial<LlmClientConfig>;
  llmLogger?: (event: LlmLogEvent) => void;
  maxTasksPerGap?: number;
  priorityDecay?: number;
};

export class GapPlanner {
  constructor(private options: GapPlannerOptions) {}

  /**
   * 検出されたギャップに基づき、新しいタスクを計画してエンキューする
   */
  async planAndEnqueue(
    parentTask: TopicTask,
    gaps: DetectedGap[],
    signal?: AbortSignal,
  ): Promise<{ plannedTasks: number }> {
    const logger = this.options.llmLogger;
    const maxTasks = this.options.maxTasksPerGap ?? 2;
    const decay = this.options.priorityDecay ?? 0.8;

    if (!this.options.repository) {
      return { plannedTasks: 0 };
    }

    // 優先度の高いギャップを上位から処理
    const importantGaps = gaps.filter((g) => g.priority >= 0.5).slice(0, 3);
    if (importantGaps.length === 0) {
      return { plannedTasks: 0 };
    }

    let totalPlanned = 0;

    for (const gap of importantGaps) {
      if (signal?.aborted) break;

      try {
        const result = await runLlmTask(
          {
            task: 'gap_planner',
            context: {
              topic: parentTask.topic,
              gap_type: gap.type,
              gap_description: gap.description,
            },
            requestId: parentTask.id,
          },
          {
            config: this.options.llmConfig,
            deps: logger ? { logger } : undefined,
            signal,
          },
        );

        const steps = result.output.steps.slice(0, maxTasks);
        for (const step of steps) {
          if (step.queries.length === 0) continue;

          // 新しいタスクの優先度を親より少し下げる
          const newPriority = Math.max(1, Math.floor(parentTask.priority * decay));

          // 最初のステップのクエリを使用して、トピックのさらなる深掘りタスクをエンキュー
          const mode = parentTask.mode === 'directed' ? 'expand' : 'explore';

          await this.options.repository.enqueue({
            topic: parentTask.topic,
            mode,
            source: 'cron',
            priority: newPriority,
          });

          if (logger) {
            logger({
              event: 'gap_planner.enqueued',
              task: 'gap_planner',
              requestId: parentTask.id,
              message: `Enqueued ${mode} task for topic: ${parentTask.topic}`,
              // Adding missing fields required by LlmLogEvent if necessary,
              // but LlmLogEvent should be flexible enough now.
            });
          }

          totalPlanned += 1;
        }
      } catch (error) {
        if (logger) {
          logger({
            event: 'gap_planner.error',
            task: 'gap_planner',
            requestId: parentTask.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return { plannedTasks: totalPlanned };
  }

  /**
   * 安全なギャップ計画（Best-effort）。失敗時はルールベースでフォールバック。
   */
  async planAndEnqueueSafe(
    parentTask: TopicTask,
    gaps: DetectedGap[],
    signal?: AbortSignal,
  ): Promise<{ plannedTasks: number; hadErrors: boolean }> {
    try {
      const result = await this.planAndEnqueue(parentTask, gaps, signal);
      if (result.plannedTasks > 0) {
        return { ...result, hadErrors: false };
      }
      // LLM がタスクを生成できなかった場合もフォールバックを試みる
      return await this.fallbackPlan(parentTask, gaps);
    } catch (error) {
      return await this.fallbackPlan(parentTask, gaps);
    }
  }

  private async fallbackPlan(
    parentTask: TopicTask,
    gaps: DetectedGap[],
  ): Promise<{ plannedTasks: number; hadErrors: boolean }> {
    const logger = this.options.llmLogger;
    const decay = this.options.priorityDecay ?? 0.8;

    // 非常に重要なギャップがあれば、LLMなしでも1つだけ強行エンキューする
    const criticalGaps = gaps.filter((g) => g.priority >= 0.7);
    if (criticalGaps.length === 0 || !this.options.repository) {
      return { plannedTasks: 0, hadErrors: true };
    }

    const newPriority = Math.max(1, Math.floor(parentTask.priority * decay));
    await this.options.repository.enqueue({
      topic: parentTask.topic,
      mode: 'expand', // 明示的な深掘りを選択
      source: 'cron',
      priority: newPriority,
    });

    if (logger) {
      logger({
        event: 'gap_planner.fallback_enqueued',
        task: 'gap_planner',
        requestId: parentTask.id,
        message: `Reason: No important gaps or LLM failure. Enqueued fallback 'expand' for ${parentTask.topic}`,
      });
    }

    return { plannedTasks: 1, hadErrors: true };
  }
}
