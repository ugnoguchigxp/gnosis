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
pub async fn fetch_episodes(project_root: &Path) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-episodes.ts")
        .arg("list")
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute monitor-episodes list command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("monitor-episodes list command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse episodes list payload")
}

pub async fn delete_episode(project_root: &Path, id: &str) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-episodes.ts")
        .arg("delete")
        .arg(id)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute monitor-episodes delete command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("monitor-episodes delete command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse delete result")
}

pub async fn register_episode(project_root: &Path, content: &str) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-episodes.ts")
        .arg("register")
        .arg(content)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute monitor-episodes register command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("monitor-episodes register command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse register result")
}

pub async fn consolidate_session(project_root: &Path, session_id: &str) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-episodes.ts")
        .arg("consolidate")
        .arg(session_id)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute monitor-episodes consolidate command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("monitor-episodes consolidate command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse consolidate result")
}
