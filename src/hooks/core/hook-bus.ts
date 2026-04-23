import { createEventEnvelope } from './action-executor.js';
import { type HookRunnerDeps, runHookRules } from './hook-runner.js';
import type {
  HookDispatchResult,
  HookEventContext,
  HookEventEnvelope,
  HookRule,
} from './hook-types.js';

export type HookBusOptions = {
  rules?: HookRule[];
  runnerDeps?: HookRunnerDeps;
};

export class HookBus {
  private rules: HookRule[];

  constructor(private readonly options: HookBusOptions = {}) {
    this.rules = options.rules ?? [];
  }

  setRules(rules: HookRule[]): void {
    this.rules = [...rules];
  }

  getRules(): HookRule[] {
    return [...this.rules];
  }

  async dispatch(event: HookEventEnvelope, context: HookEventContext): Promise<HookDispatchResult> {
    return runHookRules(event, context, this.rules, this.options.runnerDeps);
  }

  async dispatchByName(input: {
    event: string;
    traceId: string;
    eventId?: string;
    runId?: string;
    taskId?: string;
    payload?: Record<string, unknown>;
    context?: HookEventContext;
  }): Promise<HookDispatchResult> {
    const envelope = createEventEnvelope({
      event: input.event,
      traceId: input.traceId,
      eventId: input.eventId,
      runId: input.runId,
      taskId: input.taskId,
      payload: input.payload,
    });

    return this.dispatch(envelope, input.context ?? {});
  }
}
