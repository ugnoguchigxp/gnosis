import { emitHookMonitorEvent } from './monitor-hook-reporter.js';

export async function enqueueHookReview(input: {
  traceId: string;
  taskId?: string;
  profile?: string;
  include?: string[];
}): Promise<{ queued: boolean; requestId?: string }> {
  await emitHookMonitorEvent({
    event: 'hook.review.enqueued',
    traceId: input.traceId,
    taskId: input.taskId,
    gateName: input.profile ?? 'standard',
    message: 'review request accepted by hook bridge',
    payload: {
      include: input.include ?? [],
    },
  });

  return {
    queued: true,
    requestId: input.traceId,
  };
}
