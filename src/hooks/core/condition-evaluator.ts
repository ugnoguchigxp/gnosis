import type { HookEventContext, HookRuleConditions } from './hook-types.js';

export type HookConditionEvaluation = {
  matched: boolean;
  reason?: string;
};

const escapeRegex = (input: string): string => input.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');

function wildcardToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  const escaped = escapeRegex(normalized)
    .replace(/\*\*/g, '___DOUBLE_WILDCARD___')
    .replace(/\*/g, '[^/]*')
    .replace(/___DOUBLE_WILDCARD___/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function pathMatchesAny(patterns: string[], changedFiles: string[]): boolean {
  if (patterns.length === 0) return true;
  if (changedFiles.length === 0) return false;

  return changedFiles.some((file) => {
    const normalized = file.replace(/\\/g, '/');
    return patterns.some((pattern) => wildcardToRegExp(pattern).test(normalized));
  });
}

function branchMatches(pattern: string, branchName?: string): boolean {
  if (!branchName) return false;
  return wildcardToRegExp(pattern).test(branchName);
}

export function evaluateHookConditions(
  conditions: HookRuleConditions | undefined,
  context: HookEventContext,
): HookConditionEvaluation {
  if (!conditions) {
    return { matched: true };
  }

  if (conditions.project_type && context.projectType !== conditions.project_type) {
    return { matched: false, reason: `project_type mismatch: expected=${conditions.project_type}` };
  }

  const changedFilesCount = context.changedFiles?.length ?? 0;
  if (
    typeof conditions.changed_files_min === 'number' &&
    changedFilesCount < conditions.changed_files_min
  ) {
    return {
      matched: false,
      reason: `changed_files_min unmet: expected>=${conditions.changed_files_min}, actual=${changedFilesCount}`,
    };
  }

  const changedLines = context.changedLines ?? 0;
  if (
    typeof conditions.changed_lines_min === 'number' &&
    changedLines < conditions.changed_lines_min
  ) {
    return {
      matched: false,
      reason: `changed_lines_min unmet: expected>=${conditions.changed_lines_min}, actual=${changedLines}`,
    };
  }

  if (
    conditions.path_matches &&
    !pathMatchesAny(conditions.path_matches, context.changedFiles ?? [])
  ) {
    return { matched: false, reason: 'path_matches not matched' };
  }

  if (conditions.risk_tags_contains && conditions.risk_tags_contains.length > 0) {
    const currentTags = new Set(context.riskTags ?? []);
    const hasIntersection = conditions.risk_tags_contains.some((tag) => currentTags.has(tag));
    if (!hasIntersection) {
      return { matched: false, reason: 'risk_tags_contains not matched' };
    }
  }

  if (conditions.branch_pattern && !branchMatches(conditions.branch_pattern, context.branchName)) {
    return { matched: false, reason: `branch_pattern mismatch: ${conditions.branch_pattern}` };
  }

  if (conditions.task_mode && conditions.task_mode.length > 0) {
    const mode = context.taskMode;
    if (!mode || !conditions.task_mode.includes(mode)) {
      return { matched: false, reason: `task_mode mismatch: ${mode ?? 'undefined'}` };
    }
  }

  if (
    typeof conditions.review_requested === 'boolean' &&
    (context.reviewRequested ?? false) !== conditions.review_requested
  ) {
    return {
      matched: false,
      reason: `review_requested mismatch: expected=${conditions.review_requested}, actual=${
        context.reviewRequested ?? false
      }`,
    };
  }

  if (conditions.last_hook_result && context.lastHookResult !== conditions.last_hook_result) {
    return {
      matched: false,
      reason: `last_hook_result mismatch: expected=${conditions.last_hook_result}, actual=${
        context.lastHookResult ?? 'undefined'
      }`,
    };
  }

  return { matched: true };
}
