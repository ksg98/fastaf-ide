//! One IPC/HTTP entry point for durable tabs and verified resume commands.
use crate::{AppState, suspended_sessions};
use axum::{
    Extension, Json,
    extract::{ConnectInfo, State},
    response::{IntoResponse, Response},
};
use std::sync::Arc;

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn suspended_session_action(
    state: tauri::State<'_, Arc<AppState>>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    dispatch(state.inner().clone(), request).await
}

pub(crate) async fn dispatch(
    state: Arc<AppState>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || action(&state, &request))
        .await
        .map_err(|e| e.to_string())?
}

fn action(state: &Arc<AppState>, request: &serde_json::Value) -> Result<serde_json::Value, String> {
    match request["action"].as_str().unwrap_or_default() {
        "list" => serde_json::to_value(suspended_sessions::list()?).map_err(|e| e.to_string()),
        "resolve_resume" => {
            let input =
                serde_json::from_value::<crate::session_resume::ResumeRequest>(request.clone())
                    .map_err(|e| e.to_string())?;
            serde_json::to_value(crate::session_resume::resolve(&input)).map_err(|e| e.to_string())
        }
        "suspend" => {
            let session_id = request["sessionId"]
                .as_str()
                .ok_or("sessionId is required")?;
            suspended_sessions::suspend(state, session_id, &request["metadata"])?;
            Ok(serde_json::json!({"ok": true}))
        }
        "sync" => {
            let session_id = request["sessionId"]
                .as_str()
                .ok_or("sessionId is required")?;
            if state.session_maps.sessions.contains_key(session_id) {
                state
                    .suspend_metadata
                    .insert(session_id.into(), request["metadata"].clone());
            }
            Ok(serde_json::json!({"ok": true}))
        }
        "forget" => {
            let identity = request["tuicSession"]
                .as_str()
                .ok_or("tuicSession is required")?;
            suspended_sessions::remove(identity)?;
            state.hibernated_peers.remove(identity);
            Ok(serde_json::json!({"ok": true}))
        }
        "resume" => {
            let identity = request["tuicSession"]
                .as_str()
                .ok_or("tuicSession is required")?;
            let session_id = crate::session_wake::ensure_live(state, identity)?;
            Ok(serde_json::json!({"ok": true, "session_id": session_id}))
        }
        _ => Err("Unknown suspended session action".into()),
    }
}

pub(super) async fn action_http(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    auth: Option<Extension<super::guards::Authenticated>>,
    Json(request): Json<serde_json::Value>,
) -> Response {
    if let Err(response) = super::guards::require_local_or_auth(&addr, auth.is_some()) {
        return response.into_response();
    }
    match dispatch(state, request).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": error})),
        )
            .into_response(),
    }
}

/// IPC and HTTP share the same durable wake transition.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn resume_session(
    state: tauri::State<'_, Arc<AppState>>,
    tuic_session: String,
) -> Result<serde_json::Value, String> {
    dispatch(
        state.inner().clone(),
        serde_json::json!({"action": "resume", "tuicSession": tuic_session}),
    )
    .await
}

pub(super) async fn resume_http(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    auth: Option<Extension<super::guards::Authenticated>>,
    Json(request): Json<serde_json::Value>,
) -> Response {
    action_http(
        State(state),
        ConnectInfo(addr),
        auth,
        Json(serde_json::json!({"action": "resume", "tuicSession": request["tuicSession"]})),
    )
    .await
}
