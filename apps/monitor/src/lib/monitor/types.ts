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

export type AutomationSnapshot = {
  automationGate: boolean;
  backgroundWorkerGate: boolean;
  localLlmConfigured: boolean;
  localLlmApiBaseUrl: string | null;
};

export type KnowFlowSnapshot = {
  status: 'idle' | 'healthy' | 'degraded' | 'unknown';
  lastWorkerTs: number | null;
  lastWorkerSummary: string | null;
  lastSeedTs: number | null;
  lastSeedSummary: string | null;
  lastFrontierSeedTs: number | null;
  lastKeywordSeedTs: number | null;
  lastFailureTs: number | null;
};

export type MonitorSnapshotData = {
  queue: QueueSnapshot;
  worker: WorkerSnapshot;
  eval: EvalSnapshot;
  automation: AutomationSnapshot;
  knowflow: KnowFlowSnapshot;
  taskIndex: TaskIndexEntry[];
};

export type TimelineEvent = {
  id: string;
  kind: string;
  ts: number;
  runId?: string;
  taskId?: string;
  traceId?: string;
  ruleId?: string;
  gateName?: string;
  riskTags?: string[];
  candidateIds?: string[];
  topic?: string | null;
  source?: string | null;
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

export type TaskHistoryEntry = {
  id: string;
  topic: string | null;
  source: string | null;
  status: string;
  priority: number;
  resultSummary: string | null;
  errorReason: string | null;
  nextRunAt: number | null;
  lockedAt: number | null;
  lockOwner: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
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

export type InventoryCategory = {
  category: string;
  table: string;
  rowCount: number;
  latestUpdatedAt: string | null;
  statusCounts: Record<string, number>;
  maintenanceState: 'active' | 'deprecated';
};

export type InventorySignal = {
  key: string;
  label: string;
  value: number;
  unit: 'count' | 'percent';
};

export type MonitorDataInventory = {
  ts: number;
  categories: InventoryCategory[];
  signals: InventorySignal[];
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

export type Entity = {
  id: string;
  type: string;
  name: string;
  description: string | null;
  confidence: number;
  scope: string;
  provenance?: string | null;
  freshness?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type Relation = {
  sourceId: string;
  targetId: string;
  relationType: string;
  weight: number;
};
