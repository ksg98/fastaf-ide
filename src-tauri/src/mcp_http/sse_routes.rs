use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream::Stream;
use serde::Deserialize;

use crate::AppState;
use crate::state::AppEvent;

#[derive(Deserialize)]
pub(super) struct SseQuery {
    /// Comma-separated event type filter (e.g. "repo-changed,session-created").
    /// When omitted, all events are forwarded.
    pub types: Option<String>,
}

/// SSE endpoint: `GET /events?types=repo-changed,pty-parsed`
///
/// Subscribes to the broadcast channel and streams events to the client.
/// Supports optional `?types=` filter for comma-separated event names.
/// Uses monotonic event IDs from `state.event_counter`.
pub(super) async fn sse_events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SseQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = state.event_bus.subscribe();
    let allowed_types: Option<Vec<String>> = query.types.map(|t| {
        t.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    });

    let stream = async_stream::stream! {
        // Send retry directive as first event
        yield Ok(Event::default().retry(Duration::from_secs(5)));

        loop {
            match rx.recv().await {
                Ok(event) => {
                    let event_name = event_type_name(&event);
                    if let Some(ref types) = allowed_types
                        && !types.iter().any(|t| t == event_name) {
                        continue;
                    }
                    let id = state.event_counter.fetch_add(1, Ordering::Relaxed);
                    let payload = match serde_json::to_string(&event_payload(&event)) {
                        Ok(json) => json,
                        Err(_) => continue,
                    };
                    yield Ok(
                        Event::default()
                            .event(event_name)
                            .id(id.to_string())
                            .data(payload)
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    // Client fell behind — send a warning event and continue
                    yield Ok(
                        Event::default()
                            .event("lagged")
                            .data(format!("{{\"missed\":{n}}}")),
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    };

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    )
}

/// Extract the normalized event type name (matches SSE `event:` field).
fn event_type_name(event: &AppEvent) -> &'static str {
    match event {
        AppEvent::HeadChanged { .. } => "head-changed",
        AppEvent::RepoChanged { .. } => "repo-changed",
        AppEvent::SessionCreated { .. } => "session-created",
        AppEvent::SessionClosed { .. } => "session-closed",
        AppEvent::PtyParsed { .. } => "pty-parsed",
        AppEvent::PtyExit { .. } => "pty-exit",
        AppEvent::PluginChanged { .. } => "plugin-changed",
        AppEvent::UpstreamStatusChanged { .. } => "upstream-status-changed",
        AppEvent::McpOAuthStart { .. } => "mcp-oauth-start",
        AppEvent::McpToast { .. } => "mcp-toast",
        AppEvent::DirChanged { .. } => "dir-changed",
        AppEvent::WorktreeCreated { .. } => "worktree-created",
        AppEvent::PeerRegistered { .. } => "peer-registered",
        AppEvent::PeerUnregistered { .. } => "peer-unregistered",
        AppEvent::UiTab { .. } => "ui-tab",
        AppEvent::GitHubPrUpdate { .. } => "github-pr-update",
        AppEvent::GitHubTransition { .. } => "github-transition",
        AppEvent::GitHubIssuesUpdate { .. } => "github-issues-update",
        AppEvent::CloseHtmlTabs { .. } => "close-html-tabs",
        AppEvent::ScheduledJobCompleted { .. } => "scheduled-job-completed",
        AppEvent::DiffTriageProgress { .. } => "triage-progress",
        AppEvent::ReviewProgress { .. } => "review-progress",
        AppEvent::ConflictAssistStatus { .. } => "conflict-assist-status",
        AppEvent::ProposalsReady { .. } => "proposals-ready",
        AppEvent::WorktreeCreateFailed { .. } => "worktree-create-failed",
    }
}

/// Extract just the payload (without the wrapping `event`/`payload` tags).
/// The SSE `event:` field already carries the type, so we only need the inner data.
fn event_payload(event: &AppEvent) -> serde_json::Value {
    match event {
        AppEvent::HeadChanged { repo_path, branch } => {
            serde_json::json!({ "repo_path": repo_path, "branch": branch })
        }
        AppEvent::RepoChanged { repo_path } => {
            serde_json::json!({ "repo_path": repo_path })
        }
        AppEvent::SessionCreated {
            session_id,
            cwd,
            agent_type,
            display_name,
        } => {
            serde_json::json!({
                "session_id": session_id,
                "cwd": cwd,
                "agent_type": agent_type,
                "display_name": display_name,
            })
        }
        AppEvent::SessionClosed { session_id, reason } => {
            serde_json::json!({ "session_id": session_id, "reason": reason })
        }
        AppEvent::PtyParsed { session_id, parsed } => {
            serde_json::json!({ "session_id": session_id, "parsed": parsed })
        }
        AppEvent::PtyExit { session_id } => {
            serde_json::json!({ "session_id": session_id })
        }
        AppEvent::PluginChanged { plugin_ids } => {
            serde_json::json!({ "plugin_ids": plugin_ids })
        }
        AppEvent::UpstreamStatusChanged { name, status } => {
            serde_json::json!({ "name": name, "status": status })
        }
        AppEvent::McpOAuthStart {
            name,
            authorization_url,
        } => {
            serde_json::json!({ "name": name, "authorization_url": authorization_url })
        }
        AppEvent::McpToast {
            title,
            message,
            level,
            sound,
        } => {
            serde_json::json!({ "title": title, "message": message, "level": level, "sound": sound })
        }
        AppEvent::DirChanged { dir_path } => {
            serde_json::json!({ "dir_path": dir_path })
        }
        AppEvent::WorktreeCreated {
            repo_path,
            branch,
            worktree_path,
        } => {
            serde_json::json!({ "repo_path": repo_path, "branch": branch, "worktree_path": worktree_path })
        }
        AppEvent::PeerRegistered { tuic_session, name } => {
            serde_json::json!({ "tuic_session": tuic_session, "name": name })
        }
        AppEvent::PeerUnregistered { tuic_session } => {
            serde_json::json!({ "tuic_session": tuic_session })
        }
        AppEvent::UiTab {
            id,
            title,
            html,
            url,
            pinned,
            focus,
            origin_repo_path,
        } => {
            let mut v = serde_json::json!({ "id": id, "title": title, "html": html, "pinned": pinned, "focus": focus });
            if let Some(u) = url {
                v["url"] = serde_json::Value::String(u.clone());
            }
            if let Some(p) = origin_repo_path {
                v["origin_repo_path"] = serde_json::Value::String(p.clone());
            }
            v
        }
        AppEvent::GitHubPrUpdate {
            repo_path,
            statuses,
        } => {
            serde_json::json!({ "repo_path": repo_path, "statuses": statuses })
        }
        AppEvent::GitHubTransition { transition } => {
            serde_json::to_value(transition).unwrap_or_default()
        }
        AppEvent::GitHubIssuesUpdate { repo_path, issues } => {
            serde_json::json!({ "repo_path": repo_path, "issues": issues })
        }
        AppEvent::CloseHtmlTabs { tab_ids } => {
            serde_json::json!({ "tab_ids": tab_ids })
        }
        AppEvent::ScheduledJobCompleted {
            job_id,
            goal,
            timed_out,
        } => {
            serde_json::json!({ "job_id": job_id, "goal": goal, "timed_out": timed_out })
        }
        AppEvent::DiffTriageProgress {
            repo_path,
            summary,
            files,
            phase,
            done,
            llm_used,
            llm_model,
        } => {
            serde_json::json!({
                "repo_path": repo_path,
                "summary": summary,
                "files": files,
                "phase": phase,
                "done": done,
                "llm_used": llm_used,
                "llm_model": llm_model,
            })
        }
        AppEvent::ReviewProgress { repo_path, payload }
        | AppEvent::ConflictAssistStatus { repo_path, payload }
        | AppEvent::ProposalsReady { repo_path, payload } => {
            serde_json::json!({ "repo_path": repo_path, "payload": payload })
        }
        AppEvent::WorktreeCreateFailed {
            repo_path,
            branch,
            reason,
        } => {
            // camelCase keys mirror the Tauri window `worktree-create-failed`
            // event so the same frontend `handleWorktreeCreateFailed` consumes
            // both transports unchanged.
            serde_json::json!({ "repoPath": repo_path, "branch": branch, "reason": reason })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_created_preserves_stable_display_name() {
        let event = AppEvent::SessionCreated {
            session_id: "session-1".into(),
            cwd: Some("/repo".into()),
            agent_type: Some("codex".into()),
            display_name: Some("linux-primary".into()),
        };

        assert_eq!(event_type_name(&event), "session-created");
        let body = event_payload(&event);
        assert_eq!(body["session_id"], "session-1");
        assert_eq!(body["cwd"], "/repo");
        assert_eq!(body["agent_type"], "codex");
        assert_eq!(body["display_name"], "linux-primary");
    }

    /// The three GitHub Ops lifecycle events share a `{repo_path, payload}` shape.
    /// Each must map to its own SSE `event:` name and round-trip the payload
    /// verbatim so browser/PWA clients receive the same data as desktop.
    #[test]
    fn ops_lifecycle_events_have_distinct_names_and_passthrough_payload() {
        let payload = serde_json::json!({ "pr_number": 42, "phase": "done", "done": true });
        let cases: Vec<(AppEvent, &str)> = vec![
            (
                AppEvent::ReviewProgress {
                    repo_path: "/repo".into(),
                    payload: payload.clone(),
                },
                "review-progress",
            ),
            (
                AppEvent::ConflictAssistStatus {
                    repo_path: "/repo".into(),
                    payload: payload.clone(),
                },
                "conflict-assist-status",
            ),
            (
                AppEvent::ProposalsReady {
                    repo_path: "/repo".into(),
                    payload: payload.clone(),
                },
                "proposals-ready",
            ),
        ];

        // Names must all be distinct and match the expected kebab-case tag.
        let mut seen = std::collections::HashSet::new();
        for (event, expected_name) in &cases {
            assert_eq!(event_type_name(event), *expected_name);
            assert!(
                seen.insert(*expected_name),
                "duplicate event name {expected_name}"
            );
            let body = event_payload(event);
            assert_eq!(body["repo_path"], "/repo");
            assert_eq!(body["payload"], payload);
        }
    }

    #[test]
    fn worktree_create_failed_uses_camelcase_matching_window_event() {
        // The background stale-dir recreation dual-emits this on the bus (SSE)
        // AND the Tauri window. The SSE payload MUST use the same camelCase keys
        // as the window `worktree-create-failed` event so the frontend
        // `handleWorktreeCreateFailed({ repoPath, branch, reason })` consumes
        // both transports unchanged.
        let event = AppEvent::WorktreeCreateFailed {
            repo_path: "/repo".into(),
            branch: "feat-x".into(),
            reason: "recreation failed: boom".into(),
        };
        assert_eq!(event_type_name(&event), "worktree-create-failed");
        let body = event_payload(&event);
        assert_eq!(body["repoPath"], "/repo");
        assert_eq!(body["branch"], "feat-x");
        assert_eq!(body["reason"], "recreation failed: boom");
        // No snake_case leakage that a browser handler wouldn't read.
        assert!(body.get("repo_path").is_none());
    }

    #[test]
    fn triage_progress_payload_is_flat_not_wrapped() {
        let event = AppEvent::DiffTriageProgress {
            repo_path: "/repo".into(),
            summary: Some("s".into()),
            files: vec![],
            phase: "done".into(),
            done: true,
            llm_used: true,
            llm_model: Some("m".into()),
        };
        assert_eq!(event_type_name(&event), "triage-progress");
        let body = event_payload(&event);
        // Working-tree triage keeps its flat shape (not the {repo_path,payload}
        // envelope) — existing panel consumers depend on it.
        assert_eq!(body["repo_path"], "/repo");
        assert_eq!(body["phase"], "done");
        assert_eq!(body["done"], true);
        assert!(body.get("payload").is_none());
    }
}
