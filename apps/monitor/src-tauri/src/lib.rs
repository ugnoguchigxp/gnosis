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
            monitor::commands::monitor_list_tasks,
            monitor::commands::monitor_task_detail,
            monitor::commands::monitor_graph_snapshot,
            monitor::commands::monitor_enqueue_task,
            monitor::commands::monitor_list_episodes,
            monitor::commands::monitor_delete_episode,
            monitor::commands::monitor_register_episode,
            monitor::commands::monitor_consolidate_session,
            monitor::commands::monitor_list_lessons,
            monitor::commands::monitor_create_lesson,
            monitor::commands::monitor_update_lesson,
            monitor::commands::monitor_delete_lesson,
            monitor::commands::monitor_list_guidance,
            monitor::commands::monitor_create_guidance,
            monitor::commands::monitor_update_guidance,
            monitor::commands::monitor_delete_guidance,
            monitor::commands::monitor_list_keyword_evaluations,
            monitor::commands::monitor_delete_keyword_evaluation
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
