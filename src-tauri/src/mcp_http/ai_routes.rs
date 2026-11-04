//! HTTP parity for FastAF's built-in AI engine commands (request/response only).
//! Loopback router only, matching the other AI/config surfaces. The conversation
//! token stream is `ai_stream::conversation_ws`.
//!
//! PR review and the improvement scan are served by upstream's
//! `github_routes::repo_pr_review` / `repo_improvement_scan`, which `mod.rs` also
//! mounts at FastAF's `/ai/review/pr` and `/ai/improvements/scan` paths.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use std::sync::Arc;

use super::guards::UserAuthenticated;
use super::{json_result, user_error_result};
use crate::AppState;
use crate::ai_agent::conversation_engine::APPROVAL_NOT_PENDING;

// ── AI chat: config + conversation CRUD (story 069 RPC slice) ──────────
// All commands are non-gated, State-free; handlers call them directly.
// chat_subscribe streaming is a dedicated WS endpoint (later plan step), not here.

#[derive(Deserialize)]
pub(super) struct ConversationIdRef {
    pub id: String,
}

pub(super) async fn ai_chat_config_get() -> impl IntoResponse {
    Json(crate::ai_chat::load_ai_chat_config())
}

pub(super) async fn ai_chat_config_put(
    Json(config): Json<crate::ai_chat::AiChatConfig>,
) -> Response {
    json_result(crate::ai_chat::save_ai_chat_config(config))
}

pub(super) async fn list_conversations_http() -> Response {
    json_result(crate::ai_chat::list_conversations())
}

pub(super) async fn load_conversation_http(Query(q): Query<ConversationIdRef>) -> Response {
    json_result(crate::ai_chat::load_conversation(q.id))
}

pub(super) async fn save_conversation_http(
    Json(conversation): Json<crate::ai_chat::Conversation>,
) -> Response {
    json_result(crate::ai_chat::save_conversation(conversation))
}

pub(super) async fn delete_conversation_http(Json(b): Json<ConversationIdRef>) -> Response {
    json_result(crate::ai_chat::delete_conversation(b.id))
}

pub(super) async fn new_conversation_id_http() -> Response {
    json_result(Ok::<String, String>(crate::ai_chat::new_conversation_id()))
}

// ── Agent loop control + session knowledge (story 068 RPC slice) ───
// start_conversation streaming is a dedicated WS endpoint (later plan step).

#[derive(Deserialize)]
pub(super) struct SessionIdRef {
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

/// Same shape as the `approve_conversation_action` IPC args.
#[derive(Deserialize)]
pub(super) struct ApproveActionRequest {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub approved: bool,
    #[serde(rename = "approvalId", default)]
    pub approval_id: Option<String>,
}

/// The AI engine's conversations belong to the user: only a caller whose
/// credentials the auth middleware checked (session cookie, URL token or Basic
/// Auth — a browser or PWA over TCP) may start, steer or answer one, or
/// schedule one to run later. The Unix socket admits every local process with
/// no credentials at all: agents in other tabs, scripts, a scheduled job's own
/// commands. Those get 403. The desktop app is unaffected: it uses Tauri IPC,
/// not these routes.
pub(super) fn deny_unless_user(
    user_auth: Option<&Extension<UserAuthenticated>>,
) -> Option<Response> {
    user_auth.is_none().then(|| {
        (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "AI conversations need a signed-in FastAF client: use FastAF itself"
            })),
        )
            .into_response()
    })
}

pub(super) async fn cancel_conversation_http(
    user_auth: Option<Extension<UserAuthenticated>>,
    Json(b): Json<SessionIdRef>,
) -> Response {
    if let Some(denied) = deny_unless_user(user_auth.as_ref()) {
        return denied;
    }
    json_result(crate::ai_agent::commands::cancel_conversation(b.session_id))
}

pub(super) async fn pause_conversation_http(
    user_auth: Option<Extension<UserAuthenticated>>,
    Json(b): Json<SessionIdRef>,
) -> Response {
    if let Some(denied) = deny_unless_user(user_auth.as_ref()) {
        return denied;
    }
    json_result(crate::ai_agent::commands::pause_conversation(b.session_id))
}

pub(super) async fn resume_conversation_http(
    user_auth: Option<Extension<UserAuthenticated>>,
    Json(b): Json<SessionIdRef>,
) -> Response {
    if let Some(denied) = deny_unless_user(user_auth.as_ref()) {
        return denied;
    }
    json_result(crate::ai_agent::commands::resume_conversation(b.session_id))
}

/// An approval is the user's answer (see [`deny_unless_user`]): a Unix-socket
/// caller gets 403 whatever id it sends.
pub(super) async fn approve_conversation_action_http(
    user_auth: Option<Extension<UserAuthenticated>>,
    Json(b): Json<ApproveActionRequest>,
) -> Response {
    if let Some(denied) = deny_unless_user(user_auth.as_ref()) {
        return denied;
    }
    user_error_result(
        crate::ai_agent::commands::approve_conversation_action(
            b.session_id,
            b.approved,
            b.approval_id,
        ),
        |error| error == APPROVAL_NOT_PENDING,
    )
}

pub(super) async fn get_session_knowledge_http(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SessionIdRef>,
) -> Response {
    json_result(crate::ai_agent::commands::get_session_knowledge_impl(
        &state,
        q.session_id,
    ))
}

pub(super) async fn toggle_ai_suggestions_http(
    State(state): State<Arc<AppState>>,
    Json(b): Json<SessionIdRef>,
) -> impl IntoResponse {
    Json(crate::ai_agent::commands::toggle_ai_suggestions_impl(
        &state,
        b.session_id,
    ))
}

// ── Scheduled tasks (`ai-cron.json`, Settings › AI Chat) ───────────────

pub(super) async fn scheduler_config_get() -> impl IntoResponse {
    Json(crate::ai_agent::commands::load_scheduler_config())
}

/// Same shape as the `add_scheduled_job` IPC args.
#[derive(Deserialize)]
pub(super) struct AddScheduledJobRequest {
    pub goal: String,
    pub every: u32,
    pub unit: crate::ai_agent::scheduler::IntervalUnit,
    #[serde(rename = "oneShot", default)]
    pub one_shot: Option<bool>,
}

/// Adding or replacing jobs is gated like starting a conversation: a job is a
/// conversation that starts later without anyone at the keyboard. Reading the
/// list stays open to local tools.
pub(super) async fn scheduler_job_add(
    user_auth: Option<Extension<UserAuthenticated>>,
    Json(b): Json<AddScheduledJobRequest>,
) -> Response {
    if let Some(denied) = deny_unless_user(user_auth.as_ref()) {
        return denied;
    }
    json_result(crate::ai_agent::commands::add_scheduled_job(
        b.goal, b.every, b.unit, b.one_shot,
    ))
}

pub(super) async fn scheduler_config_put(
    user_auth: Option<Extension<UserAuthenticated>>,
    Json(config): Json<crate::ai_agent::scheduler::SchedulerConfig>,
) -> Response {
    if let Some(denied) = deny_unless_user(user_auth.as_ref()) {
        return denied;
    }
    json_result(crate::ai_agent::commands::save_scheduler_config(config))
}

#[cfg(test)]
mod tests {
    use crate::ai_agent::conversation_engine::test_support;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Request, StatusCode, header};
    use futures_util::{SinkExt, StreamExt};
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tower::ServiceExt;

    const TOKEN: &str = "approve-route-token";

    fn state() -> Arc<crate::AppState> {
        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        *state.session_token.write() = TOKEN.into();
        state
    }

    /// The router the Unix socket serves: no credential check at all.
    fn uds_router() -> axum::Router {
        super::super::build_router(state(), false, true)
    }

    fn request(method: &str, uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "127.0.0.1:9876")
            .header(header::CONTENT_TYPE, "application/json")
            .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 40000))))
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn approve(uri: &str, session: &str, approval_id: Option<&str>) -> Request<Body> {
        request(
            "POST",
            uri,
            serde_json::json!({
                "sessionId": session,
                "approved": true,
                "approvalId": approval_id,
            }),
        )
    }

    async fn json(response: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// The Unix socket router (`remote_auth = false`) has no credential check,
    /// so an agent or script on it must not be able to approve anything — even
    /// with the right id in hand.
    #[tokio::test]
    async fn an_unauthenticated_unix_socket_caller_gets_403_and_approves_nothing() {
        let session = "approve-route-uds";
        let mut rx = test_support::arm_approval(session, "id-uds");
        let response = uds_router()
            .oneshot(approve("/ai/conversation/approve", session, Some("id-uds")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(
            rx.try_recv().is_err(),
            "the pending command was not approved"
        );
        test_support::end(session);
    }

    /// A browser or PWA user, credential-checked over TCP, answers their own
    /// conversation with the id from its stream.
    #[tokio::test]
    async fn an_authenticated_caller_with_the_pending_id_approves() {
        let session = "approve-route-tcp";
        let mut rx = test_support::arm_approval(session, "id-tcp");
        let app = super::super::build_router(state(), true, true);

        let wrong = app
            .clone()
            .oneshot(approve(
                &format!("/ai/conversation/approve?token={TOKEN}"),
                session,
                Some("id-guessed"),
            ))
            .await
            .unwrap();
        assert_eq!(wrong.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(rx.try_recv().is_err());

        let right = app
            .oneshot(approve(
                &format!("/ai/conversation/approve?token={TOKEN}"),
                session,
                Some("id-tcp"),
            ))
            .await
            .unwrap();
        assert_eq!(right.status(), StatusCode::OK);
        assert_eq!(rx.try_recv(), Ok(true));
        test_support::end(session);
    }

    /// Starting, steering or reading a conversation is the user's: a Unix-socket
    /// caller gets 403 on every conversation route, and nothing changes.
    #[tokio::test]
    async fn unix_socket_callers_cannot_start_or_steer_a_conversation() {
        let session = "steer-route-uds";
        drop(test_support::arm_approval(session, "id-steer"));
        let router = uds_router();
        for path in [
            "/ai/conversation/cancel",
            "/ai/conversation/pause",
            "/ai/conversation/resume",
        ] {
            let response = router
                .clone()
                .oneshot(request(
                    "POST",
                    path,
                    serde_json::json!({ "sessionId": session }),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
        }
        let cancelled = crate::ai_agent::conversation_engine::ACTIVE_CONVERSATIONS
            .get(session)
            .map(|h| h.cancel.load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(cancelled, Some(false), "the conversation was not cancelled");

        // The stream route refuses before looking at the upgrade, so even a
        // well-formed WebSocket handshake gets a plain 403.
        let stream = Request::get(format!("/ai/conversation/{session}/stream"))
            .header(header::HOST, "127.0.0.1:9876")
            .header(header::CONNECTION, "upgrade")
            .header(header::UPGRADE, "websocket")
            .header(header::SEC_WEBSOCKET_VERSION, "13")
            .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
            .body(Body::empty())
            .unwrap();
        let response = router.oneshot(stream).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        test_support::end(session);
    }

    /// Serve `router` on a loopback port, the way the desktop serves TCP.
    async fn serve(router: axum::Router) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        (addr, server)
    }

    /// A signed-in browser still opens the stream: the handshake succeeds and
    /// the bridge answers its first frame (here, bad start params, so no LLM is
    /// needed). The same handshake to the Unix-socket router is refused.
    #[tokio::test]
    async fn the_conversation_stream_opens_for_a_signed_in_caller_only() {
        let (addr, server) = serve(super::super::build_router(state(), true, true)).await;
        let (mut socket, _) = tokio_tungstenite::connect_async(format!(
            "ws://{addr}/ai/conversation/ws-route-tcp/stream?token={TOKEN}"
        ))
        .await
        .expect("an authenticated caller completes the handshake");
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                "not json".into(),
            ))
            .await
            .unwrap();
        let frame = socket.next().await.unwrap().unwrap().into_text().unwrap();
        let event: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(event["type"], "error");
        assert!(
            event["message"]
                .as_str()
                .unwrap()
                .contains("invalid start params"),
            "{event}"
        );
        server.abort();

        let (addr, server) = serve(uds_router()).await;
        let refused =
            tokio_tungstenite::connect_async(format!("ws://{addr}/ai/conversation/x/stream")).await;
        match refused {
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                assert_eq!(response.status(), StatusCode::FORBIDDEN);
            }
            other => panic!("expected a 403 handshake, got {other:?}"),
        }
        server.abort();
    }

    #[tokio::test]
    async fn scheduler_config_round_trips_and_add_builds_the_cron_string() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
        let router = super::super::build_router(state(), true, true);
        let config_uri = format!("/ai/scheduler/config?token={TOKEN}");
        let jobs_uri = format!("/ai/scheduler/jobs?token={TOKEN}");

        let put = router
            .clone()
            .oneshot(request(
                "PUT",
                &config_uri,
                serde_json::json!({ "jobs": [{
                    "id": "job-1", "cron_expr": "0 0/15 * * * *", "goal": "run tests",
                    "target_session": null, "max_duration_secs": 300,
                    "enabled": true, "one_shot": false
                }]}),
            ))
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::OK);

        let get = router
            .clone()
            .oneshot(request("GET", &config_uri, serde_json::json!(null)))
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::OK);
        let view = json(get).await;
        assert_eq!(view["jobs"][0]["id"], "job-1");
        assert_eq!(view["jobs"][0]["label"], "Every 15 min");
        assert!(view["jobs"][0]["next_run"].is_string(), "{view}");
        assert_eq!(
            view["choices"]["hours"],
            serde_json::json!([1, 2, 3, 4, 6, 8, 12])
        );

        // An uneven interval is refused and nothing is written.
        let uneven = router
            .clone()
            .oneshot(request(
                "PUT",
                &config_uri,
                serde_json::json!({ "jobs": [{ "id": "job-2", "cron_expr": "0 0/45 * * * *", "goal": "g" }] }),
            ))
            .await
            .unwrap();
        assert_ne!(uneven.status(), StatusCode::OK);
        assert_eq!(
            crate::ai_agent::scheduler::load_config().jobs[0].id,
            "job-1"
        );

        let added = router
            .oneshot(request(
                "POST",
                &jobs_uri,
                serde_json::json!({ "goal": "nightly audit", "every": 2, "unit": "hours", "oneShot": true }),
            ))
            .await
            .unwrap();
        assert_eq!(added.status(), StatusCode::OK);
        let view = json(added).await;
        assert_eq!(view["jobs"][1]["cron_expr"], "0 0 0/2 * * *");
        assert_eq!(view["jobs"][1]["label"], "Every 2 hours");
        assert_eq!(view["jobs"][1]["one_shot"], true);
    }

    // Catches: an agent or script on the Unix socket scheduling recurring AI
    // work, or replacing the user's jobs, with no one signed in.
    #[tokio::test]
    async fn unix_socket_callers_cannot_add_or_replace_scheduled_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
        let router = uds_router();
        let put = router
            .clone()
            .oneshot(request(
                "PUT",
                "/ai/scheduler/config",
                serde_json::json!({ "jobs": [{ "id": "job-x", "cron_expr": "0 0/15 * * * *", "goal": "g" }] }),
            ))
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::FORBIDDEN);
        let added = router
            .clone()
            .oneshot(request(
                "POST",
                "/ai/scheduler/jobs",
                serde_json::json!({ "goal": "g", "every": 15, "unit": "minutes" }),
            ))
            .await
            .unwrap();
        assert_eq!(added.status(), StatusCode::FORBIDDEN);
        assert_eq!(crate::ai_agent::scheduler::load_config().jobs.len(), 0);
        // Reading the list stays open to local tools.
        let get = router
            .oneshot(request(
                "GET",
                "/ai/scheduler/config",
                serde_json::json!(null),
            ))
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn the_suggestions_toggle_answers_the_new_state() {
        let router = uds_router();
        let mut answers = Vec::new();
        for _ in 0..2 {
            let response = router
                .clone()
                .oneshot(request(
                    "POST",
                    "/ai/suggestions/toggle",
                    serde_json::json!({ "sessionId": "toggle-route" }),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            answers.push(json(response).await);
        }
        // A plain shell starts off, so the first toggle turns it on.
        assert_eq!(answers, [serde_json::json!(true), serde_json::json!(false)]);
    }
}
