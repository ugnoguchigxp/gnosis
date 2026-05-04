mod monitor;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let runtime = monitor::start()?;
            app.manage(runtime);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            monitor::commands::monitor_config,
            monitor::commands::monitor_browse_project,
            monitor::commands::monitor_list_tasks,
            monitor::commands::monitor_data_inventory,
            monitor::commands::monitor_retry_task,
            monitor::commands::monitor_defer_task,
            monitor::commands::monitor_failure_firewall,
            monitor::commands::monitor_failure_firewall_action,
            monitor::commands::monitor_review_data,
            monitor::commands::monitor_review_action,
            monitor::commands::monitor_sync_state,
            monitor::commands::monitor_sync_state_action,
            monitor::commands::monitor_knowflow_corpus,
            monitor::commands::monitor_communities,
            monitor::commands::monitor_task_detail,
            monitor::commands::monitor_graph_snapshot,
            monitor::commands::monitor_enqueue_task,
            monitor::commands::monitor_list_lessons,
            monitor::commands::monitor_list_sessions,
            monitor::commands::monitor_session_detail,
            monitor::commands::monitor_session_distillation,
            monitor::commands::monitor_list_session_summaries,
            monitor::commands::monitor_distill_session_knowledge,
            monitor::commands::monitor_list_session_knowledge,
            monitor::commands::monitor_approve_session_knowledge,
            monitor::commands::monitor_reject_session_knowledge,
            monitor::commands::monitor_record_session_knowledge,
            monitor::commands::monitor_create_lesson,
            monitor::commands::monitor_update_lesson,
            monitor::commands::monitor_delete_lesson,
            monitor::commands::monitor_list_guidance,
            monitor::commands::monitor_create_guidance,
            monitor::commands::monitor_update_guidance,
            monitor::commands::monitor_delete_guidance,
            monitor::commands::monitor_list_entities,
            monitor::commands::monitor_create_entity,
            monitor::commands::monitor_update_entity,
            monitor::commands::monitor_delete_entity,
            monitor::commands::monitor_list_relations,
            monitor::commands::monitor_create_relation,
            monitor::commands::monitor_delete_relation
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
