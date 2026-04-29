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
            monitor::commands::monitor_task_detail,
            monitor::commands::monitor_graph_snapshot,
            monitor::commands::monitor_enqueue_task,
            monitor::commands::monitor_list_lessons,
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
