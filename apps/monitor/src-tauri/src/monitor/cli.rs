use std::path::Path;

use anyhow::Context;
use tokio::process::Command;

use crate::monitor::models::{SnapshotCliPayload, SnapshotEnvelope, TaskDetailPayload};

pub async fn fetch_snapshot(project_root: &Path) -> anyhow::Result<SnapshotEnvelope> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-snapshot.ts")
        .arg("--json")
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute monitor-snapshot command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("monitor-snapshot command failed: {stderr}");
    }

    let parsed: SnapshotCliPayload = serde_json::from_slice(&output.stdout).with_context(|| {
        format!(
            "failed to parse monitor snapshot payload: {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })?;

    Ok(parsed.into())
}

pub async fn fetch_task_detail(
    project_root: &Path,
    task_id: &str,
) -> anyhow::Result<TaskDetailPayload> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-detail.ts")
        .arg("--json")
        .arg("--task-id")
        .arg(task_id)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute monitor-detail command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("monitor-detail command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).with_context(|| {
        format!(
            "failed to parse monitor detail payload: {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}

pub async fn fetch_graph_snapshot(project_root: &Path) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/graph-snapshot.ts")
        .arg("--json")
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute graph-snapshot command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("graph-snapshot command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse graph snapshot payload")
}

pub async fn enqueue_knowflow_task(
    project_root: &Path,
    topic: &str,
    mode: Option<&str>,
    priority: Option<i32>,
) -> anyhow::Result<serde_json::Value> {
    let mut cmd = Command::new("bun");
    cmd.arg("run")
        .arg("src/scripts/enqueue-task.ts")
        .arg("--json")
        .arg("--topic")
        .arg(topic);

    if let Some(m) = mode {
        cmd.arg("--mode").arg(m);
    }
    if let Some(p) = priority {
        cmd.arg("--priority").arg(p.to_string());
    }

    let output = cmd
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute enqueue-task command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("enqueue-task command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse enqueue result")
}
