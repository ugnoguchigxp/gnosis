pub mod cli;
pub mod collector;
pub mod commands;
pub mod models;
pub mod state;
pub mod ws;

use std::{
    net::TcpListener,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use rand::{distributions::Alphanumeric, Rng};
use tokio::net::TcpListener as TokioTcpListener;

use self::{
    collector::CollectorConfig,
    state::MonitorSharedState,
    ws::{run_server, WsServerContext},
};

pub const PROTOCOL_VERSION: u32 = 1;
const TIMELINE_CAPACITY: usize = 200;

#[derive(Clone)]
pub struct MonitorRuntime {
    pub ws_url: String,
    pub protocol_version: u32,
    pub project_root: PathBuf,
}

pub fn start() -> anyhow::Result<MonitorRuntime> {
    let monitor_state = Arc::new(MonitorSharedState::new(TIMELINE_CAPACITY));

    let access_token = generate_access_token();
    let std_listener =
        TcpListener::bind(("127.0.0.1", 0)).context("failed to bind websocket port")?;
    std_listener
        .set_nonblocking(true)
        .context("failed to set websocket listener nonblocking")?;
    let addr = std_listener
        .local_addr()
        .context("failed to resolve websocket listener address")?;

    let project_root = resolve_project_root()?;
    let logs_dir = project_root.join("logs").join("runs");

    let ws_context = WsServerContext {
        state: Arc::clone(&monitor_state),
        access_token: access_token.clone(),
        server_version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: PROTOCOL_VERSION,
    };

    tauri::async_runtime::spawn(async move {
        match TokioTcpListener::from_std(std_listener) {
            Ok(listener) => {
                if let Err(error) = run_server(listener, ws_context).await {
                    log::error!("monitor websocket server terminated: {error}");
                }
            }
            Err(error) => {
                log::error!("failed to create tokio websocket listener: {error}");
            }
        }
    });

    let collector_state = Arc::clone(&monitor_state);
    let collector_project_root = project_root.clone();
    let collector_config = CollectorConfig::with_defaults(collector_project_root, logs_dir);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = collector::run(collector_state, collector_config).await {
            log::error!("monitor collector terminated: {error}");
        }
    });

    Ok(MonitorRuntime {
        ws_url: format!(
            "ws://127.0.0.1:{}/monitor?token={access_token}",
            addr.port()
        ),
        protocol_version: PROTOCOL_VERSION,
        project_root,
    })
}

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn resolve_project_root() -> anyhow::Result<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .join("../../..")
        .canonicalize()
        .context("failed to resolve project root from tauri workspace")
}

fn generate_access_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect::<String>()
}
