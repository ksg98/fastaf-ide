use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartBody {
    session_id: String,
    browser: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StopBody {
    repo_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NavigateBody {
    repo_path: String,
    url: String,
}

fn response(result: Result<serde_json::Value, String>) -> Response {
    match result {
        Ok(status) => (StatusCode::OK, Json(status)).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response(),
    }
}

pub(crate) async fn start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<StartBody>,
) -> Response {
    response(super::start(&state, body.session_id, body.browser, body.url).await)
}

pub(crate) async fn stop(
    State(state): State<Arc<AppState>>,
    Json(body): Json<StopBody>,
) -> Response {
    response(super::stop(&state, &body.repo_path).await)
}

pub(crate) async fn reload(
    State(state): State<Arc<AppState>>,
    Json(body): Json<StopBody>,
) -> Response {
    response(super::reload(&state, &body.repo_path).await)
}

pub(crate) async fn navigate(
    State(state): State<Arc<AppState>>,
    Json(body): Json<NavigateBody>,
) -> Response {
    response(super::navigate(&state, &body.repo_path, &body.url).await)
}

pub(crate) async fn statuses(State(state): State<Arc<AppState>>) -> Json<Vec<serde_json::Value>> {
    Json(super::statuses(&state).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserCommandBody {
    repo_path: String,
    action: String,
    #[serde(default)]
    args: serde_json::Value,
}
pub(crate) async fn browser_command(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserCommandBody>,
) -> Response {
    response(super::browser_command(&state, &body.repo_path, &body.action, body.args).await)
}
