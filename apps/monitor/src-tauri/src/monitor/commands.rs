use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::Serialize;
use tauri::State;

use crate::monitor::{cli, models::TaskDetailPayload, MonitorRuntime};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorConfigResponse {
    pub ws_url: String,
    pub protocol_version: u32,
    pub project_root: String,
    pub project_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedProjectResponse {
    pub project_root: String,
    pub project_name: String,
}

fn project_name(project_root: &Path) -> String {
    project_root
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".to_string())
}

fn selected_project_response(project_root: PathBuf) -> SelectedProjectResponse {
    SelectedProjectResponse {
        project_name: project_name(&project_root),
        project_root: project_root.to_string_lossy().to_string(),
    }
}

fn validate_project_root(raw: &str) -> anyhow::Result<PathBuf> {
    let path = PathBuf::from(raw);
    let canonical = path
        .canonicalize()
        .with_context(|| format!("failed to resolve project root: {raw}"))?;
    if !canonical.is_dir() {
        anyhow::bail!("selected project is not a directory: {raw}");
    }
    Ok(canonical)
}

#[tauri::command]
pub fn monitor_config(state: State<'_, MonitorRuntime>) -> MonitorConfigResponse {
    MonitorConfigResponse {
        ws_url: state.ws_url.clone(),
        protocol_version: state.protocol_version,
        project_root: state.project_root.to_string_lossy().to_string(),
        project_name: project_name(&state.project_root),
    }
}

#[tauri::command]
pub async fn monitor_browse_project() -> Result<Option<SelectedProjectResponse>, String> {
    let selected = tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .map_err(|error| error.to_string())?;

    selected
        .map(|path| {
            validate_project_root(&path.to_string_lossy())
                .map(selected_project_response)
                .map_err(|error| error.to_string())
        })
        .transpose()
}

#[tauri::command]
pub async fn monitor_task_detail(
    state: State<'_, MonitorRuntime>,
    task_id: String,
) -> Result<TaskDetailPayload, String> {
    cli::fetch_task_detail(&state.project_root, &task_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_graph_snapshot(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::fetch_graph_snapshot(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_enqueue_task(
    state: State<'_, MonitorRuntime>,
    topic: String,
    mode: Option<String>,
    priority: Option<i32>,
) -> Result<serde_json::Value, String> {
    cli::enqueue_knowflow_task(&state.project_root, &topic, mode.as_deref(), priority)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_list_tasks(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::fetch_tasks(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_data_inventory(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::fetch_data_inventory(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_retry_task(
    state: State<'_, MonitorRuntime>,
    task_id: String,
) -> Result<serde_json::Value, String> {
    cli::retry_task(&state.project_root, &task_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_defer_task(
    state: State<'_, MonitorRuntime>,
    task_id: String,
    defer_minutes: Option<i32>,
) -> Result<serde_json::Value, String> {
    cli::defer_task(&state.project_root, &task_id, defer_minutes)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_failure_firewall(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::fetch_failure_firewall(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_failure_firewall_action(
    state: State<'_, MonitorRuntime>,
    action: String,
    kind: String,
    id: String,
) -> Result<serde_json::Value, String> {
    cli::failure_firewall_action(&state.project_root, &action, &kind, &id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_review_data(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::fetch_review_data(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_review_action(
    state: State<'_, MonitorRuntime>,
    action: String,
    review_case_id: String,
) -> Result<serde_json::Value, String> {
    cli::review_action(&state.project_root, &action, &review_case_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_sync_state(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::fetch_sync_state(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_sync_state_action(
    state: State<'_, MonitorRuntime>,
    action: String,
    id: String,
    confirm: Option<String>,
) -> Result<serde_json::Value, String> {
    cli::sync_state_action(&state.project_root, &action, &id, confirm.as_deref())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_knowflow_corpus(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::fetch_knowflow_corpus(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_knowflow_evals(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::fetch_knowflow_evals(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_communities(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::fetch_communities(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_list_lessons(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::list_lessons(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_create_lesson(
    state: State<'_, MonitorRuntime>,
    payload: String,
) -> Result<serde_json::Value, String> {
    cli::create_lesson(&state.project_root, &payload)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_update_lesson(
    state: State<'_, MonitorRuntime>,
    id: String,
    payload: String,
) -> Result<serde_json::Value, String> {
    cli::update_lesson(&state.project_root, &id, &payload)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_delete_lesson(
    state: State<'_, MonitorRuntime>,
    id: String,
) -> Result<serde_json::Value, String> {
    cli::delete_lesson(&state.project_root, &id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_list_guidance(
    state: State<'_, MonitorRuntime>,
    guidance_type: String,
) -> Result<serde_json::Value, String> {
    cli::list_guidance(&state.project_root, &guidance_type)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_create_guidance(
    state: State<'_, MonitorRuntime>,
    payload: String,
) -> Result<serde_json::Value, String> {
    cli::create_guidance(&state.project_root, &payload)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_update_guidance(
    state: State<'_, MonitorRuntime>,
    id: String,
    payload: String,
) -> Result<serde_json::Value, String> {
    cli::update_guidance(&state.project_root, &id, &payload)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_delete_guidance(
    state: State<'_, MonitorRuntime>,
    id: String,
) -> Result<serde_json::Value, String> {
    cli::delete_guidance(&state.project_root, &id)
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn monitor_list_entities(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::list_entities(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_create_entity(
    state: State<'_, MonitorRuntime>,
    payload: String,
) -> Result<serde_json::Value, String> {
    cli::create_entity(&state.project_root, &payload)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_update_entity(
    state: State<'_, MonitorRuntime>,
    id: String,
    payload: String,
) -> Result<serde_json::Value, String> {
    cli::update_entity(&state.project_root, &id, &payload)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_delete_entity(
    state: State<'_, MonitorRuntime>,
    id: String,
) -> Result<serde_json::Value, String> {
    cli::delete_entity(&state.project_root, &id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_list_relations(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::list_relations(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_create_relation(
    state: State<'_, MonitorRuntime>,
    payload: String,
) -> Result<serde_json::Value, String> {
    cli::create_relation(&state.project_root, &payload)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_delete_relation(
    state: State<'_, MonitorRuntime>,
    source_id: String,
    target_id: String,
    relation_type: String,
) -> Result<serde_json::Value, String> {
    cli::delete_relation(&state.project_root, &source_id, &target_id, &relation_type)
        .await
        .map_err(|error| error.to_string())
}
