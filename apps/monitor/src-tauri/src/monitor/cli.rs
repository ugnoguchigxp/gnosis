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
pub async fn list_entities(project_root: &Path) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("entities")
        .arg("list")
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute entities list command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("entities list command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse entities list payload")
}

pub async fn create_entity(
    project_root: &Path,
    payload: &str,
) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("entities")
        .arg("create")
        .arg(payload)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute entity create command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("entity create command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse entity create payload")
}

pub async fn update_entity(
    project_root: &Path,
    id: &str,
    payload: &str,
) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("entities")
        .arg("update")
        .arg(id)
        .arg(payload)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute entity update command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("entity update command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse entity update payload")
}

pub async fn delete_entity(project_root: &Path, id: &str) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("entities")
        .arg("delete")
        .arg(id)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute entity delete command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("entity delete command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse entity delete payload")
}

pub async fn list_relations(project_root: &Path) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("relations")
        .arg("list")
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute relations list command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("relations list command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse relations list payload")
}

pub async fn create_relation(
    project_root: &Path,
    payload: &str,
) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("relations")
        .arg("create")
        .arg(payload)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute relation create command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("relation create command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse relation create payload")
}

pub async fn delete_relation(
    project_root: &Path,
    source_id: &str,
    target_id: &str,
    relation_type: &str,
) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("bun")
        .arg("run")
        .arg("src/scripts/monitor-memory-crud.ts")
        .arg("relations")
        .arg("delete")
        .arg(source_id)
        .arg(target_id)
        .arg(relation_type)
        .current_dir(project_root)
        .output()
        .await
        .context("failed to execute relation delete command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("relation delete command failed: {stderr}");
    }

    serde_json::from_slice(&output.stdout).context("failed to parse relation delete payload")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_project_root() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be valid")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("gnosis-agent-test-{nonce}"));
        fs::create_dir_all(&root).expect("test project root should be created");
        root
    }

    #[tokio::test]
    async fn applies_path_marked_markdown_code_blocks() {
        let root = temp_project_root();
        let markdown = r#"
Here is the file:

```typescript
// path: src/fizzbuzz.ts
export function fizzBuzz(n: number): string {
  return n.toString();
}
```
"#;

        let applied = apply_markdown_file_blocks(&root, markdown)
            .await
            .expect("file block should apply");

        assert_eq!(applied, vec!["src/fizzbuzz.ts"]);
        let content = fs::read_to_string(root.join("src/fizzbuzz.ts")).expect("file should exist");
        assert_eq!(
            content,
            "export function fizzBuzz(n: number): string {\n  return n.toString();\n}\n"
        );

        fs::remove_dir_all(root).expect("test project root should be removed");
    }

    #[tokio::test]
    async fn rejects_unsafe_agent_paths() {
        let root = temp_project_root();
        let markdown = r#"
```text
// path: ../outside.txt
nope
```
"#;

        let result = apply_markdown_file_blocks(&root, markdown).await;
        assert!(result.is_err());
        fs::remove_dir_all(root).expect("test project root should be removed");
    }
}
