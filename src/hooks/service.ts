import { randomUUID } from 'node:crypto';
import { type FSWatcher, existsSync, watch } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { config } from '../config.js';
import { createEventEnvelope } from './core/action-executor.js';
import { FileChangeAggregator } from './core/file-change-aggregator.js';
import { HookBus } from './core/hook-bus.js';
import type { HookDispatchResult, HookEventContext, HookRule } from './core/hook-types.js';
import { loadHookRulesFromDirectory } from './core/rule-loader.js';
import { promoteHookCandidates } from './integrations/candidate-hook-bridge.js';
import { emitHookMonitorEvent } from './integrations/monitor-hook-reporter.js';
import { enqueueHookReview } from './integrations/review-hook-bridge.js';

type TraceRuntimeState = {
  riskTags: Set<string>;
  lastHookResult?: string;
  updatedAt: number;
};

const DEFAULT_HOOKS_CONFIG = {
  enabled: false,
  rulesDir: path.resolve(process.cwd(), 'src/hooks/rules'),
  fileChangedDebounceMs: 10_000,
  actionTimeoutSecDefault: 120,
  actionTimeoutSecMax: 900,
  executionCacheSize: 2_000,
};

function getHooksConfig() {
  return {
    ...DEFAULT_HOOKS_CONFIG,
    ...(config.hooks ?? {}),
  };
}

const traceState = new Map<string, TraceRuntimeState>();
const fileChangeAggregator = new FileChangeAggregator({
  debounceMs: getHooksConfig().fileChangedDebounceMs,
  dispatcher: async ({ envelope, context }) => {
    const bus = await ensureHookBus();
    if (!bus) {
      return {
        eventId: envelope.eventId,
        traceId: envelope.traceId,
        blocked: false,
        guidance: [],
        warnings: [],
        riskTags: context.riskTags ?? [],
        candidateIds: [],
        ruleResults: [],
      };
    }

    const resolvedContext = await buildEffectiveContext(envelope.traceId, context);
    return dispatchResolvedEvent(bus, envelope, resolvedContext);
  },
});

let cachedRules: HookRule[] | null = null;
let cachedBus: HookBus | null = null;
let loadingPromise: Promise<void> | null = null;
let rulesWatcher: FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

async function emitMonitorActionPayload(payload: Record<string, unknown>): Promise<void> {
  const traceId = typeof payload.traceId === 'string' ? payload.traceId : 'unknown';
  await emitHookMonitorEvent({
    event: typeof payload.event === 'string' ? payload.event : 'hook.action.executed',
    traceId,
    runId: typeof payload.runId === 'string' ? payload.runId : undefined,
    taskId: typeof payload.taskId === 'string' ? payload.taskId : undefined,
    ruleId: typeof payload.ruleId === 'string' ? payload.ruleId : undefined,
    gateName: typeof payload.gateName === 'string' ? payload.gateName : undefined,
    riskTags: Array.isArray(payload.riskTags)
      ? payload.riskTags.filter((value): value is string => typeof value === 'string')
      : [],
    candidateIds: Array.isArray(payload.candidateIds)
      ? payload.candidateIds.filter((value): value is string => typeof value === 'string')
      : [],
    resultSummary: typeof payload.resultSummary === 'string' ? payload.resultSummary : undefined,
    errorReason: typeof payload.errorReason === 'string' ? payload.errorReason : undefined,
    message: typeof payload.message === 'string' ? payload.message : undefined,
    payload,
  });
}

function cleanupTraceStateIfNeeded(): void {
  const hooksConfig = getHooksConfig();
  if (traceState.size <= hooksConfig.executionCacheSize) return;
  const entries = [...traceState.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const removeCount = Math.max(1, entries.length - hooksConfig.executionCacheSize);
  for (const [traceId] of entries.slice(0, removeCount)) {
    traceState.delete(traceId);
  }
}

async function detectGitContext(cwd: string): Promise<{
  changedFiles: string[];
  changedLines: number;
  branchName?: string;
}> {
  const git = simpleGit(cwd);

  try {
    const [unstaged, staged, branchInfo, numstat] = await Promise.all([
      git.diff(['--name-only', '--diff-filter=ACMRTUXB']),
      git.diff(['--name-only', '--cached', '--diff-filter=ACMRTUXB']),
      git.branchLocal(),
      git.diff(['--numstat', '--diff-filter=ACMRTUXB']),
    ]);

    const changedFiles = [
      ...new Set(
        `${unstaged}\n${staged}`
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];

    const changedLines = numstat
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .reduce((acc, line) => {
        const [added, removed] = line.split('\t');
        const addNum = added === '-' ? 0 : Number(added);
        const remNum = removed === '-' ? 0 : Number(removed);
        return (
          acc + (Number.isFinite(addNum) ? addNum : 0) + (Number.isFinite(remNum) ? remNum : 0)
        );
      }, 0);

    return {
      changedFiles,
      changedLines,
      branchName: branchInfo.current || undefined,
    };
  } catch {
    return {
      changedFiles: [],
      changedLines: 0,
      branchName: undefined,
    };
  }
}

function detectProjectType(cwd: string): string | undefined {
  if (existsSync(path.join(cwd, 'tsconfig.json'))) {
    return 'typescript';
  }
  return undefined;
}

async function ensureHookBus(): Promise<HookBus | null> {
  const hooksConfig = getHooksConfig();
  if (!hooksConfig.enabled) {
    return null;
  }

  if (cachedBus) {
    return cachedBus;
  }

  if (loadingPromise) {
    await loadingPromise;
    return cachedBus;
  }

  loadingPromise = (async () => {
    const rules = await loadHookRulesFromDirectory(hooksConfig.rulesDir);
    cachedRules = rules;
    cachedBus = new HookBus({
      rules,
      runnerDeps: {
        actionExecutorDeps: {
          emitMonitorEvent: emitMonitorActionPayload,
          enqueueReview: enqueueHookReview,
        },
        logger: (payload) => {
          void emitHookMonitorEvent({
            event: typeof payload.event === 'string' ? payload.event : 'hook.rule.error',
            traceId: typeof payload.traceId === 'string' ? payload.traceId : 'unknown',
            taskId: typeof payload.taskId === 'string' ? payload.taskId : undefined,
            ruleId: typeof payload.ruleId === 'string' ? payload.ruleId : undefined,
            gateName: typeof payload.ruleId === 'string' ? payload.ruleId : undefined,
            errorReason: typeof payload.error === 'string' ? payload.error : undefined,
            payload,
          });
        },
      },
    });
    ensureRuleWatcher();
  })();

  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
  }

  return cachedBus;
}

export async function reloadHookRules(): Promise<{ count: number }> {
  const rules = await loadHookRulesFromDirectory(getHooksConfig().rulesDir);
  cachedRules = rules;
  if (!cachedBus) {
    cachedBus = new HookBus({
      rules,
      runnerDeps: {
        actionExecutorDeps: {
          emitMonitorEvent: emitMonitorActionPayload,
          enqueueReview: enqueueHookReview,
        },
      },
    });
  } else {
    cachedBus.setRules(rules);
  }
  return { count: rules.length };
}

function ensureRuleWatcher(): void {
  if (process.env.NODE_ENV === 'production' || rulesWatcher) {
    return;
  }

  try {
    rulesWatcher = watch(getHooksConfig().rulesDir, { recursive: true }, () => {
      if (reloadTimer) {
        clearTimeout(reloadTimer);
      }
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void reloadHookRules().catch((error) => {
          console.error('[HookService] Failed to reload hook rules:', error);
        });
      }, 250);
    });
  } catch (error) {
    console.error('[HookService] Rule watcher disabled:', error);
  }
}

function shouldFlushBufferedFileChanges(event: string): boolean {
  return (
    event === 'task.segment.completed' ||
    event === 'task.ready_for_review' ||
    event === 'task.completed' ||
    event === 'task.failed' ||
    event === 'review.completed'
  );
}

async function buildEffectiveContext(
  traceId: string,
  inputContext: HookEventContext | undefined,
): Promise<HookEventContext> {
  const cwd = inputContext?.cwd ?? process.cwd();
  const gitContext = await detectGitContext(cwd);
  const projectType = inputContext?.projectType ?? detectProjectType(cwd);

  const existingTraceState = traceState.get(traceId);
  const mergedRiskTags = new Set([
    ...(existingTraceState ? [...existingTraceState.riskTags] : []),
    ...(inputContext?.riskTags ?? []),
  ]);

  return {
    ...inputContext,
    cwd,
    projectType,
    changedFiles: inputContext?.changedFiles ?? gitContext.changedFiles,
    changedLines: inputContext?.changedLines ?? gitContext.changedLines,
    branchName: inputContext?.branchName ?? gitContext.branchName,
    riskTags: [...mergedRiskTags],
    lastHookResult: inputContext?.lastHookResult ?? existingTraceState?.lastHookResult,
  };
}

async function dispatchResolvedEvent(
  bus: HookBus,
  envelope: ReturnType<typeof createEventEnvelope>,
  context: HookEventContext,
): Promise<HookDispatchResult> {
  await emitHookMonitorEvent({
    event: 'hook.event.received',
    traceId: envelope.traceId,
    runId: envelope.runId,
    taskId: envelope.taskId,
    gateName: envelope.event,
    riskTags: context.riskTags ?? [],
    payload: {
      eventId: envelope.eventId,
      changedFiles: context.changedFiles ?? [],
      changedLines: context.changedLines ?? 0,
    },
  });

  const result = await bus.dispatch(envelope, context);

  const latestStatus = result.ruleResults.at(-1)?.status;
  traceState.set(envelope.traceId, {
    riskTags: new Set(result.riskTags),
    lastHookResult: latestStatus,
    updatedAt: Date.now(),
  });
  cleanupTraceStateIfNeeded();

  await emitHookMonitorEvent({
    event: 'hook.event.completed',
    traceId: envelope.traceId,
    runId: envelope.runId,
    taskId: envelope.taskId,
    gateName: envelope.event,
    riskTags: result.riskTags,
    candidateIds: result.candidateIds,
    resultSummary: `${envelope.event} blocked=${result.blocked} rules=${result.ruleResults.length}`,
    errorReason: result.blocked ? result.guidance.join(' | ') : undefined,
    payload: {
      eventId: result.eventId,
      guidance: result.guidance,
      warnings: result.warnings,
      ruleResults: result.ruleResults,
    },
  });

  return result;
}

export async function bufferFileChangedEvents(input: {
  traceId?: string;
  runId?: string;
  taskId?: string;
  changedFiles: string[];
  changedLines?: number;
  context?: HookEventContext;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const traceId = input.traceId ?? randomUUID();
  for (const filePath of input.changedFiles) {
    await dispatchHookEvent({
      event: 'file.changed',
      traceId,
      runId: input.runId,
      taskId: input.taskId,
      context: {
        ...input.context,
        changedFiles: [filePath],
        changedLines: input.changedLines,
      },
      payload: {
        ...input.payload,
        path: filePath,
      },
    });
  }
}

export async function promotePendingHookCandidates(limit = 20): Promise<{
  processed: number;
  promoted: number;
  rejected: number;
}> {
  return promoteHookCandidates(limit);
}

export async function dispatchHookEvent(input: {
  event: string;
  traceId?: string;
  eventId?: string;
  runId?: string;
  taskId?: string;
  payload?: Record<string, unknown>;
  context?: HookEventContext;
}): Promise<HookDispatchResult> {
  const bus = await ensureHookBus();
  const traceId = input.traceId ?? randomUUID();

  const noOpEnvelope = createEventEnvelope({
    event: input.event,
    eventId: input.eventId,
    traceId,
    runId: input.runId,
    taskId: input.taskId,
    payload: input.payload,
  });

  if (!bus) {
    return {
      eventId: noOpEnvelope.eventId,
      traceId,
      blocked: false,
      guidance: [],
      warnings: ['Hooks are disabled (GNOSIS_HOOKS_ENABLED=false).'],
      riskTags: input.context?.riskTags ?? [],
      candidateIds: [],
      ruleResults: [],
    };
  }

  const resolvedContext = await buildEffectiveContext(traceId, input.context);

  if (input.event === 'file.changed') {
    await fileChangeAggregator.enqueue({
      envelope: noOpEnvelope,
      context: resolvedContext,
    });
    await emitHookMonitorEvent({
      event: 'hook.file_change.buffered',
      traceId,
      runId: input.runId,
      taskId: input.taskId,
      gateName: input.event,
      riskTags: resolvedContext.riskTags ?? [],
      payload: {
        eventId: noOpEnvelope.eventId,
        path:
          resolvedContext.changedFiles?.[0] ??
          (typeof noOpEnvelope.payload?.path === 'string' ? noOpEnvelope.payload.path : undefined),
      },
    });

    return {
      eventId: noOpEnvelope.eventId,
      traceId,
      blocked: false,
      guidance: [],
      warnings: [],
      riskTags: resolvedContext.riskTags ?? [],
      candidateIds: [],
      ruleResults: [],
    };
  }

  if (shouldFlushBufferedFileChanges(input.event)) {
    await fileChangeAggregator.flushTrace(traceId);
  }

  return dispatchResolvedEvent(bus, noOpEnvelope, resolvedContext);
}

export function getLoadedHookRuleCount(): number {
  return cachedRules?.length ?? 0;
}
