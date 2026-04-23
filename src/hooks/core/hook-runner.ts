import {
  HookActionExecutionError,
  type HookActionExecutorDeps,
  createInitialActionState,
  executeHookAction,
} from './action-executor.js';
import { evaluateHookConditions } from './condition-evaluator.js';
import { PgHookExecutionRepository } from './execution-repository.js';
import type {
  HookDispatchResult,
  HookEventContext,
  HookEventEnvelope,
  HookExecutionRepository,
  HookRule,
  HookRuleExecutionResult,
} from './hook-types.js';

export type HookRunnerDeps = {
  evaluateConditions?: typeof evaluateHookConditions;
  executeAction?: typeof executeHookAction;
  actionExecutorDeps?: HookActionExecutorDeps;
  executionRepository?: HookExecutionRepository;
  logger?: (payload: Record<string, unknown>) => void;
};

function byPriorityDesc(a: HookRule, b: HookRule): number {
  return b.priority - a.priority;
}

function normalizeRules(rules: HookRule[], eventName: string): HookRule[] {
  return rules.filter((rule) => rule.enabled && rule.event === eventName).sort(byPriorityDesc);
}

function mapError(error: unknown): { code: string; message: string } {
  if (error instanceof HookActionExecutionError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof Error) {
    return {
      code: 'HOOK_ACTION_ERROR',
      message: error.message,
    };
  }
  return {
    code: 'HOOK_ACTION_ERROR',
    message: String(error),
  };
}

export async function runHookRules(
  event: HookEventEnvelope,
  context: HookEventContext,
  rules: HookRule[],
  deps: HookRunnerDeps = {},
): Promise<HookDispatchResult> {
  const evaluateConditions = deps.evaluateConditions ?? evaluateHookConditions;
  const executeAction = deps.executeAction ?? executeHookAction;
  const executionRepository = deps.executionRepository ?? new PgHookExecutionRepository();

  const targetedRules = normalizeRules(rules, event.event);
  const ruleResults: HookRuleExecutionResult[] = [];
  const allGuidance: string[] = [];
  const allWarnings: string[] = [];
  const riskTagSet = new Set(context.riskTags ?? []);
  const candidateIds: string[] = [];
  let blocked = false;

  for (const rule of targetedRules) {
    const evalResult = evaluateConditions(rule.conditions, {
      ...context,
      riskTags: [...riskTagSet],
    });

    if (!evalResult.matched) {
      ruleResults.push({
        ruleId: rule.id,
        status: 'skipped',
        matched: false,
        reason: evalResult.reason,
        actions: [],
        guidance: [],
        warnings: [],
        riskTagsAdded: [],
        candidateIds: [],
      });
      continue;
    }

    const startResult = await executionRepository.tryStartExecution({
      eventId: event.eventId,
      ruleId: rule.id,
      traceId: event.traceId,
    });

    if (!startResult.started) {
      ruleResults.push({
        ruleId: rule.id,
        status: 'skipped',
        matched: true,
        reason: 'duplicate event/rule execution skipped',
        actions: [],
        guidance: [],
        warnings: [],
        riskTagsAdded: [],
        candidateIds: [],
      });
      continue;
    }

    const actionState = createInitialActionState();
    const actionResults: HookRuleExecutionResult['actions'] = [];
    let resultStatus: HookRuleExecutionResult['status'] = 'succeeded';
    let resultReason: string | undefined;

    try {
      for (const action of rule.actions) {
        const actionResult = await executeAction(
          action,
          {
            event,
            context: {
              ...context,
              riskTags: [...riskTagSet],
            },
            rule,
            state: actionState,
          },
          deps.actionExecutorDeps,
        );
        actionResults.push(actionResult);
      }

      for (const tag of actionState.riskTagsAdded) {
        riskTagSet.add(tag);
      }
      allGuidance.push(...actionState.guidance);
      allWarnings.push(...actionState.warnings);
      candidateIds.push(...actionState.candidateIds);

      await executionRepository.completeExecution({
        eventId: event.eventId,
        ruleId: rule.id,
        status: 'succeeded',
        metadata: {
          actionCount: actionResults.length,
          riskTagsAdded: actionState.riskTagsAdded,
          candidateIds: actionState.candidateIds,
        },
      });
    } catch (error) {
      const mapped = mapError(error);
      const strategy = rule.on_failure?.strategy ?? 'soft_warn';
      const fallbackGuidance = rule.on_failure?.guidance;

      if (strategy === 'ignore') {
        resultStatus = 'ignored';
      }

      if (strategy === 'soft_warn') {
        resultStatus = 'failed';
        allWarnings.push(fallbackGuidance ?? mapped.message);
      }

      if (strategy === 'block_with_guidance') {
        resultStatus = 'blocked';
        blocked = true;
        allGuidance.push(fallbackGuidance ?? mapped.message);
      }

      if (strategy === 'block_progress') {
        resultStatus = 'blocked';
        blocked = true;
        allGuidance.push(fallbackGuidance ?? mapped.message);
      }

      resultReason = `${mapped.code}: ${mapped.message}`;

      await executionRepository.completeExecution({
        eventId: event.eventId,
        ruleId: rule.id,
        status:
          resultStatus === 'blocked'
            ? 'blocked'
            : resultStatus === 'ignored'
              ? 'skipped'
              : 'failed',
        errorMessage: resultReason,
        metadata: {
          strategy,
          actionCount: actionResults.length,
        },
      });

      deps.logger?.({
        event: 'hook.rule.error',
        ruleId: rule.id,
        traceId: event.traceId,
        eventId: event.eventId,
        strategy,
        error: resultReason,
      });
    }

    ruleResults.push({
      ruleId: rule.id,
      status: resultStatus,
      matched: true,
      reason: resultReason,
      actions: actionResults,
      guidance: [...actionState.guidance],
      warnings: [...actionState.warnings],
      riskTagsAdded: [...actionState.riskTagsAdded],
      candidateIds: [...actionState.candidateIds],
    });
  }

  return {
    eventId: event.eventId,
    traceId: event.traceId,
    blocked,
    guidance: allGuidance,
    warnings: allWarnings,
    riskTags: [...riskTagSet],
    candidateIds,
    ruleResults,
  };
}
