use std::io::BufReader;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::profile::TunnelProfile;
use super::storage::ProfileStore;
use crate::AppState;

/// JSON error helper.
fn err_json(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({"error": msg}))).into_response()
}

// ── Profile CRUD ────────────────────────────────────────────

/// GET /tunnels/profiles — list all saved profiles.
pub(crate) async fn list_tunnel_profiles(State(state): State<Arc<AppState>>) -> Response {
    match ProfileStore::load_all(&state.data_dir, None) {
        Ok(profiles) => (StatusCode::OK, Json(serde_json::json!(profiles))).into_response(),
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// POST /tunnels/profiles — create or update a profile.
pub(crate) async fn save_tunnel_profile(
    State(state): State<Arc<AppState>>,
    Json(mut profile): Json<TunnelProfile>,
) -> Response {
    if let Err(e) = profile.validate() {
        return err_json(StatusCode::BAD_REQUEST, &e);
    }
    match ProfileStore::save(&state.data_dir, &profile) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"id": profile.id}))).into_response(),
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// DELETE /tunnels/profiles/:id — delete a profile, stopping its tunnel if active.
pub(crate) async fn delete_tunnel_profile(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    state.tunnel_manager.stop_if_running(&id);

    match ProfileStore::delete(&state.data_dir, None, &id) {
        Ok(true) => (StatusCode::OK, Json(serde_json::json!({"deleted": true}))).into_response(),
        Ok(false) => err_json(StatusCode::NOT_FOUND, "profile not found"),
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

// ── Tunnel lifecycle ────────────────────────────────────────

/// POST /tunnels/start/:id — load profile from storage and start its tunnel.
pub(crate) async fn start_tunnel(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let profiles = match ProfileStore::load_all(&state.data_dir, None) {
        Ok(p) => p,
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };

    let profile = match profiles.into_iter().find(|p| p.id == id) {
        Some(p) => p,
        None => return err_json(StatusCode::NOT_FOUND, "profile not found"),
    };

    let result = state.tunnel_manager.start(profile).await;

    match result {
        Ok(tunnel_id) => {
            (StatusCode::OK, Json(serde_json::json!({"id": tunnel_id}))).into_response()
        }
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

/// POST /tunnels/stop/:id — stop an active tunnel.
pub(crate) async fn stop_tunnel(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    match state.tunnel_manager.stop(&id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"stopped": true}))).into_response(),
        Err(e) => err_json(StatusCode::NOT_FOUND, &e),
    }
}

// ── Status queries ──────────────────────────────────────────

/// GET /tunnels/active — list all running tunnels with status.
pub(crate) async fn list_active_tunnels(State(state): State<Arc<AppState>>) -> Response {
    let list = state.tunnel_manager.list();
    let entries: Vec<serde_json::Value> = list
        .into_iter()
        .map(|(id, status)| serde_json::json!({"id": id, "status": status}))
        .collect();
    (StatusCode::OK, Json(serde_json::json!(entries))).into_response()
}

/// GET /tunnels/status/:id — single tunnel status.
pub(crate) async fn get_tunnel_status(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    match state.tunnel_manager.get_status(&id) {
        Some(status) => (
            StatusCode::OK,
            Json(serde_json::json!({"id": id, "status": status})),
        )
            .into_response(),
        None => err_json(StatusCode::NOT_FOUND, "tunnel not found"),
    }
}

// ── Audit log ───────────────────────────────────────────────

#[derive(Deserialize)]
pub(crate) struct AuditQuery {
    limit: Option<usize>,
}

/// GET /tunnels/audit/:id — audit log for a tunnel.
pub(crate) async fn get_tunnel_audit(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<AuditQuery>,
) -> Response {
    let limit = query.limit.unwrap_or(20);
    match state.tunnel_audit.lock().query_by_tunnel(&id, limit) {
        Ok(events) => (StatusCode::OK, Json(serde_json::json!(events))).into_response(),
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

// ── SSH config hosts ────────────────────────────────────────

/// GET /tunnels/ssh-hosts — parse ~/.ssh/config and return host aliases.
pub(crate) async fn list_ssh_config_hosts() -> Response {
    let config_path = match dirs::home_dir() {
        Some(h) => h.join(".ssh").join("config"),
        None => return (StatusCode::OK, Json(serde_json::json!([]))).into_response(),
    };

    let file = match std::fs::File::open(&config_path) {
        Ok(f) => f,
        Err(_) => return (StatusCode::OK, Json(serde_json::json!([]))).into_response(),
    };

    let mut reader = BufReader::new(file);
    let config = match ssh2_config::SshConfig::default()
        .parse(&mut reader, ssh2_config::ParseRule::ALLOW_UNKNOWN_FIELDS)
    {
        Ok(c) => c,
        Err(e) => {
            return err_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to parse SSH config: {e}"),
            );
        }
    };

    let hosts: Vec<String> = config
        .get_hosts()
        .iter()
        .flat_map(|host| {
            host.pattern.iter().filter_map(|clause| {
                // Skip negated patterns and the wildcard-only pattern.
                if clause.negated || clause.pattern == "*" {
                    None
                } else {
                    Some(clause.pattern.clone())
                }
            })
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!(hosts))).into_response()
}

// ── SSH agent keys ──────────────────────────────────────────

/// GET /tunnels/agent-keys — list loaded SSH agent key fingerprints.
pub(crate) async fn list_agent_keys() -> Response {
    let output = match tokio::process::Command::new("ssh-add")
        .arg("-l")
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) => {
            return err_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to run ssh-add: {e}"),
            );
        }
    };

    // Exit code 1 means "no identities" — return empty list, not an error.
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no identities") || output.status.code() == Some(1) {
            return (StatusCode::OK, Json(serde_json::json!([]))).into_response();
        }
        return err_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("ssh-add failed: {}", stderr.trim()),
        );
    }

    // Each line: "256 SHA256:xxxxx user@host (ED25519)"
    let stdout = String::from_utf8_lossy(&output.stdout);
    let keys: Vec<serde_json::Value> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.splitn(4, ' ').collect();
            if parts.len() >= 3 {
                serde_json::json!({
                    "bits": parts[0],
                    "fingerprint": parts[1],
                    "comment": parts.get(2).unwrap_or(&""),
                    "type": parts.get(3).map(|s| s.trim_matches(|c| c == '(' || c == ')')),
                })
            } else {
                serde_json::json!({"raw": line})
            }
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!(keys))).into_response()
}
