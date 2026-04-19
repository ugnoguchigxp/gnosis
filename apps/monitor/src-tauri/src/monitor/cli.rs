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

pub async fn fetch_tasks(project_root: &Path) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-tasks.ts")
        .arg("--json")
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute monitor-tasks command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("monitor-tasks command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse tasks list payload")
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

pub async fn register_episode(
    project_root: &Path,
    content: &str,
) -> anyhow::Result<serde_json::Value> {
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

pub async fn consolidate_session(
    project_root: &Path,
    session_id: &str,
) -> anyhow::Result<serde_json::Value> {
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

pub async fn list_lessons(project_root: &Path) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("lessons")
        .arg("list")
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute lessons list command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("lessons list command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse lessons list payload")
}

pub async fn create_lesson(
    project_root: &Path,
    payload: &str,
) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("lessons")
        .arg("create")
        .arg(payload)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute lesson create command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("lesson create command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse lesson create payload")
}

pub async fn update_lesson(
    project_root: &Path,
    id: &str,
    payload: &str,
) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("lessons")
        .arg("update")
        .arg(id)
        .arg(payload)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute lesson update command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("lesson update command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse lesson update payload")
}

pub async fn delete_lesson(project_root: &Path, id: &str) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("lessons")
        .arg("delete")
        .arg(id)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute lesson delete command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("lesson delete command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse lesson delete payload")
}

pub async fn list_guidance(
    project_root: &Path,
    guidance_type: &str,
) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("guidance")
        .arg("list")
        .arg(guidance_type)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute guidance list command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("guidance list command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse guidance list payload")
}

pub async fn create_guidance(
    project_root: &Path,
    payload: &str,
) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("guidance")
        .arg("create")
        .arg(payload)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute guidance create command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("guidance create command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse guidance create payload")
}

pub async fn update_guidance(
    project_root: &Path,
    id: &str,
    payload: &str,
) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("guidance")
        .arg("update")
        .arg(id)
        .arg(payload)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute guidance update command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("guidance update command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse guidance update payload")
}

pub async fn delete_guidance(project_root: &Path, id: &str) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("guidance")
        .arg("delete")
        .arg(id)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute guidance delete command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("guidance delete command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse guidance delete payload")
}
