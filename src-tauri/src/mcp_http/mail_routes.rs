//! Durable mail adapters. Identity is the existing MCP binding, never a body field.
use std::{convert::Infallible, net::SocketAddr, sync::Arc};

use axum::{
    Json,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
};
use serde_json::{Value, json};

use crate::{AppState, mail_subscriptions};

fn peer(
    state: &AppState,
    addr: SocketAddr,
    headers: &HeaderMap,
) -> Result<String, (StatusCode, &'static str)> {
    if !addr.ip().is_loopback() {
        return Err((
            StatusCode::FORBIDDEN,
            "Inter-agent messaging is restricted to localhost connections",
        ));
    }
    if !state.config.read().mcp_capabilities.allows("agent", None) {
        return Err((
            StatusCode::FORBIDDEN,
            "Tool 'agent' is disabled by configuration",
        ));
    }
    headers
        .get("mcp-session-id")
        .and_then(|h| h.to_str().ok())
        .and_then(|id| state.mcp.to_session.get(id).map(|p| p.value().clone()))
        .ok_or((
            StatusCode::UNAUTHORIZED,
            "Register an MCP peer first and supply its Mcp-Session-Id header",
        ))
}

pub(super) async fn action(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(args): Json<Value>,
) -> Response {
    let peer = match peer(&state, addr, &headers) {
        Ok(peer) => peer,
        Err(reply) => return reply.into_response(),
    };
    if !matches!(
        args["action"].as_str(),
        Some("subscribe" | "ack" | "unsubscribe" | "inbox")
    ) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"Use subscribe, ack, unsubscribe or inbox"})),
        )
            .into_response();
    }
    Json(mail_subscriptions::read(&state, &peer, &args).await).into_response()
}

/// One connection carries all actionable batches; routine traffic does not emit.
/// Reconnect replays an unacknowledged batch; acknowledging it resumes the stream.
pub(super) async fn events(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let peer = match peer(&state, addr, &headers) {
        Ok(peer) => peer,
        Err(reply) => return reply.into_response(),
    };
    let mut changes = state.subscribe_agent_inbox(&peer);
    let args = json!({"action":"inbox","subscription_id":id});
    let first = mail_subscriptions::read(&state, &peer, &args).await;
    if first.get("error").is_some() {
        return (StatusCode::BAD_REQUEST, Json(first)).into_response();
    }
    let stream = async_stream::stream! {
        let mut next = Some(first);
        let mut last_cursor = None;
        loop {
            let batch = match next.take() {
                Some(batch) => batch,
                None => mail_subscriptions::read(&state, &peer, &args).await,
            };
            if batch.get("error").is_some() {
                yield Ok::<_,Infallible>(Event::default().event("error").data(batch.to_string()));
                break;
            }
            let cursor = batch["cursor"].as_u64().unwrap_or(0);
            if mail_subscriptions::pending(&batch) && last_cursor != Some(cursor) {
                last_cursor = Some(cursor);
                yield Ok(Event::default().event("mail").id(cursor.to_string()).data(batch.to_string()));
            }
            if changes.changed().await.is_err() { break; }
        }
    };
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    // Catches: HTTP subscription operations use an independent validation path,
    // or the continuous stream returns routine lifecycle traffic as actionable.
    #[tokio::test]
    async fn actionable_subscription_http_stream_filters_and_acknowledges() {
        let state = super::super::tests::test_state();
        state
            .mcp
            .to_session
            .insert("mail-http".into(), "parent".into());
        let mut headers = HeaderMap::new();
        headers.insert("mcp-session-id", "mail-http".parse().unwrap());
        let addr: SocketAddr = "127.0.0.1:1234".parse().unwrap();
        let reply = action(
            State(state.clone()),
            ConnectInfo(addr),
            headers.clone(),
            Json(json!({"action":"subscribe","subscription_id":"http"})),
        )
        .await;
        assert_eq!(reply.status(), StatusCode::OK);
        let mut routine = crate::state::AgentMessage {
            id: "tuic-auto-http-idle".into(),
            from_tuic_session: "child".into(),
            from_name: "tuic".into(),
            content: r#"{"type":"state_change","state":"idle"}"#.into(),
            timestamp: 1,
            delivered_via_channel: false,
        };
        state.push_agent_inbox("parent", routine.clone());
        let response = events(
            State(state.clone()),
            ConnectInfo(addr),
            headers.clone(),
            Path("http".into()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let mut stream = response.into_body().into_data_stream();
        let mut first = Box::pin(stream.next());
        assert!(
            futures_util::poll!(first.as_mut()).is_pending(),
            "no lifecycle event"
        );
        routine.id = "http-result".into();
        routine.from_name = "child".into();
        routine.content = "RESULT http stream".into();
        state.push_agent_inbox("parent", routine);
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), first)
            .await
            .expect("HTTP stream must carry result")
            .unwrap()
            .unwrap();
        let text = std::str::from_utf8(&frame).unwrap();
        assert!(text.contains("RESULT http stream"), "{text}");
        assert!(!text.contains("tuic-auto-http-idle"), "{text}");
        let batch = mail_subscriptions::read(
            &state,
            "parent",
            &json!({"action":"inbox","subscription_id":"http"}),
        )
        .await;
        let response = action(
            State(state.clone()),
            ConnectInfo(addr),
            headers.clone(),
            Json(json!({"action":"ack","subscription_id":"http","cursor":batch["cursor"]})),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            mail_subscriptions::read(
                &state,
                "parent",
                &json!({"action":"inbox","subscription_id":"http"})
            )
            .await["count"],
            0
        );
        let denied = events(
            State(state.clone()),
            ConnectInfo("192.0.2.1:1234".parse().unwrap()),
            headers.clone(),
            Path("http".into()),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let denied = events(
            State(state),
            ConnectInfo(addr),
            HeaderMap::new(),
            Path("http".into()),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    }
}
