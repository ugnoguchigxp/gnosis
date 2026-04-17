use serde::Serialize;
use tauri::State;

use crate::monitor::{cli, models::TaskDetailPayload, MonitorRuntime};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorConfigResponse {
    pub ws_url: String,
    pub protocol_version: u32,
}

#[tauri::command]
pub fn monitor_config(state: State<'_, MonitorRuntime>) -> MonitorConfigResponse {
    MonitorConfigResponse {
        ws_url: state.ws_url.clone(),
        protocol_version: state.protocol_version,
    }
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
    cli::enqueue_knowflow_task(
        &state.project_root,
        &topic,
        mode.as_deref(),
        priority,
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_list_episodes(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::fetch_episodes(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_delete_episode(
    state: State<'_, MonitorRuntime>,
    id: String,
) -> Result<serde_json::Value, String> {
    cli::delete_episode(&state.project_root, &id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_register_episode(
    state: State<'_, MonitorRuntime>,
    content: String,
) -> Result<serde_json::Value, String> {
    cli::register_episode(&state.project_root, &content)
        .await
        .map_err(|error| error.to_string())
}
