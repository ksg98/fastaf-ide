//! Dedicated per-session WebSocket bridge for FastAF's engine conversation
//! token stream — event-bridge plan Step 3. It deliberately does
//! NOT ride the global `event_bus`/SSE: a single conversation emits 20+ events/sec,
//! which would exhaust the 256-cap broadcast and Lag unrelated SSE consumers.
//! Each connection taps the same engine stream the desktop Tauri Channel uses, so
//! browser/PWA clients get byte-identical `ConversationEvent` frames.
//!
//! The chat-registry stream (`/ai/chat/{id}/stream`) is not restored: it had no
//! producer and no frontend consumer.

use std::sync::Arc;

use axum::Extension;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use futures_util::stream::{SplitSink, StreamExt};
use serde::{Deserialize, Serialize};

use super::guards::UserAuthenticated;
use crate::AppState;
use crate::ai_agent::conversation_engine::{
    ConversationEvent, batched_conversation_stream, build_config,
    start_conversation as engine_start, subscribe_conversation,
};

/// A session id as a path segment: 1-64 characters of alphanumerics, `-`, `_`.
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err("ID must be 1-64 characters".to_string());
    }
    if !id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err("ID must be alphanumeric, dash, or underscore".to_string());
    }
    Ok(())
}

/// Serialize a frame to JSON and push it down the socket. Returns false if the
/// client has disconnected.
async fn send_json<T: Serialize>(sink: &mut SplitSink<WebSocket, Message>, frame: &T) -> bool {
    let Ok(json) = serde_json::to_string(frame) else {
        // Skip an unserializable frame but keep the stream alive — log it so a
        // silent gap in the client's stream is at least visible server-side.
        tracing::warn!("ai_stream: failed to serialize frame, skipping");
        return true;
    };
    futures_util::SinkExt::send(sink, Message::Text(json.into()))
        .await
        .is_ok()
}

/// Start params for a conversation stream — mirrors the `start_conversation`
/// Tauri command args (minus `sessionId`, which is in the path, and `onEvent`,
/// which is the WebSocket itself). Sent by the client as the first text frame.
#[derive(Deserialize)]
struct StartConversationParams {
    message: String,
    autonomy: Option<String>,
    #[serde(rename = "maxSteps")]
    max_steps: Option<usize>,
    temperature: Option<f32>,
    #[serde(rename = "modelOverride")]
    model_override: Option<String>,
    #[serde(rename = "bypassedTools")]
    bypassed_tools: Option<Vec<String>>,
    #[serde(rename = "reasoningEffort")]
    reasoning_effort: Option<String>,
}

/// `GET /ai/conversation/{session_id}/stream` — WebSocket upgrade.
///
/// Starts a conversation (Autonomous included) or re-attaches to a running
/// one, whose frames carry approval ids — so, like the other conversation
/// routes, only a credential-checked caller may open it. Refused before the
/// upgrade: a Unix-socket caller gets a plain 403.
pub(super) async fn conversation_ws(
    user_auth: Option<Extension<UserAuthenticated>>,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    Path(session_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Response {
    // Caller first, upgrade second: an unauthenticated caller learns nothing
    // about the route, whatever its request looks like.
    if let Some(denied) = super::ai_routes::deny_unless_user(user_auth.as_ref()) {
        return denied;
    }
    match ws {
        Ok(ws) => ws.on_upgrade(move |socket| bridge_conversation(socket, session_id, state)),
        Err(rejection) => rejection.into_response(),
    }
}

async fn bridge_conversation(socket: WebSocket, session_id: String, state: Arc<AppState>) {
    let (mut sink, mut stream) = socket.split();

    // Validate the session id up front.
    if let Err(e) = validate_id(&session_id) {
        let _ = send_json(&mut sink, &ConversationEvent::Error { message: e }).await;
        return;
    }

    // First frame carries the start params (atomic start+subscribe — no
    // POST-then-subscribe race where early TextChunks would be missed).
    let params: StartConversationParams = match stream.next().await {
        Some(Ok(Message::Text(t))) => match serde_json::from_str(&t) {
            Ok(p) => p,
            Err(e) => {
                let _ = send_json(
                    &mut sink,
                    &ConversationEvent::Error {
                        message: format!("invalid start params: {e}"),
                    },
                )
                .await;
                return;
            }
        },
        _ => return, // closed before sending params
    };

    let config = build_config(
        params.autonomy,
        params.max_steps,
        params.temperature,
        params.model_override,
        params.bypassed_tools,
        params.reasoning_effort,
    )
    .await;

    let rx = match engine_start(state, session_id.clone(), params.message, config).await {
        Ok(rx) => rx,
        // A conversation is already running on this session — re-attach to its
        // live stream instead of erroring. The reconnecting client keeps its own
        // transcript, so live events (no backfill) resume the stream. If the
        // conversation ended in the race between start and subscribe, surface the
        // original start error.
        Err(e) => match subscribe_conversation(&session_id) {
            Some(rx) => rx,
            None => {
                let _ = send_json(&mut sink, &ConversationEvent::Error { message: e }).await;
                return;
            }
        },
    };

    // Same 50ms batcher the desktop Channel bridge uses. A client disconnect
    // surfaces as a send error; we stop forwarding but leave the conversation
    // running (matches desktop: closing the panel doesn't cancel — use the
    // explicit cancel endpoint). The batcher task ends when its mpsc is dropped.
    let mut batched = batched_conversation_stream(rx);
    while let Some(ev) = batched.recv().await {
        if !send_json(&mut sink, &ev).await {
            break;
        }
    }
}
