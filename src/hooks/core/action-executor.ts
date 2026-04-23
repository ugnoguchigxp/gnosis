import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { db as defaultDb } from '../../db/index.js';
import { hookCandidates } from '../../db/schema.js';
import type {
  HookAction,
  HookActionExecution,
  HookEventContext,
  HookEventEnvelope,
  HookRule,
} from './hook-types.js';

type DbLike = Pick<typeof defaultDb, 'insert'>;

type RunCommandResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export type HookActionExecutionState = {
  guidance: string[];
  warnings: string[];
  riskTagsAdded: string[];
  candidateIds: string[];
  commandResults: RunCommandResult[];
};

export type HookActionExecutorDeps = {
  database?: DbLike;
  now?: () => number;
  defaultTimeoutSec?: number;
  maxTimeoutSec?: number;
  emitMonitorEvent?: (payload: Record<string, unknown>) => Promise<void>;
  enqueueReview?: (payload: {
    traceId: string;
    taskId?: string;
    profile?: string;
    include?: string[];
  }) => Promise<{ queued: boolean; requestId?: string }>;
};

export class HookActionExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HookActionExecutionError';
  }
}

function summarizeOutput(stdout: string, stderr: string): string {
  const maxLen = 5000;
  const merged = `${stdout}\n${stderr}`.trim();
  if (merged.length <= maxLen) {
    return merged;
  }
  return `${merged.slice(0, maxLen)}\n...(truncated)`;
}

async function runCommandWithTimeout(
  command: string,
  options: { cwd: string; timeoutMs: number },
): Promise<RunCommandResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;

  const child = spawn(command, {
    cwd: options.cwd,
    shell: true,
    signal: controller.signal,
    env: process.env,
  });

  let stdout = '';
  let stderr = '';
  const MAX_CAPTURE = 200_000;

  child.stdout.on('data', (chunk) => {
    if (stdout.length < MAX_CAPTURE) {
      stdout += chunk.toString('utf8');
    }
  });

  child.stderr.on('data', (chunk) => {
    if (stderr.length < MAX_CAPTURE) {
      stderr += chunk.toString('utf8');
    }
  });

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', (error) => {
      if (timedOut && error.name === 'AbortError') {
        resolve(null);
        return;
      }
      reject(error);
    });
    child.once('close', (code) => resolve(code));
  }).finally(() => {
    clearTimeout(timeoutHandle);
  });

  return {
    command,
    exitCode,
    stdout,
    stderr,
    timedOut,
    durationMs: Date.now() - startedAt,
  };
}

async function createHookCandidate(options: {
  database: DbLike;
  kind: 'episode' | 'lesson';
  traceId: string;
  sourceEvent: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  severity?: 'low' | 'medium' | 'high';
}): Promise<string | null> {
  const inserted = await options.database
    .insert(hookCandidates)
    .values({
      kind: options.kind,
      status: 'pending',
      traceId: options.traceId,
      sourceEvent: options.sourceEvent,
      dedupeKey: options.dedupeKey,
      payload: options.payload,
      severity: options.severity,
    })
    .onConflictDoNothing()
    .returning({ id: hookCandidates.id });

  return inserted[0]?.id ?? null;
}

export async function executeHookAction(
  action: HookAction,
  input: {
    event: HookEventEnvelope;
    context: HookEventContext;
    rule: HookRule;
    state: HookActionExecutionState;
  },
  deps: HookActionExecutorDeps = {},
): Promise<HookActionExecution> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const database = deps.database ?? defaultDb;

  if (action.type === 'run_command') {
    const defaultTimeoutSec = deps.defaultTimeoutSec ?? config.hooks.actionTimeoutSecDefault;
    const maxTimeoutSec = deps.maxTimeoutSec ?? config.hooks.actionTimeoutSecMax;
    const timeoutSec = action.timeout_sec ?? defaultTimeoutSec;

    if (timeoutSec > maxTimeoutSec) {
      throw new HookActionExecutionError(
        'HOOK_TIMEOUT_LIMIT_EXCEEDED',
        `timeout_sec exceeds max limit (${maxTimeoutSec}): ${timeoutSec}`,
      );
    }

    const cwd = action.cwd ?? input.context.cwd ?? process.cwd();
    const result = await runCommandWithTimeout(action.command, {
      cwd,
      timeoutMs: timeoutSec * 1000,
    });

    if (result.timedOut) {
      throw new HookActionExecutionError(
        'HOOK_ACTION_TIMEOUT',
        `Command timed out after ${timeoutSec}s: ${action.command}`,
      );
    }

    if (result.exitCode !== 0) {
      throw new HookActionExecutionError(
        'HOOK_COMMAND_FAILED',
        `Command failed (${result.exitCode}): ${action.command}\n${summarizeOutput(
          result.stdout,
          result.stderr,
        )}`,
      );
    }

    input.state.commandResults.push(result);

    return {
      actionType: action.type,
      ok: true,
      durationMs: result.durationMs,
      output: summarizeOutput(result.stdout, result.stderr),
    };
  }

  if (action.type === 'emit_monitor_event') {
    await deps.emitMonitorEvent?.({
      event: action.event_name ?? 'hook.action.executed',
      traceId: input.event.traceId,
      eventId: input.event.eventId,
      taskId: input.event.taskId,
      ruleId: input.rule.id,
      sourceEvent: input.event.event,
      include_output: action.include_output ?? false,
      include_duration: action.include_duration ?? false,
      include_reason: action.include_reason ?? false,
      include_summary: action.include_summary ?? false,
      include_payload_summary: action.include_payload_summary ?? false,
      runId: input.event.runId,
      gateName: input.rule.id,
      riskTags: [...new Set([...(input.context.riskTags ?? []), ...input.state.riskTagsAdded])],
      candidateIds: input.state.candidateIds,
      resultSummary: action.include_summary
        ? `${input.rule.id} completed with ${input.state.commandResults.length} command(s)`
        : undefined,
      message: action.include_reason
        ? typeof input.event.payload?.failureReason === 'string'
          ? input.event.payload.failureReason
          : undefined
        : undefined,
      payload: {
        commandResults: action.include_output
          ? input.state.commandResults.map((result) => ({
              command: result.command,
              durationMs: result.durationMs,
              output: summarizeOutput(result.stdout, result.stderr),
            }))
          : undefined,
        durationMs: action.include_duration
          ? input.state.commandResults.reduce((total, result) => total + result.durationMs, 0)
          : undefined,
        payloadSummary: action.include_payload_summary ? input.event.payload ?? {} : undefined,
      },
    });

    return {
      actionType: action.type,
      ok: true,
      durationMs: now() - startedAt,
    };
  }

  if (action.type === 'add_guidance') {
    input.state.guidance.push(action.guidance);
    return {
      actionType: action.type,
      ok: true,
      durationMs: now() - startedAt,
      message: action.guidance,
    };
  }

  if (action.type === 'tag_risk') {
    input.state.riskTagsAdded.push(action.risk_tag);
    return {
      actionType: action.type,
      ok: true,
      durationMs: now() - startedAt,
      message: action.risk_tag,
    };
  }

  if (action.type === 'enqueue_review') {
    const queued = await deps.enqueueReview?.({
      traceId: input.event.traceId,
      taskId: input.event.taskId,
      profile: action.review_profile,
      include: action.include,
    });

    return {
      actionType: action.type,
      ok: true,
      durationMs: now() - startedAt,
      message: queued?.queued
        ? `queued:${queued.requestId ?? 'true'}`
        : 'enqueue handler not configured',
    };
  }

  if (action.type === 'create_episode_candidate') {
    const candidateId = await createHookCandidate({
      database,
      kind: 'episode',
      traceId: input.event.traceId,
      sourceEvent: input.event.event,
      dedupeKey: `${input.event.traceId}:episode:${action.episode_kind}`,
      payload: {
        episodeKind: action.episode_kind,
        include: action.include ?? [],
        traceId: input.event.traceId,
        runId: input.event.runId,
        taskId: input.event.taskId,
        ruleId: input.rule.id,
        eventId: input.event.eventId,
        sourceEvent: input.event.event,
        eventPayload: input.event.payload ?? {},
        context: input.context,
        guidance: input.state.guidance,
        warnings: input.state.warnings,
        commandResults: input.state.commandResults.map((result) => ({
          command: result.command,
          durationMs: result.durationMs,
          output: summarizeOutput(result.stdout, result.stderr),
        })),
      },
      severity: action.episode_kind === 'failure' ? 'high' : 'low',
    });

    if (candidateId) {
      input.state.candidateIds.push(candidateId);
    }

    return {
      actionType: action.type,
      ok: true,
      durationMs: now() - startedAt,
      message: candidateId ?? 'candidate deduped',
    };
  }

  if (action.type === 'create_lesson_candidate') {
    const candidateId = await createHookCandidate({
      database,
      kind: 'lesson',
      traceId: input.event.traceId,
      sourceEvent: input.event.event,
      dedupeKey: `${input.event.traceId}:lesson:${action.source ?? 'hook'}`,
      payload: {
        source: action.source ?? 'hook',
        minSeverity: action.min_severity,
        traceId: input.event.traceId,
        runId: input.event.runId,
        taskId: input.event.taskId,
        ruleId: input.rule.id,
        eventId: input.event.eventId,
        sourceEvent: input.event.event,
        eventPayload: input.event.payload ?? {},
        context: input.context,
        guidance: input.state.guidance,
        warnings: input.state.warnings,
        commandResults: input.state.commandResults.map((result) => ({
          command: result.command,
          durationMs: result.durationMs,
          output: summarizeOutput(result.stdout, result.stderr),
        })),
      },
      severity: action.min_severity,
    });

    if (candidateId) {
      input.state.candidateIds.push(candidateId);
    }

    return {
      actionType: action.type,
      ok: true,
      durationMs: now() - startedAt,
      message: candidateId ?? 'candidate deduped',
    };
  }

  if (action.type === 'block_progress') {
    throw new HookActionExecutionError(
      'HOOK_BLOCK_PROGRESS',
      action.reason ?? 'Progress blocked by hook rule',
    );
  }

  if (action.type === 'soft_warn') {
    const message = action.message ?? 'Soft warning emitted by hook rule';
    input.state.warnings.push(message);
    return {
      actionType: action.type,
      ok: true,
      durationMs: now() - startedAt,
      message,
    };
  }

  throw new HookActionExecutionError(
    'HOOK_ACTION_UNSUPPORTED',
    `Unsupported action type: ${(action as { type: string }).type}`,
  );
}

export function createInitialActionState(): HookActionExecutionState {
  return {
    guidance: [],
    warnings: [],
    riskTagsAdded: [],
    candidateIds: [],
    commandResults: [],
  };
}

export function createEventEnvelope(input: {
  event: string;
  traceId: string;
  eventId?: string;
  runId?: string;
  taskId?: string;
  payload?: Record<string, unknown>;
}): HookEventEnvelope {
  return {
    eventId: input.eventId ?? randomUUID(),
    event: input.event,
    traceId: input.traceId,
    runId: input.runId,
    taskId: input.taskId,
    ts: new Date().toISOString(),
    payload: input.payload,
  };
}
