export type SessionSummaryStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'stale';

export type SessionTurnSummaryStatus = 'deterministic' | 'llm_succeeded' | 'llm_failed';

export type SessionMessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'log' | 'unknown';

export interface SessionMessageInput {
  id?: string;
  role: SessionMessageRole;
  content: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionAction {
  kind: 'command' | 'tool' | 'file_change' | 'test' | 'navigation';
  label: string;
  detail?: string;
  status?: 'unknown' | 'succeeded' | 'failed';
  metadata?: Record<string, unknown>;
}

export interface SessionEvidence {
  kind: 'command_output' | 'error' | 'verification' | 'file' | 'decision' | 'result';
  text: string;
  sourceMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionTurnBlock {
  turnIndex: number;
  userMessageId?: string;
  userContent: string;
  messages: SessionMessageInput[];
  startedAt?: string;
  endedAt?: string;
  deterministicIntent: string;
  deterministicEvidence: SessionEvidence[];
  deterministicActions: SessionAction[];
}

export type KnowledgeKind = 'lesson' | 'rule' | 'procedure' | 'candidate';

export interface KnowledgeCandidate {
  turnIndex: number;
  kind: KnowledgeKind;
  title: string;
  statement: string;
  keep: boolean;
  keepReason: string;
  evidence: SessionEvidence[];
  actions: SessionAction[];
  confidence: number;
  status: SessionTurnSummaryStatus;
  promotedNoteId?: string;
}

export interface DistillSessionResult {
  distillationId?: string;
  sessionKey: string;
  status: SessionSummaryStatus;
  turnCount: number;
  messageCount: number;
  keptCount: number;
  droppedCount: number;
  promotedCount: number;
  modelProvider: 'deterministic' | 'local-llm' | 'openai' | 'bedrock';
  modelName?: string;
  candidates: KnowledgeCandidate[];
  error?: string;
  errorKind?: string;
}
