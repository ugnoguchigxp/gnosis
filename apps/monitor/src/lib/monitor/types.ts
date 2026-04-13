export type QueueSnapshot = {
  pending: number;
  running: number;
  deferred: number;
  failed: number;
};

export type WorkerSnapshot = {
  lastSuccessTs: number | null;
  lastFailureTs: number | null;
  consecutiveFailures: number;
};

export type EvalSnapshot = {
  degradedRate: number;
  passed: number;
  failed: number;
  updatedAtTs: number | null;
};

export type MonitorSnapshotData = {
  queue: QueueSnapshot;
  worker: WorkerSnapshot;
  eval: EvalSnapshot;
  taskIndex: TaskIndexEntry[];
};

export type TimelineEvent = {
  id: string;
  kind: string;
  ts: number;
  runId?: string;
  taskId?: string;
  resultSummary?: string;
  errorReason?: string;
  message?: string;
};

export type TaskIndexEntry = {
  taskId: string;
  topic: string | null;
  source: string | null;
  status: string;
  updatedAtTs: number | null;
};

export type TaskDetailLogSnippet = {
  ts: number;
  kind: string;
  runId: string | null;
  taskId: string | null;
  summary: string | null;
  error: string | null;
  message: string | null;
};

export type TaskDetailPayload = {
  taskId: string;
  runId: string | null;
  topic: string | null;
  source: string | null;
  status: string | null;
  resultSummary: string | null;
  errorReason: string | null;
  logs: TaskDetailLogSnippet[];
};

export type MonitorConfigResponse = {
  wsUrl: string;
  protocolVersion: number;
};

export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline';

export type ServerMessage =
  | {
      type: 'hello_ack';
      serverVersion: string;
      protocolVersion: number;
    }
  | {
      type: 'snapshot';
      ts: number;
      data: MonitorSnapshotData;
    }
  | {
      type: 'event';
      ts: number;
      event: TimelineEvent;
    }
  | {
      type: 'heartbeat';
      ts: number;
    };
