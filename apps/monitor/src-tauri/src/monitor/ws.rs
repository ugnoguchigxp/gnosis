use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use anyhow::Context;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::StreamExt;
use tokio::{
    net::TcpListener,
    sync::broadcast::error::{RecvError, TryRecvError},
    time::{interval, timeout, Duration},
};

use crate::monitor::{
    models::{ClientHello, OutboundBroadcast, ServerMessage},
    now_millis,
    state::MonitorSharedState,
};

#[derive(Clone)]
pub struct WsServerContext {
    pub state: Arc<MonitorSharedState>,
    pub access_token: String,
    pub server_version: String,
    pub protocol_version: u32,
}

pub async fn run_server(listener: TcpListener, context: WsServerContext) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/monitor", get(ws_upgrade_handler))
        .with_state(context);

    axum::serve(listener, app)
        .await
        .context("monitor websocket server stopped unexpectedly")?;

    Ok(())
}

async fn ws_upgrade_handler(
    ws: WebSocketUpgrade,
    State(context): State<WsServerContext>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let Some(token) = query.get("token") else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    if token != &context.access_token {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    ws.on_upgrade(move |socket| handle_socket(socket, context))
        .into_response()
}

async fn send_json(socket: &mut WebSocket, payload: &ServerMessage) -> anyhow::Result<()> {
    let message =
        serde_json::to_string(payload).context("failed to serialize websocket payload")?;
    socket
        .send(Message::Text(message.into()))
        .await
        .context("failed to send websocket message")?;
    Ok(())
}

async fn handle_socket(mut socket: WebSocket, context: WsServerContext) {
    if let Err(error) = perform_hello(&mut socket, &context).await {
        log::warn!("websocket hello failed: {error}");
        return;
    }

    // Subscribe first to avoid losing events emitted during initial sync.
    let mut receiver = context.state.subscribe();
    let snapshot = context.state.snapshot().await;
    if let Err(error) = send_json(
        &mut socket,
        &ServerMessage::Snapshot {
            ts: snapshot.ts,
            data: snapshot.data,
        },
    )
    .await
    {
        log::warn!("failed to send initial snapshot: {error}");
        return;
    }

    // Send current timeline backlog first so the UI has immediate context.
    let backlog = context.state.timeline().await;
    let backlog_ids: HashSet<String> = backlog.iter().map(|event| event.id.clone()).collect();
    for event in backlog {
        if let Err(error) = send_json(
            &mut socket,
            &ServerMessage::Event {
                ts: event.ts,
                event,
            },
        )
        .await
        {
            log::warn!("failed to send backlog event: {error}");
            return;
        }
    }

    let drained = drain_initial_broadcasts(&mut receiver, &backlog_ids);
    if drained.lagged {
        let snapshot = context.state.snapshot().await;
        if let Err(error) = send_json(
            &mut socket,
            &ServerMessage::Snapshot {
                ts: snapshot.ts,
                data: snapshot.data,
            },
        )
        .await
        {
            log::warn!("failed to send initial resync snapshot: {error}");
            return;
        }
    }

    for message in drained.pending {
        match message {
            OutboundBroadcast::Snapshot(snapshot) => {
                if let Err(error) = send_json(
                    &mut socket,
                    &ServerMessage::Snapshot {
                        ts: snapshot.ts,
                        data: snapshot.data,
                    },
                )
                .await
                {
                    log::warn!("failed to send drained snapshot: {error}");
                    return;
                }
            }
            OutboundBroadcast::Event(event) => {
                if let Err(error) = send_json(
                    &mut socket,
                    &ServerMessage::Event {
                        ts: event.ts,
                        event,
                    },
                )
                .await
                {
                    log::warn!("failed to send drained event: {error}");
                    return;
                }
            }
        }
    }

    let mut heartbeat = interval(Duration::from_secs(10));
    heartbeat.tick().await;

    loop {
        tokio::select! {
          _ = heartbeat.tick() => {
            if let Err(error) = send_json(
              &mut socket,
              &ServerMessage::Heartbeat { ts: now_millis() },
            ).await {
              log::debug!("heartbeat send failed; closing connection: {error}");
              break;
            }
          }
          next_message = receiver.recv() => {
            match next_message {
              Ok(OutboundBroadcast::Snapshot(snapshot)) => {
                if let Err(error) = send_json(
                  &mut socket,
                  &ServerMessage::Snapshot { ts: snapshot.ts, data: snapshot.data },
                ).await {
                  log::debug!("snapshot send failed; closing connection: {error}");
                  break;
                }
              }
              Ok(OutboundBroadcast::Event(event)) => {
                if let Err(error) = send_json(
                  &mut socket,
                  &ServerMessage::Event { ts: event.ts, event },
                ).await {
                  log::debug!("event send failed; closing connection: {error}");
                  break;
                }
              }
              Err(RecvError::Lagged(skipped)) => {
                log::warn!("monitor websocket receiver lagged by {skipped} messages; resync snapshot");
                let snapshot = context.state.snapshot().await;
                if let Err(error) = send_json(
                  &mut socket,
                  &ServerMessage::Snapshot { ts: snapshot.ts, data: snapshot.data },
                ).await {
                  log::debug!("snapshot resync failed; closing connection: {error}");
                  break;
                }
              }
              Err(RecvError::Closed) => {
                break;
              }
            }
          }
          inbound = socket.next() => {
            match inbound {
              Some(Ok(Message::Close(_))) | None => break,
              Some(Ok(Message::Ping(payload))) => {
                if let Err(error) = socket.send(Message::Pong(payload)).await {
                  log::debug!("pong failed; closing connection: {error}");
                  break;
                }
              }
              Some(Ok(Message::Pong(_))) => {}
              Some(Ok(Message::Text(_))) => {}
              Some(Ok(Message::Binary(_))) => {}
              Some(Err(error)) => {
                log::debug!("socket receive failed: {error}");
                break;
              }
            }
          }
        }
    }
}

#[derive(Default)]
struct InitialDrain {
    pending: Vec<OutboundBroadcast>,
    lagged: bool,
}

fn drain_initial_broadcasts(
    receiver: &mut tokio::sync::broadcast::Receiver<OutboundBroadcast>,
    backlog_ids: &HashSet<String>,
) -> InitialDrain {
    let mut output = InitialDrain::default();

    loop {
        match receiver.try_recv() {
            Ok(OutboundBroadcast::Event(event)) => {
                if !backlog_ids.contains(&event.id) {
                    output.pending.push(OutboundBroadcast::Event(event));
                }
            }
            Ok(OutboundBroadcast::Snapshot(snapshot)) => {
                output.pending.push(OutboundBroadcast::Snapshot(snapshot));
            }
            Err(TryRecvError::Lagged(_)) => {
                output.lagged = true;
            }
            Err(TryRecvError::Empty) | Err(TryRecvError::Closed) => {
                break;
            }
        }
    }

    output
}

async fn perform_hello(socket: &mut WebSocket, context: &WsServerContext) -> anyhow::Result<()> {
    let first_message = timeout(Duration::from_secs(8), socket.next())
        .await
        .context("hello timeout")?
        .ok_or_else(|| anyhow::anyhow!("connection closed before hello"))??;

    let payload = match first_message {
        Message::Text(text) => text.to_string(),
        _ => {
            anyhow::bail!("first websocket message must be text hello")
        }
    };

    let hello: ClientHello = serde_json::from_str(&payload).context("invalid hello message")?;
    if hello.message_type != "hello" {
        anyhow::bail!("unexpected hello message type")
    }

    log::info!(
        "monitor websocket connected, clientVersion={}",
        hello
            .client_version
            .unwrap_or_else(|| "unknown".to_string())
    );

    send_json(
        socket,
        &ServerMessage::HelloAck {
            server_version: context.server_version.clone(),
            protocol_version: context.protocol_version,
        },
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use tokio::sync::broadcast;

    use crate::monitor::models::{
        EvalSnapshot, MonitorSnapshotData, OutboundBroadcast, QueueSnapshot, SnapshotEnvelope,
        TaskIndexEntry, TimelineEvent, WorkerSnapshot,
    };

    use super::drain_initial_broadcasts;

    fn sample_event(id: &str, ts: i64) -> TimelineEvent {
        TimelineEvent {
            id: id.to_string(),
            kind: "task.done".to_string(),
            ts,
            run_id: Some("run-1".to_string()),
            task_id: Some("task-1".to_string()),
            result_summary: None,
            error_reason: None,
            message: None,
        }
    }

    fn sample_snapshot(ts: i64) -> SnapshotEnvelope {
        SnapshotEnvelope {
            ts,
            data: MonitorSnapshotData {
                queue: QueueSnapshot::default(),
                worker: WorkerSnapshot::default(),
                eval: EvalSnapshot::default(),
                task_index: vec![TaskIndexEntry {
                    task_id: "task-1".to_string(),
                    topic: Some("topic".to_string()),
                    source: Some("user".to_string()),
                    status: "done".to_string(),
                    updated_at_ts: Some(ts),
                }],
            },
        }
    }

    #[test]
    fn drain_initial_broadcasts_skips_backlog_duplicates() {
        let (sender, mut receiver) = broadcast::channel(8);
        let duplicate = sample_event("event-1", 1000);
        let fresh = sample_event("event-2", 1001);
        sender
            .send(OutboundBroadcast::Event(duplicate))
            .expect("send duplicate event");
        sender
            .send(OutboundBroadcast::Event(fresh.clone()))
            .expect("send fresh event");
        sender
            .send(OutboundBroadcast::Snapshot(sample_snapshot(1002)))
            .expect("send snapshot");

        let mut backlog_ids = HashSet::new();
        backlog_ids.insert("event-1".to_string());

        let drained = drain_initial_broadcasts(&mut receiver, &backlog_ids);
        assert!(!drained.lagged);
        assert_eq!(drained.pending.len(), 2);
        assert!(matches!(
            drained.pending.first(),
            Some(OutboundBroadcast::Event(event)) if event.id == fresh.id
        ));
        assert!(matches!(
            drained.pending.last(),
            Some(OutboundBroadcast::Snapshot(_))
        ));
    }

    #[test]
    fn drain_initial_broadcasts_marks_lagged_receiver() {
        let (sender, mut receiver) = broadcast::channel(1);
        sender
            .send(OutboundBroadcast::Event(sample_event("event-a", 1)))
            .expect("send event a");
        sender
            .send(OutboundBroadcast::Event(sample_event("event-b", 2)))
            .expect("send event b");

        let drained = drain_initial_broadcasts(&mut receiver, &HashSet::new());
        assert!(drained.lagged);
    }
}
