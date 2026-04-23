use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::Context;
use notify::{RecursiveMode, Watcher};
use serde::Deserialize;
use serde_json::Value;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt},
    sync::mpsc,
    time::{interval, sleep_until, Duration, Instant},
};

use crate::monitor::{cli, models::TimelineEvent, now_millis, state::MonitorSharedState};

const WATCH_EVENTS: [&str; 5] = [
    "task.done",
    "task.failed",
    "task.deferred",
    "llm.task.degraded",
    "review.completed",
];

#[derive(Clone)]
pub struct CollectorConfig {
    pub project_root: PathBuf,
    pub logs_dir: PathBuf,
    pub max_log_files: usize,
    pub debounce: Duration,
    pub min_snapshot_interval: Duration,
    pub consistency_interval: Duration,
    pub metrics_interval: Duration,
}

impl CollectorConfig {
    pub fn with_defaults(project_root: PathBuf, logs_dir: PathBuf) -> Self {
        Self {
            project_root,
            logs_dir,
            max_log_files: 48,
            debounce: Duration::from_millis(300),
            min_snapshot_interval: Duration::from_secs(2),
            consistency_interval: Duration::from_secs(30),
            metrics_interval: Duration::from_secs(60),
        }
    }
}

#[derive(Default)]
struct CollectorMetrics {
    snapshot_calls: u64,
    snapshot_errors: u64,
    snapshot_nochange: u64,
    suppressions: u64,
    events_emitted: u64,
}

impl CollectorMetrics {
    fn log(&self) {
        let total = self.snapshot_calls.max(1);
        let suppression_rate = ((self.suppressions as f64) / (total as f64) * 100.0).round();
        log::info!(
            "monitor.collector.metrics snapshot_calls={} snapshot_errors={} snapshot_nochange={} events_emitted={} suppressions={} suppression_rate={}%%",
            self.snapshot_calls,
            self.snapshot_errors,
            self.snapshot_nochange,
            self.events_emitted,
            self.suppressions,
            suppression_rate
        );
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRunEvent {
    ts: Option<String>,
    run_id: Option<String>,
    event: Option<String>,
    data: Option<Value>,
}

struct LogTailer {
    offsets: HashMap<PathBuf, u64>,
    max_files: usize,
}

impl LogTailer {
    fn new(max_files: usize) -> Self {
        Self {
            offsets: HashMap::new(),
            max_files: max_files.max(1),
        }
    }

    async fn collect_new_events(&mut self, logs_dir: &Path) -> anyhow::Result<Vec<TimelineEvent>> {
        let selected_files = list_recent_logs(logs_dir, self.max_files).await?;
        let selected_set = selected_files
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        self.offsets.retain(|path, _| selected_set.contains(path));

        let mut collected: Vec<TimelineEvent> = Vec::new();

        for file_path in selected_files {
            let metadata = match fs::metadata(&file_path).await {
                Ok(meta) => meta,
                Err(_) => continue,
            };

            let file_size = metadata.len();
            let mut offset = self.offsets.get(&file_path).copied().unwrap_or(0);
            if file_size < offset {
                offset = 0;
            }

            if file_size == offset {
                continue;
            }

            let mut file = fs::File::open(&file_path)
                .await
                .with_context(|| format!("failed to open log file: {}", file_path.display()))?;
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .with_context(|| format!("failed to seek log file: {}", file_path.display()))?;

            let mut delta = String::new();
            file.read_to_string(&mut delta).await.with_context(|| {
                format!("failed to read log file delta: {}", file_path.display())
            })?;

            self.offsets.insert(file_path.clone(), file_size);

            for line in delta.lines() {
                if let Some(event) = parse_timeline_event(line) {
                    collected.push(event);
                }
            }
        }

        collected.sort_by_key(|item| item.ts);
        Ok(collected)
    }
}

pub async fn run(state: Arc<MonitorSharedState>, config: CollectorConfig) -> anyhow::Result<()> {
    fs::create_dir_all(&config.logs_dir)
        .await
        .with_context(|| {
            format!(
                "failed to create logs directory: {}",
                config.logs_dir.display()
            )
        })?;

    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = notify_tx.send(event);
    })
    .context("failed to initialize filesystem watcher")?;

    watcher
        .watch(&config.logs_dir, RecursiveMode::Recursive)
        .with_context(|| format!("failed to watch directory: {}", config.logs_dir.display()))?;

    let mut tailer = LogTailer::new(config.max_log_files);
    let mut metrics = CollectorMetrics::default();

    let refreshed = refresh_snapshot(&state, &config.project_root, &mut metrics).await;
    if refreshed {
        log::info!("monitor initial snapshot loaded");
    }
    emit_new_events(&state, &mut tailer, &config.logs_dir, &mut metrics).await;

    let mut consistency_tick = interval(config.consistency_interval);
    consistency_tick.tick().await;

    let mut metrics_tick = interval(config.metrics_interval);
    metrics_tick.tick().await;

    let mut last_snapshot_refresh = Instant::now();
    let mut dirty = true;
    let mut debounce = Box::pin(sleep_until(Instant::now()));

    loop {
        tokio::select! {
          _ = &mut debounce, if dirty => {
            let emitted = emit_new_events(&state, &mut tailer, &config.logs_dir, &mut metrics).await;
            let should_refresh_snapshot = emitted > 0 || last_snapshot_refresh.elapsed() >= config.min_snapshot_interval;
            if should_refresh_snapshot {
              let _ = refresh_snapshot(&state, &config.project_root, &mut metrics).await;
              last_snapshot_refresh = Instant::now();
            } else {
              metrics.suppressions += 1;
            }
            dirty = false;
          }
          next_notify = notify_rx.recv() => {
            match next_notify {
              Some(Ok(_)) => {
                dirty = true;
                debounce.as_mut().reset(Instant::now() + config.debounce);
              }
              Some(Err(error)) => {
                log::warn!("log directory watcher error: {error}");
              }
              None => {
                log::warn!("log directory watcher channel closed");
                break;
              }
            }
          }
          _ = consistency_tick.tick() => {
            dirty = true;
            debounce.as_mut().reset(Instant::now() + config.debounce);
          }
          _ = metrics_tick.tick() => {
            metrics.log();
          }
        }
    }

    Ok(())
}

async fn emit_new_events(
    state: &Arc<MonitorSharedState>,
    tailer: &mut LogTailer,
    logs_dir: &Path,
    metrics: &mut CollectorMetrics,
) -> usize {
    let events = match tailer.collect_new_events(logs_dir).await {
        Ok(items) => items,
        Err(error) => {
            log::warn!("failed to collect timeline events: {error}");
            return 0;
        }
    };

    let count = events.len();
    metrics.events_emitted += count as u64;

    for event in events {
        state.push_event(event).await;
    }

    count
}

async fn refresh_snapshot(
    state: &Arc<MonitorSharedState>,
    project_root: &Path,
    metrics: &mut CollectorMetrics,
) -> bool {
    metrics.snapshot_calls += 1;

    match cli::fetch_snapshot(project_root).await {
        Ok(snapshot) => {
            let changed = state.update_snapshot(snapshot).await;
            if !changed {
                metrics.snapshot_nochange += 1;
            }
            changed
        }
        Err(error) => {
            metrics.snapshot_errors += 1;
            log::warn!("failed to fetch monitor snapshot: {error}");
            false
        }
    }
}

async fn list_recent_logs(logs_dir: &Path, limit: usize) -> anyhow::Result<Vec<PathBuf>> {
    let mut entries = fs::read_dir(logs_dir)
        .await
        .with_context(|| format!("failed to read logs directory: {}", logs_dir.display()))?;

    let mut files: Vec<(PathBuf, i128)> = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }

        let metadata = match entry.metadata().await {
            Ok(value) => value,
            Err(_) => continue,
        };

        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i128)
            .unwrap_or_default();

        files.push((path, modified_ms));
    }

    files.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(files.into_iter().take(limit).map(|item| item.0).collect())
}

fn parse_timeline_event(line: &str) -> Option<TimelineEvent> {
    if line.trim().is_empty() {
        return None;
    }

    let raw: RawRunEvent = serde_json::from_str(line).ok()?;
    let event_kind = raw.event?;
    if !WATCH_EVENTS.contains(&event_kind.as_str()) && !event_kind.starts_with("hook.") {
        return None;
    }

    let ts = raw
        .ts
        .as_deref()
        .and_then(parse_rfc3339_ms)
        .unwrap_or_else(now_millis);

    let run_id = raw.run_id;
    let payload = raw.data.unwrap_or(Value::Null);
    let task_id = payload
        .get("taskId")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let trace_id = payload
        .get("traceId")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let rule_id = payload
        .get("ruleId")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let gate_name = payload
        .get("gateName")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let risk_tags = payload
        .get("riskTags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let candidate_ids = payload
        .get("candidateIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let result_summary = payload
        .get("summary")
        .or_else(|| payload.get("resultSummary"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let error_reason = payload
        .get("error")
        .or_else(|| payload.get("errorReason"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let event_id = format!(
        "{}:{}:{}:{}:{}",
        run_id.clone().unwrap_or_else(|| "unknown".to_string()),
        event_kind,
        ts,
        task_id.clone().unwrap_or_else(|| "-".to_string()),
        rule_id.clone().unwrap_or_else(|| "-".to_string()),
    );

    Some(TimelineEvent {
        id: event_id,
        kind: event_kind,
        ts,
        run_id,
        task_id,
        trace_id,
        rule_id,
        gate_name,
        risk_tags,
        candidate_ids,
        result_summary,
        error_reason,
        message,
    })
}

fn parse_rfc3339_ms(raw: &str) -> Option<i64> {
    OffsetDateTime::parse(raw, &Rfc3339)
        .ok()
        .map(|parsed| (parsed.unix_timestamp_nanos() / 1_000_000) as i64)
}
