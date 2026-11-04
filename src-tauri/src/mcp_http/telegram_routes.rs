use super::guards::{Authenticated, require_local_or_auth};
use crate::{state::AppState, telegram::settings};
use axum::{
    Extension, Json,
    extract::{ConnectInfo, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use std::{net::SocketAddr, sync::Arc};

pub(super) async fn get(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: Option<Extension<Authenticated>>,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_local_or_auth(&addr, auth.is_some()) {
        return response.into_response();
    }
    match settings::read(&state) {
        Ok(value) => Json(value).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error":error.to_string()})),
        )
            .into_response(),
    }
}
#[derive(serde::Deserialize)]
pub(super) struct Request {
    change: settings::Change,
}
pub(super) async fn put(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: Option<Extension<Authenticated>>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<Request>,
) -> Response {
    if let Err(response) = require_local_or_auth(&addr, auth.is_some()) {
        return response.into_response();
    }
    match settings::change(&state, request.change).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error":error.to_string()})),
        )
            .into_response(),
    }
}
