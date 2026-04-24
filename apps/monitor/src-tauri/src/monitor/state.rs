use std::collections::VecDeque;

use tokio::sync::{broadcast, RwLock};

use crate::monitor::models::{OutboundBroadcast, SnapshotEnvelope, TimelineEvent};

pub struct MonitorSharedState {
    snapshot: RwLock<SnapshotEnvelope>,
    snapshot_hash: RwLock<Vec<u8>>,
    timeline: RwLock<VecDeque<TimelineEvent>>,
    timeline_capacity: usize,
    sender: broadcast::Sender<OutboundBroadcast>,
}

#[cfg(test)]
mod tests {
    use crate::monitor::models::{
        EvalSnapshot, MonitorSnapshotData, QueueSnapshot, SnapshotEnvelope, TaskIndexEntry,
        TimelineEvent, WorkerSnapshot,
    };

    use super::MonitorSharedState;

    fn sample_snapshot(ts: i64, pending: u64) -> SnapshotEnvelope {
        SnapshotEnvelope {
            ts,
            data: MonitorSnapshotData {
                queue: QueueSnapshot {
                    pending,
                    running: 0,
                    deferred: 0,
                    failed: 0,
                },
                worker: WorkerSnapshot::default(),
                eval: EvalSnapshot::default(),
                task_index: vec![TaskIndexEntry {
                    task_id: "task-1".to_string(),
                    topic: Some("topic".to_string()),
                    source: Some("user".to_string()),
                    status: "pending".to_string(),
                    updated_at_ts: Some(ts),
                }],
            },
        }
    }

    #[tokio::test]
    async fn update_snapshot_skips_same_hash() {
        let state = MonitorSharedState::new(4);
        let first = sample_snapshot(100, 1);
        let mut second = first.clone();
        second.ts = 200;

        assert!(state.update_snapshot(first).await);
        assert!(!state.update_snapshot(second).await);
        assert_eq!(state.snapshot().await.ts, 100);
    }

    #[tokio::test]
    async fn push_event_keeps_ring_buffer_capacity() {
        let state = MonitorSharedState::new(2);
        state
            .push_event(TimelineEvent {
                id: "e1".to_string(),
                kind: "task.done".to_string(),
                ts: 1,
                run_id: None,
                task_id: None,
                trace_id: None,
                rule_id: None,
                gate_name: None,
                risk_tags: Vec::new(),
                candidate_ids: Vec::new(),
                result_summary: None,
                error_reason: None,
                message: None,
            })
            .await;
        state
            .push_event(TimelineEvent {
                id: "e2".to_string(),
                kind: "task.done".to_string(),
                ts: 2,
                run_id: None,
                task_id: None,
                trace_id: None,
                rule_id: None,
                gate_name: None,
                risk_tags: Vec::new(),
                candidate_ids: Vec::new(),
                result_summary: None,
                error_reason: None,
                message: None,
            })
            .await;
        state
            .push_event(TimelineEvent {
                id: "e3".to_string(),
                kind: "task.done".to_string(),
                ts: 3,
                run_id: None,
                task_id: None,
                trace_id: None,
                rule_id: None,
                gate_name: None,
                risk_tags: Vec::new(),
                candidate_ids: Vec::new(),
                result_summary: None,
                error_reason: None,
                message: None,
            })
            .await;

        let timeline = state.timeline().await;
        assert_eq!(timeline.len(), 2);
        assert_eq!(timeline[0].id, "e2");
        assert_eq!(timeline[1].id, "e3");
    }
}

impl MonitorSharedState {
    pub fn new(timeline_capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(1_024);
        Self {
            snapshot: RwLock::new(SnapshotEnvelope::default()),
            snapshot_hash: RwLock::new(Vec::new()),
            timeline: RwLock::new(VecDeque::with_capacity(timeline_capacity.max(1))),
            timeline_capacity: timeline_capacity.max(1),
            sender,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<OutboundBroadcast> {
        self.sender.subscribe()
    }

    pub async fn snapshot(&self) -> SnapshotEnvelope {
        self.snapshot.read().await.clone()
    }

    pub async fn timeline(&self) -> Vec<TimelineEvent> {
        self.timeline
            .read()
            .await
            .iter()
            .cloned()
            .collect::<Vec<TimelineEvent>>()
    }

    pub async fn update_snapshot(&self, snapshot: SnapshotEnvelope) -> bool {
        let next_hash = serde_json::to_vec(&snapshot.data).unwrap_or_default();

        {
            let current_hash = self.snapshot_hash.read().await;
            if *current_hash == next_hash {
                return false;
            }
        }

        {
            let mut snapshot_lock = self.snapshot.write().await;
            *snapshot_lock = snapshot.clone();
        }

        {
            let mut hash_lock = self.snapshot_hash.write().await;
            *hash_lock = next_hash;
        }

        let _ = self.sender.send(OutboundBroadcast::Snapshot(snapshot));
        true
    }

    pub async fn push_event(&self, event: TimelineEvent) {
        {
            let mut timeline_lock = self.timeline.write().await;
            timeline_lock.push_back(event.clone());
            while timeline_lock.len() > self.timeline_capacity {
                timeline_lock.pop_front();
            }
        }

        let _ = self.sender.send(OutboundBroadcast::Event(event));
    }
}
