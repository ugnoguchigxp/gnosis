import { type TopicTask, TopicTaskSchema } from '../domain/task';

export type TopicTaskRowFields = {
  id: string;
  dedupeKey: string;
  status: TopicTask['status'];
  priority: number;
  nextRunAt: number | null;
  lockedAt: number | null;
  lockOwner: string | null;
  payload: TopicTask;
};

export const toTaskRowFields = (task: TopicTask): TopicTaskRowFields => {
  return {
    id: task.id,
    dedupeKey: task.dedupeKey,
    status: task.status,
    priority: task.priority,
    nextRunAt: task.nextRunAt ?? null,
    lockedAt: task.lockedAt ?? null,
    lockOwner: task.lockOwner ?? null,
    payload: task,
  };
};

export const parseTaskPayload = (payload: unknown): TopicTask => {
  return TopicTaskSchema.parse(payload);
};
