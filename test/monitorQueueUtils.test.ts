import { describe, expect, it } from 'bun:test';
import {
  EMBEDDING_SYSTEM_TOPIC,
  isEmbeddingSystemTaskPayload,
} from '../src/scripts/monitor-queue-utils';

describe('monitor queue utils', () => {
  it('detects embedding task by system topic', () => {
    expect(
      isEmbeddingSystemTaskPayload({
        topic: EMBEDDING_SYSTEM_TOPIC,
      }),
    ).toBe(true);
  });

  it('detects embedding task by metadata.systemTask.type', () => {
    expect(
      isEmbeddingSystemTaskPayload({
        topic: '__system__/custom',
        metadata: {
          systemTask: {
            type: 'embedding_batch',
          },
        },
      }),
    ).toBe(true);
  });

  it('does not treat non-embedding tasks as embedding queue', () => {
    expect(
      isEmbeddingSystemTaskPayload({
        topic: '__system__/synthesis',
        metadata: {
          systemTask: {
            type: 'synthesis',
          },
        },
      }),
    ).toBe(false);
    expect(isEmbeddingSystemTaskPayload(null)).toBe(false);
  });
});
