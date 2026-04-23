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

#[tauri::command]
pub async fn monitor_consolidate_session(
    state: State<'_, MonitorRuntime>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    cli::consolidate_session(&state.project_root, &session_id)
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
pub async fn monitor_list_keyword_evaluations(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::list_keyword_evaluations(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_delete_keyword_evaluation(
    state: State<'_, MonitorRuntime>,
    id: String,
) -> Result<serde_json::Value, String> {
    cli::delete_keyword_evaluation(&state.project_root, &id)
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

#[tauri::command]
pub async fn monitor_list_goals(
    state: State<'_, MonitorRuntime>,
) -> Result<serde_json::Value, String> {
    cli::list_goals(&state.project_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_get_procedure(
    state: State<'_, MonitorRuntime>,
    goal_id: String,
) -> Result<serde_json::Value, String> {
    cli::get_procedure(&state.project_root, &goal_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_set_task_confidence(
    state: State<'_, MonitorRuntime>,
    task_id: String,
    confidence: f64,
) -> Result<serde_json::Value, String> {
    cli::set_task_confidence(&state.project_root, &task_id, confidence)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_add_step(
    state: State<'_, MonitorRuntime>,
    goal_id: String,
    task_id: String,
) -> Result<serde_json::Value, String> {
    cli::add_step(&state.project_root, &goal_id, &task_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_remove_step(
    state: State<'_, MonitorRuntime>,
    goal_id: String,
    task_id: String,
) -> Result<serde_json::Value, String> {
    cli::remove_step(&state.project_root, &goal_id, &task_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_reorder_steps(
    state: State<'_, MonitorRuntime>,
    goal_id: String,
    steps_order: Vec<String>,
) -> Result<serde_json::Value, String> {
    cli::reorder_steps(&state.project_root, &goal_id, steps_order)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_create_custom_step(
    state: State<'_, MonitorRuntime>,
    goal_id: String,
    name: String,
    description: String,
) -> Result<serde_json::Value, String> {
    cli::create_custom_step(&state.project_root, &goal_id, &name, &description)
        .await
        .map_err(|error| error.to_string())
}
