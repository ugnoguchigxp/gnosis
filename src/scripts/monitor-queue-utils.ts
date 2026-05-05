export const EMBEDDING_SYSTEM_TOPIC = '__system__/embedding_batch';

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export const isEmbeddingSystemTaskPayload = (payload: unknown): boolean => {
  if (!isRecord(payload)) {
    return false;
  }

  if (payload.topic === EMBEDDING_SYSTEM_TOPIC) {
    return true;
  }

  const metadata = payload.metadata;
  if (!isRecord(metadata)) {
    return false;
  }

  const systemTask = metadata.systemTask;
  if (!isRecord(systemTask)) {
    return false;
  }

  return systemTask.type === 'embedding_batch';
};
