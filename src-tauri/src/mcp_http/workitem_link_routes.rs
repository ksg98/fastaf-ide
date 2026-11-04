//! HTTP twins of the `workitem_links` IPC commands (story 1685-4b12).
use axum::extract::{ConnectInfo, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use std::net::SocketAddr;

use super::guards::{Authenticated, require_local_or_auth};
use super::types::PathQuery;
use super::{json_result, validate_repo_path};
use crate::workitem_links::{self as links, WorkItemLink};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LinkRequest {
    repo_path: String,
    branch: String,
    link: WorkItemLink,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UnlinkRequest {
    repo_path: String,
    branch: String,
}

fn bad_request(msg: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error": msg})),
    )
        .into_response()
}

pub(super) async fn list(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: Option<Extension<Authenticated>>,
) -> Response {
    if let Err(resp) = require_local_or_auth(&addr, auth.is_some()) {
        return resp.into_response();
    }
    json_result(links::list_workitem_links().await)
}

pub(super) async fn link(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: Option<Extension<Authenticated>>,
    Json(body): Json<LinkRequest>,
) -> Response {
    if let Err(resp) = require_local_or_auth(&addr, auth.is_some()) {
        return resp.into_response();
    }
    if let Err(e) = links::validate(&body.repo_path, &body.branch, &body.link) {
        return bad_request(e);
    }
    json_result(links::link_workitem(body.repo_path, body.branch, body.link).await)
}

pub(super) async fn unlink(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: Option<Extension<Authenticated>>,
    Json(body): Json<UnlinkRequest>,
) -> Response {
    if let Err(resp) = require_local_or_auth(&addr, auth.is_some()) {
        return resp.into_response();
    }
    json_result(links::unlink_workitem(body.repo_path, body.branch).await)
}

pub(super) async fn remotes(Query(q): Query<PathQuery>) -> Response {
    if let Err(e) = validate_repo_path(&q.path) {
        return e.into_response();
    }
    json_result(links::get_git_remotes(q.path).await)
}
