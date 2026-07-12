use axum::Json;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use std::sync::Arc;

use super::types::{
    CiChecksQuery, CiFailureLogsQuery, GithubAddAccountRequest, GithubBindRepoRequest,
    GithubPollLoginRequest, GithubRemoveAccountRequest, GithubRepoPathBody, GithubResolveRepoQuery,
    GithubResolveReposRequest, GithubSetHideDraftsRequest, IssueActionRequest, IssuesQuery,
    PathQuery, PollRepoRequest, PrDiffQuery, SetVisibilityRequest, StartPollingRequest,
    UpdatePathsRequest,
};
use super::{err_500, json_result, validate_repo_path};
use crate::github_poller::PollerCmd;
use crate::state::AppState;

pub(super) async fn repo_github_status(Query(q): Query<PathQuery>) -> Response {
    if let Err(e) = validate_repo_path(&q.path) {
        return e.into_response();
    }
    let path = q.path;
    match tokio::task::spawn_blocking(move || crate::github::get_github_status_impl(&path)).await {
        Ok(status) => Json(status).into_response(),
        Err(e) => err_500(&format!("Task failed: {e}")),
    }
}

pub(super) async fn repo_pr_statuses(
    State(state): State<Arc<AppState>>,
    Query(q): Query<PathQuery>,
) -> Response {
    if let Err(e) = validate_repo_path(&q.path) {
        return e.into_response();
    }
    let path = q.path;
    if let Some(cached) = state.git_cache.github_status.get(&path) {
        return Json(&*cached).into_response();
    }
    match crate::github::get_repo_pr_statuses_impl(&path, false, &state).await {
        Ok(statuses) => Json(statuses).into_response(),
        Err(e) => err_500(&format!("Task failed: {e}")),
    }
}

pub(super) async fn repo_all_pr_statuses(
    State(state): State<Arc<AppState>>,
    Json(body): Json<super::types::GetAllPrStatusesRequest>,
) -> Response {
    let paths = body.paths;
    let include_merged = body.include_merged;
    match crate::github::get_all_pr_statuses_impl(&paths, include_merged, &state).await {
        Ok(statuses) => Json(statuses).into_response(),
        Err(e) => err_500(&e),
    }
}

pub(super) async fn repo_ci_checks(
    State(state): State<Arc<AppState>>,
    Query(q): Query<CiChecksQuery>,
) -> Response {
    if let Err(e) = validate_repo_path(&q.path) {
        return e.into_response();
    }
    let path = q.path;
    let pr_number = q.pr_number;
    Json(crate::github::get_ci_checks_impl(&path, pr_number, &state).await).into_response()
}

pub(super) async fn repo_approve_pr(
    State(state): State<Arc<AppState>>,
    Json(body): Json<super::types::ApprovePrRequest>,
) -> Response {
    if let Err(e) = validate_repo_path(&body.repo_path) {
        return e.into_response();
    }
    let path = body.repo_path;
    let pr = body.pr_number;
    match crate::github::approve_pr_impl(&path, pr, &state).await {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub(super) async fn repo_pr_diff(
    State(state): State<Arc<AppState>>,
    Query(q): Query<PrDiffQuery>,
) -> Response {
    if let Err(e) = validate_repo_path(&q.path) {
        return e.into_response();
    }
    let path = q.path;
    let pr = q.pr;
    match crate::github::get_pr_diff_impl(&path, pr, &state).await {
        Ok(diff) => diff.into_response(),
        Err(e) => (axum::http::StatusCode::BAD_GATEWAY, e).into_response(),
    }
}

pub(super) async fn repo_issues(
    State(state): State<Arc<AppState>>,
    Query(q): Query<IssuesQuery>,
) -> Response {
    if let Err(e) = validate_repo_path(&q.path) {
        return e.into_response();
    }
    let path = q.path;
    let filter = q.filter;
    match crate::github::get_all_issues_impl(std::slice::from_ref(&path), &filter, &state).await {
        Ok(mut results) => {
            let issues = results.remove(&path).unwrap_or_default();
            Json(issues).into_response()
        }
        Err(e) => err_500(&e),
    }
}

pub(super) async fn repo_close_issue(
    State(state): State<Arc<AppState>>,
    Json(body): Json<IssueActionRequest>,
) -> Response {
    if let Err(e) = validate_repo_path(&body.repo_path) {
        return e.into_response();
    }
    match crate::github::close_issue_impl(&body.repo_path, body.issue_number, &state).await {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub(super) async fn repo_reopen_issue(
    State(state): State<Arc<AppState>>,
    Json(body): Json<IssueActionRequest>,
) -> Response {
    if let Err(e) = validate_repo_path(&body.repo_path) {
        return e.into_response();
    }
    match crate::github::reopen_issue_impl(&body.repo_path, body.issue_number, &state).await {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

// --- GitHub poller HTTP handlers ---

pub(super) async fn poller_start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<StartPollingRequest>,
) -> Response {
    let guard = state.github_poller.lock();
    if let Some(poller) = guard.as_ref() {
        let _ = poller.cmd_tx.try_send(PollerCmd::UpdatePaths(body.paths));
        let _ = poller
            .cmd_tx
            .try_send(PollerCmd::SetIssueFilter(body.issue_filter));
    }
    Json(serde_json::json!({"ok": true})).into_response()
}

pub(super) async fn poller_stop(State(state): State<Arc<AppState>>) -> Response {
    let poller = state.github_poller.lock().take();
    if let Some(p) = poller {
        let _ = p.cmd_tx.send(PollerCmd::Stop).await;
    }
    Json(serde_json::json!({"ok": true})).into_response()
}

pub(super) async fn poller_set_visibility(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SetVisibilityRequest>,
) -> Response {
    if let Some(poller) = state.github_poller.lock().as_ref() {
        let _ = poller
            .cmd_tx
            .try_send(PollerCmd::SetVisibility(body.visible));
    }
    Json(serde_json::json!({"ok": true})).into_response()
}

pub(super) async fn poller_poll_repo(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PollRepoRequest>,
) -> Response {
    if let Some(poller) = state.github_poller.lock().as_ref() {
        let _ = poller.cmd_tx.try_send(PollerCmd::PollRepo(body.path));
    }
    Json(serde_json::json!({"ok": true})).into_response()
}

pub(super) async fn poller_update_paths(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UpdatePathsRequest>,
) -> Response {
    if let Some(poller) = state.github_poller.lock().as_ref() {
        let _ = poller.cmd_tx.try_send(PollerCmd::UpdatePaths(body.paths));
    }
    Json(serde_json::json!({"ok": true})).into_response()
}

pub(super) async fn api_debug_set(Json(body): Json<super::types::SetApiDebugRequest>) -> Response {
    crate::github_debug::set(body.enabled);
    Json(serde_json::json!({"ok": true, "enabled": body.enabled})).into_response()
}

pub(super) async fn api_debug_get() -> Response {
    let enabled = crate::github_debug::enabled();
    Json(serde_json::json!({"enabled": enabled})).into_response()
}

pub(super) async fn poller_set_issue_filter(
    State(state): State<Arc<AppState>>,
    Json(body): Json<super::types::SetIssueFilterRequest>,
) -> Response {
    if let Some(poller) = state.github_poller.lock().as_ref() {
        let _ = poller
            .cmd_tx
            .try_send(PollerCmd::SetIssueFilter(body.filter));
    }
    Json(serde_json::json!({"ok": true})).into_response()
}

pub(super) async fn github_viewer_login(State(state): State<Arc<AppState>>) -> Response {
    json_result(crate::github::get_viewer_login(&state).await)
}

pub(super) async fn ci_failure_logs(Query(q): Query<CiFailureLogsQuery>) -> Response {
    if let Err(e) = validate_repo_path(&q.repo_path) {
        return e.into_response();
    }
    json_result(crate::github::fetch_ci_failure_logs(q.repo_path, q.branch).await)
}

pub(super) async fn github_set_hide_drafts(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GithubSetHideDraftsRequest>,
) -> Response {
    json_result(crate::github_poller::github_set_pr_hide_drafts_impl(
        &state, body.hide,
    ))
}

pub(super) async fn github_start_login(State(state): State<Arc<AppState>>) -> Response {
    json_result(crate::github_auth::start_device_flow(&state.http_client).await)
}

pub(super) async fn github_poll_login(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GithubPollLoginRequest>,
) -> Response {
    json_result(crate::github_auth::github_poll_login_impl(&state, body.device_code).await)
}

pub(super) async fn github_logout(State(state): State<Arc<AppState>>) -> Response {
    json_result(crate::github_auth::github_logout_impl(&state).await)
}

pub(super) async fn github_disconnect(State(state): State<Arc<AppState>>) -> Response {
    json_result(crate::github_auth::github_disconnect_impl(&state).await)
}

pub(super) async fn github_auth_status(State(state): State<Arc<AppState>>) -> Response {
    json_result(crate::github_auth::github_auth_status_impl(&state).await)
}

pub(super) async fn github_diagnostics(State(state): State<Arc<AppState>>) -> Response {
    json_result(crate::github_auth::github_diagnostics_impl(&state).await)
}

// --- Multi-account: accounts + repo bindings (IPC/HTTP parity) ---

pub(super) async fn github_list_accounts() -> Response {
    Json(
        crate::github_account::GitHubAccountRegistry::load()
            .list()
            .to_vec(),
    )
    .into_response()
}

// Desktop-only: the add/remove/resolve impls in github_account.rs are
// #[cfg(feature = "desktop")] (keychain-backed). The remote daemon never serves
// GitHub routes (build_remote_router omits them), so gate these handlers to match
// their impls and keep the always-compiled lib building for tuic-remote (#094-ec55).
#[cfg(feature = "desktop")]
pub(super) async fn github_add_account(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GithubAddAccountRequest>,
) -> Response {
    json_result(crate::github_account::github_add_account_impl(&state, body.host, body.pat).await)
}

#[cfg(feature = "desktop")]
pub(super) async fn github_remove_account(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GithubRemoveAccountRequest>,
) -> Response {
    json_result(crate::github_account::github_remove_account_impl(
        &state, body.id,
    ))
}

pub(super) async fn github_list_bindings() -> Response {
    Json(crate::github_account::RepoBindingStore::load().entries()).into_response()
}

pub(super) async fn github_bind_repo(Json(body): Json<GithubBindRepoRequest>) -> Response {
    json_result(crate::github_account::bind_repo_to_account(
        std::path::Path::new(&body.repo_path),
        &body.account_id,
        &body.remote_name,
    ))
}

pub(super) async fn github_unbind_repo(Json(body): Json<GithubRepoPathBody>) -> Response {
    json_result(crate::github_account::unbind_repo(std::path::Path::new(
        &body.repo_path,
    )))
}

#[cfg(feature = "desktop")]
pub(super) async fn github_resolve_repo(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GithubResolveRepoQuery>,
) -> Response {
    json_result(crate::github_account::github_resolve_repo_impl(
        &state,
        q.repo_path,
    ))
}

#[cfg(feature = "desktop")]
pub(super) async fn github_resolve_repos(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GithubResolveReposRequest>,
) -> Response {
    Json(crate::github_account::github_resolve_repos_impl(
        &state,
        body.repo_paths,
    ))
    .into_response()
}
