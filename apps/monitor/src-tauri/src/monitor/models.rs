use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    pub pending: u64,
    pub running: u64,
    pub deferred: u64,
    pub failed: u64,
}

impl Default for QueueSnapshot {
    fn default() -> Self {
        Self {
            pending: 0,
            running: 0,
            deferred: 0,
            failed: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSnapshot {
    pub last_success_ts: Option<i64>,
    pub last_failure_ts: Option<i64>,
    pub consecutive_failures: u64,
}

impl Default for WorkerSnapshot {
    fn default() -> Self {
        Self {
            last_success_ts: None,
            last_failure_ts: None,
            consecutive_failures: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EvalSnapshot {
    pub pass_rate: f64,
    pub passed: u64,
    pub failed: u64,
    pub updated_at_ts: Option<i64>,
}

impl Default for EvalSnapshot {
    fn default() -> Self {
        Self {
            pass_rate: 0.0,
            passed: 0,
            failed: 0,
            updated_at_ts: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSnapshot {
    pub automation_gate: bool,
    pub background_worker_gate: bool,
    pub local_llm_configured: bool,
    pub local_llm_api_base_url: Option<String>,
}

impl Default for AutomationSnapshot {
    fn default() -> Self {
        Self {
            automation_gate: false,
            background_worker_gate: false,
            local_llm_configured: false,
            local_llm_api_base_url: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowFlowSnapshot {
    pub status: String,
    pub last_worker_ts: Option<i64>,
    pub last_worker_summary: Option<String>,
    pub last_seed_ts: Option<i64>,
    pub last_seed_summary: Option<String>,
    pub last_keyword_seed_ts: Option<i64>,
    pub last_failure_ts: Option<i64>,
}

impl Default for KnowFlowSnapshot {
    fn default() -> Self {
        Self {
            status: "unknown".to_string(),
            last_worker_ts: None,
            last_worker_summary: None,
            last_seed_ts: None,
            last_seed_summary: None,
            last_keyword_seed_ts: None,
            last_failure_ts: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QualityGateRecord {
    pub status: String,
    pub updated_at_ts: Option<i64>,
    pub message: Option<String>,
}

impl Default for QualityGateRecord {
    fn default() -> Self {
        Self {
            status: "unknown".to_string(),
            updated_at_ts: None,
            message: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QualityGateSnapshot {
    pub doctor: QualityGateRecord,
    pub doctor_strict: QualityGateRecord,
    pub onboarding_smoke: QualityGateRecord,
    pub smoke: QualityGateRecord,
    pub verify_fast: QualityGateRecord,
    pub verify: QualityGateRecord,
    pub verify_strict: QualityGateRecord,
    pub mcp_contract: QualityGateRecord,
}

impl Default for QualityGateSnapshot {
    fn default() -> Self {
        Self {
            doctor: QualityGateRecord::default(),
            doctor_strict: QualityGateRecord::default(),
            onboarding_smoke: QualityGateRecord::default(),
            smoke: QualityGateRecord::default(),
            verify_fast: QualityGateRecord::default(),
            verify: QualityGateRecord::default(),
            verify_strict: QualityGateRecord::default(),
            mcp_contract: QualityGateRecord::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshotData {
    pub queue: QueueSnapshot,
    pub embedding_queue: QueueSnapshot,
    pub worker: WorkerSnapshot,
    pub eval: EvalSnapshot,
    pub automation: AutomationSnapshot,
    pub knowflow: KnowFlowSnapshot,
    pub quality_gates: QualityGateSnapshot,
    pub task_index: Vec<TaskIndexEntry>,
}

impl Default for MonitorSnapshotData {
    fn default() -> Self {
        Self {
            queue: QueueSnapshot::default(),
            embedding_queue: QueueSnapshot::default(),
            worker: WorkerSnapshot::default(),
            eval: EvalSnapshot::default(),
            automation: AutomationSnapshot::default(),
            knowflow: KnowFlowSnapshot::default(),
            quality_gates: QualityGateSnapshot::default(),
            task_index: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskIndexEntry {
    pub task_id: String,
    pub topic: Option<String>,
    pub source: Option<String>,
    pub status: String,
    pub updated_at_ts: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEnvelope {
    pub ts: i64,
    pub data: MonitorSnapshotData,
}

impl Default for SnapshotEnvelope {
    fn default() -> Self {
        Self {
            ts: 0,
            data: MonitorSnapshotData::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent {
    pub id: String,
    pub kind: String,
    pub ts: i64,
    pub run_id: Option<String>,
    pub task_id: Option<String>,
    pub trace_id: Option<String>,
    pub rule_id: Option<String>,
    pub gate_name: Option<String>,
    #[serde(default)]
    pub risk_tags: Vec<String>,
    #[serde(default)]
    pub candidate_ids: Vec<String>,
    pub result_summary: Option<String>,
    pub error_reason: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
pub enum OutboundBroadcast {
    Snapshot(SnapshotEnvelope),
    Event(TimelineEvent),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotCliPayload {
    pub ts: i64,
    pub queue: QueueSnapshot,
    pub embedding_queue: QueueSnapshot,
    pub worker: WorkerSnapshot,
    pub eval: EvalSnapshot,
    #[serde(default)]
    pub automation: AutomationSnapshot,
    #[serde(default)]
    pub knowflow: KnowFlowSnapshot,
    #[serde(default)]
    pub quality_gates: QualityGateSnapshot,
    #[serde(default)]
    pub task_index: Vec<TaskIndexEntry>,
}

impl From<SnapshotCliPayload> for SnapshotEnvelope {
    fn from(value: SnapshotCliPayload) -> Self {
        Self {
            ts: value.ts,
            data: MonitorSnapshotData {
                queue: value.queue,
                embedding_queue: value.embedding_queue,
                worker: value.worker,
                eval: value.eval,
                automation: value.automation,
                knowflow: value.knowflow,
                quality_gates: value.quality_gates,
                task_index: value.task_index,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetailLogSnippet {
    pub ts: i64,
    pub kind: String,
    pub run_id: Option<String>,
    pub task_id: Option<String>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetailPayload {
    pub task_id: String,
    pub run_id: Option<String>,
    pub topic: Option<String>,
    pub source: Option<String>,
    pub status: Option<String>,
    pub result_summary: Option<String>,
    pub error_reason: Option<String>,
    #[serde(default)]
    pub logs: Vec<TaskDetailLogSnippet>,
}

#[derive(Debug, Deserialize)]
pub struct ClientHello {
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(rename = "clientVersion")]
    pub client_version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    HelloAck {
        #[serde(rename = "serverVersion")]
        server_version: String,
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
    },
    Snapshot {
        ts: i64,
        data: MonitorSnapshotData,
    },
    Event {
        ts: i64,
        event: TimelineEvent,
    },
    Heartbeat {
        ts: i64,
    },
}
