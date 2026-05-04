import { config } from '../../../config.js';
import type { db as defaultDb } from '../../../db/index.js';
import type { StructuredLogger } from '../ops/logger.js';
import type { PgJsonbQueueRepository } from '../queue/pgJsonbRepository.js';
import { runKeywordSeederOnce } from './keywordSeeder.js';
import type { KeywordSeederRunResult } from './types.js';

type QueueRepositoryLike = Pick<PgJsonbQueueRepository, 'enqueue'>;

export type PhraseScoutSeedTrigger = 'startup' | 'interval' | 'background-manager';

export type PhraseScoutLoopState = {
  inFlight: boolean;
};

export const createPhraseScoutLoopState = (): PhraseScoutLoopState => ({
  inFlight: false,
});

export const resolvePhraseScoutIntervalMs = (input: {
  backgroundIntervalMs: number;
  llmTimeoutMs: number;
  envValue?: string;
  parseNumber?: (value: string | undefined, fallback: number) => number;
}): number => {
  const parseNumber =
    input.parseNumber ??
    ((value, fallback) => {
      const parsed = value === undefined ? fallback : Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    });
  return Math.max(input.llmTimeoutMs, parseNumber(input.envValue, input.backgroundIntervalMs));
};

export async function runPhraseScoutSeedOnce(input: {
  trigger: PhraseScoutSeedTrigger;
  state: PhraseScoutLoopState;
  queueRepository: QueueRepositoryLike;
  logger: StructuredLogger;
  database?: typeof defaultDb;
}): Promise<KeywordSeederRunResult | null> {
  if (!config.knowflow.keywordCron.enabled) {
    input.logger({
      event: 'knowflow.phrase_scout.seed.skipped',
      trigger: input.trigger,
      reason: 'disabled',
      level: 'info',
    });
    return null;
  }

  if (input.state.inFlight) {
    input.logger({
      event: 'knowflow.phrase_scout.seed.skipped',
      trigger: input.trigger,
      reason: 'in_flight',
      level: 'warn',
    });
    return null;
  }

  input.state.inFlight = true;
  const startedAt = Date.now();
  try {
    const result = await runKeywordSeederOnce({
      database: input.database,
      queueRepository: input.queueRepository,
      logger: (event, payload) => {
        input.logger({
          event,
          trigger: input.trigger,
          ...payload,
          level: event.endsWith('.failed') ? 'error' : 'info',
        });
      },
    });
    input.logger({
      event: 'knowflow.phrase_scout.seed.completed',
      trigger: input.trigger,
      durationMs: Date.now() - startedAt,
      ...result,
      level: 'info',
    });
    return result;
  } catch (error) {
    input.logger({
      event: 'knowflow.phrase_scout.seed.failed',
      trigger: input.trigger,
      durationMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
      level: 'error',
    });
    return null;
  } finally {
    input.state.inFlight = false;
  }
}
