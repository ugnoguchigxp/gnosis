import { createHash } from 'node:crypto';
import { generateEntityId } from '../../../utils/entityId.js';

export const KNOWFLOW_TOPIC_STATE_ENTITY_TYPE = 'knowflow_topic_state';

export const EXPLORED_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
export const EXHAUSTED_RETRY_MS = 30 * 24 * 60 * 60 * 1000;

export type KnowflowTopicStatus = 'queued' | 'running' | 'explored' | 'exhausted';

export const metadataRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const generateTopicStateEntityId = (topic: string): string =>
  generateEntityId(KNOWFLOW_TOPIC_STATE_ENTITY_TYPE, topic);

export const readKnowflowStatus = (metadataValue: unknown): KnowflowTopicStatus | undefined => {
  const metadata = metadataRecord(metadataValue);
  const status =
    typeof metadata.knowflowStatus === 'string'
      ? metadata.knowflowStatus
      : typeof metadata.status === 'string'
        ? metadata.status
        : undefined;

  switch (status) {
    case 'queued':
    case 'running':
    case 'explored':
    case 'exhausted':
      return status;
    default:
      return undefined;
  }
};

const parseDateMs = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const isKnowflowTopicSuppressed = (
  metadataValue: unknown,
  now: Date = new Date(),
): boolean => {
  const metadata = metadataRecord(metadataValue);
  const status = readKnowflowStatus(metadata);
  if (status === 'queued' || status === 'running') return true;

  const nowMs = now.getTime();
  if (status === 'explored') {
    const cooldownUntil = parseDateMs(metadata.cooldownUntil);
    return cooldownUntil !== undefined && cooldownUntil > nowMs;
  }
  if (status === 'exhausted') {
    const retryAfter = parseDateMs(metadata.retryAfter);
    return retryAfter !== undefined && retryAfter > nowMs;
  }

  return false;
};

export const isoAfter = (now: Date, durationMs: number): string =>
  new Date(now.getTime() + durationMs).toISOString();

export const hashSearchAttempt = (input: { topic: string; queries?: string[] }): string => {
  const queries = input.queries?.map((query) => query.trim()).filter(Boolean) ?? [];
  return createHash('sha256')
    .update(JSON.stringify({ topic: input.topic.trim().toLowerCase(), queries }))
    .digest('hex');
};
