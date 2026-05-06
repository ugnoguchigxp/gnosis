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
  passRate: number;
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
  lastKeywordSeedTs: number | null;
  lastFailureTs: number | null;
};

export type QualityGateRecord = {
  status: 'passed' | 'failed' | 'unknown';
  updatedAtTs: number | null;
  message: string | null;
};

export type QualityGateSnapshot = {
  doctor: QualityGateRecord;
  doctorStrict: QualityGateRecord;
  onboardingSmoke: QualityGateRecord;
  smoke: QualityGateRecord;
  verifyFast: QualityGateRecord;
  verify: QualityGateRecord;
  verifyStrict: QualityGateRecord;
  mcpContract: QualityGateRecord;
};

export type MonitorSnapshotData = {
  queue: QueueSnapshot;
  embeddingQueue: QueueSnapshot;
  worker: WorkerSnapshot;
  eval: EvalSnapshot;
  automation: AutomationSnapshot;
  knowflow: KnowFlowSnapshot;
  qualityGates: QualityGateSnapshot;
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
  queueType: 'knowflow' | 'embedding';
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

export type SessionSummary = {
  id: string;
  title: string;
  source: string;
  sourceId: string | null;
  sessionFile: string | null;
  memorySessionId: string;
  chunkCount: number;
  messageCount: number;
  roles: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  preview: string;
};

export type SessionMessage = {
  id: string;
  role: 'user' | 'assistant' | 'unknown';
  content: string;
  createdAt: string;
  source: string;
  chunkId: string;
};

export type SessionDetail = {
  summary: SessionSummary;
  messages: SessionMessage[];
};

export type SessionKnowledgeCandidate = {
  id?: string;
  distillationId?: string;
  turnIndex: number;
  kind: 'lesson' | 'rule' | 'procedure' | 'candidate';
  title: string;
  statement: string;
  keep: boolean;
  keepReason: string;
  evidence?: Array<Record<string, unknown>>;
  actions?: Array<Record<string, unknown>>;
  confidence: number;
  status: 'deterministic' | 'llm_succeeded' | 'llm_failed';
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  rejectionReason?: string | null;
  recordError?: string | null;
  promotedNoteId?: string;
};

export type SessionDistillationResult = {
  distillationId?: string;
  sessionKey: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'stale';
  turnCount: number;
  messageCount: number;
  keptCount: number;
  droppedCount: number;
  promotedCount: number;
  modelProvider: 'deterministic' | 'local-llm' | 'openai' | 'bedrock';
  modelName?: string;
  candidates: SessionKnowledgeCandidate[];
  error?: string;
};

export type SessionDistillationStatus = {
  id: string;
  sessionKey: string;
  transcriptHash: string;
  promptVersion: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'stale';
  modelProvider: string | null;
  modelName: string | null;
  turnCount: number;
  messageCount: number;
  keptCount: number;
  droppedCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type SessionDistillationStatusPayload = {
  record: SessionDistillationStatus;
  candidates: SessionKnowledgeCandidate[];
};

export type SessionDistillationListItem = {
  id: string;
  sessionKey: string;
  transcriptHash: string;
  promptVersion: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'stale';
  modelProvider: string | null;
  modelName: string | null;
  turnCount: number;
  messageCount: number;
  keptCount: number;
  droppedCount: number;
  error: string | null;
  summaryPreview?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type SessionKnowledgeListPayload = {
  distillation: SessionDistillationStatus | null;
  candidates: SessionKnowledgeCandidate[];
};

export type SessionDistillationEnqueueResult = {
  taskId: string;
  sessionId: string;
  status: 'pending';
  queued: true;
  force: boolean;
  promote: boolean;
  provider: 'auto' | 'deterministic' | 'local' | 'openai' | 'bedrock';
};
