import type { HookDispatchResult, HookEventContext, HookEventEnvelope } from './hook-types.js';

type PendingFileChange = {
  key: string;
  traceId: string;
  filePath: string;
  envelope: HookEventEnvelope;
  context: HookEventContext;
  timeout: ReturnType<typeof setTimeout>;
};

export type FileChangeAggregatorOptions = {
  debounceMs: number;
  dispatcher: (input: {
    envelope: HookEventEnvelope;
    context: HookEventContext;
  }) => Promise<HookDispatchResult>;
};

function normalizeFilePath(input: {
  envelope: HookEventEnvelope;
  context: HookEventContext;
}): string {
  const firstChangedFile = input.context.changedFiles?.[0]?.trim();
  if (firstChangedFile) {
    return firstChangedFile;
  }

  const payloadPath = input.envelope.payload?.path;
  return typeof payloadPath === 'string' ? payloadPath.trim() : '';
}

export class FileChangeAggregator {
  private readonly pending = new Map<string, PendingFileChange>();

  constructor(private readonly options: FileChangeAggregatorOptions) {}

  async enqueue(input: {
    envelope: HookEventEnvelope;
    context: HookEventContext;
  }): Promise<{ accepted: boolean; key?: string }> {
    const filePath = normalizeFilePath(input);
    if (!filePath) {
      return { accepted: false };
    }

    const key = `${input.envelope.traceId}::${filePath}`;
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timeout);
    }

    const timeout = setTimeout(() => {
      void this.flushKey(key);
    }, this.options.debounceMs);

    this.pending.set(key, {
      key,
      traceId: input.envelope.traceId,
      filePath,
      envelope: input.envelope,
      context: input.context,
      timeout,
    });

    return { accepted: true, key };
  }

  async flushTrace(traceId: string): Promise<HookDispatchResult[]> {
    const keys = [...this.pending.values()]
      .filter((entry) => entry.traceId === traceId)
      .map((entry) => entry.key);

    const results: HookDispatchResult[] = [];
    for (const key of keys) {
      const result = await this.flushKey(key);
      if (result) {
        results.push(result);
      }
    }
    return results;
  }

  private async flushKey(key: string): Promise<HookDispatchResult | null> {
    const pending = this.pending.get(key);
    if (!pending) {
      return null;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(key);
    return this.options.dispatcher({
      envelope: pending.envelope,
      context: pending.context,
    });
  }
}
