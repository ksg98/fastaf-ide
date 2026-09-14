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
    /// Client-chosen id of this stream. With one, the filter above is only the
    /// *initial* value and `POST /events/types` can widen it while the stream
    /// runs. Without one the filter is fixed for the life of the connection.
    pub stream_id: Option<String>,
}

/// Live type filters of the open `/events` streams, keyed by the client-supplied
/// `stream_id`.
///
/// A client learns it needs a new event type when a panel mounts, long after it
/// connected. Reopening the stream with a wider filter loses every event
/// published between the close and the new subscription — the bus has no replay
/// — so the filter is updated in place instead.
#[derive(Clone, Default)]
pub(crate) struct SseFilters {
    inner: Arc<parking_lot::Mutex<FilterRegistry>>,
}

#[derive(Default)]
struct FilterRegistry {
    streams: std::collections::HashMap<String, FilterSlot>,
    /// Distinguishes two registrations of the same id, so the guard of an
    /// already-replaced stream cannot deregister its successor.
    next_generation: u64,
}

struct FilterSlot {
    generation: u64,
    tx: tokio::sync::watch::Sender<Option<Vec<String>>>,
}

/// Streams that may hold a live filter at once. A guard deregisters each stream
/// as it ends, so this is a backstop, not a working limit: past it a stream
/// still runs, with the filter it connected with.
const MAX_FILTERED_STREAMS: usize = 64;

/// Deregisters a stream's filter when the stream ends. Held by the stream
/// itself, so a client disconnect drops it.
pub(crate) struct FilterGuard {
    filters: SseFilters,
    stream_id: String,
    generation: u64,
}

impl Drop for FilterGuard {
    fn drop(&mut self) {
        let mut registry = self.filters.inner.lock();
        if registry
            .streams
            .get(&self.stream_id)
            .is_some_and(|slot| slot.generation == self.generation)
        {
            registry.streams.remove(&self.stream_id);
        }
    }
}

impl SseFilters {
    /// Register `stream_id` with its initial filter. `None` is "every type".
    /// Returns nothing when the registry is full — the caller then keeps the
    /// filter it was given, and `update` answers false so the client reconnects.
    fn register(
        &self,
        stream_id: &str,
        initial: Option<Vec<String>>,
    ) -> Option<(
        tokio::sync::watch::Receiver<Option<Vec<String>>>,
        FilterGuard,
    )> {
        let mut registry = self.inner.lock();
        if registry.streams.len() >= MAX_FILTERED_STREAMS
            && !registry.streams.contains_key(stream_id)
        {
            tracing::warn!(
                source = "http",
                "Refusing to track the filter of SSE stream \"{stream_id}\": \
                 {MAX_FILTERED_STREAMS} streams already tracked. It runs with a fixed filter."
            );
            return None;
        }
        registry.next_generation += 1;
        let generation = registry.next_generation;
        let (tx, rx) = tokio::sync::watch::channel(initial);
        // Replaces any earlier slot for this id — an EventSource that
        // auto-reconnected reuses its id, and the old guard is about to drop.
        registry
            .streams
            .insert(stream_id.to_string(), FilterSlot { generation, tx });
        Some((
            rx,
            FilterGuard {
                filters: self.clone(),
                stream_id: stream_id.to_string(),
                generation,
            },
        ))
    }

    /// Replace the filter of a live stream. False when that stream is unknown —
    /// it ended, it never sent an id, or the registry was full.
    fn update(&self, stream_id: &str, types: Option<Vec<String>>) -> bool {
        let registry = self.inner.lock();
        match registry.streams.get(stream_id) {
            Some(slot) => {
                let _ = slot.tx.send(types);
                true
            }
            None => false,
        }
    }

    #[cfg(test)]
    fn tracked(&self) -> usize {
        self.inner.lock().streams.len()
    }
}

/// Body of `POST /events/types`.
#[derive(Deserialize)]
pub(super) struct SseTypesBody {
    stream_id: String,
    /// The full set the client wants from now on, not a delta. An empty list is
    /// an empty allowlist, exactly as `?types=` is.
    types: Vec<String>,
}

/// `POST /events/types` — widen (or narrow) the filter of a live SSE stream.
///
/// 404 means the stream is not tracked; the client falls back to reconnecting
/// with a wider `?types=`, which is lossy but still correct.
pub(super) async fn sse_update_types(
    State(state): State<Arc<AppState>>,
    axum::Json(body): axum::Json<SseTypesBody>,
) -> axum::http::StatusCode {
    if state.sse_filters.update(&body.stream_id, Some(body.types)) {
        axum::http::StatusCode::NO_CONTENT
    } else {
        axum::http::StatusCode::NOT_FOUND
    }
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
    let initial_types: Option<Vec<String>> = query.types.map(|t| {
        t.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    });
    // With a stream id the filter is live: the client widens it in place rather
    // than reconnecting, which would drop everything published in between. The
    // guard rides the stream, so the entry disappears when the client goes.
    let tracked = query
        .stream_id
        .as_ref()
        .and_then(|id| state.sse_filters.register(id, initial_types.clone()));
    let (filter_rx, filter_guard) = match tracked {
        Some((rx, guard)) => (Some(rx), Some(guard)),
        None => (None, None),
    };

    let stream = async_stream::stream! {
        // Moved in so it lives exactly as long as the stream does.
        let _filter_guard = filter_guard;
        // Send retry directive as first event
        yield Ok(Event::default().retry(Duration::from_secs(5)));

        loop {
            match rx.recv().await {
                Ok(event) => {
                    let event_name = event_type_name(&event);
                    let allowed = match filter_rx {
                        Some(ref live) => allows(&live.borrow(), event_name),
                        None => allows(&initial_types, event_name),
                    };
                    if !allowed {
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

/// `None` is "every type"; a list is an allowlist, so an empty one passes
/// nothing. That asymmetry is the wire contract: omitting `?types=` asks for
/// everything, sending it empty asks for nothing.
fn allows(filter: &Option<Vec<String>>, event_name: &str) -> bool {
    match filter {
        Some(types) => types.iter().any(|t| t == event_name),
        None => true,
    }
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
        AppEvent::PtyActivity { .. } => "pty-activity",
        AppEvent::PtyOsc133 { .. } => "pty-osc133",
        AppEvent::PtyCwd { .. } => "pty-cwd",
        AppEvent::PluginWatcherLines { .. } => "plugin-watcher-lines",
        AppEvent::PtyDescriptionChanged { .. } => "pty-description-changed",
        AppEvent::PluginChanged { .. } => "plugin-changed",
        AppEvent::UpstreamStatusChanged { .. } => "upstream-status-changed",
        AppEvent::McpOAuthStart { .. } => "mcp-oauth-start",
        AppEvent::McpToast { .. } => "mcp-toast",
        AppEvent::McpConfirm { .. } => "mcp-confirm",
        AppEvent::McpConfirmResolved { .. } => "mcp-confirm-resolved",
        AppEvent::RepositoriesChanged => "repositories-changed",
        AppEvent::DirChanged { .. } => "dir-changed",
        AppEvent::WorktreeCreated { .. } => "worktree-created",
        AppEvent::WorktreeRemoved { .. } => "worktree-removed",
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
/// Let another module's test compare this payload against the desktop one.
///
/// The two are built by different code in different files, which is exactly why
/// they drift; a test that can only see one of them cannot catch it.
#[cfg(test)]
pub(crate) fn event_payload_for_test(event: &AppEvent) -> serde_json::Value {
    event_payload(event)
}

fn event_payload(event: &AppEvent) -> serde_json::Value {
    match event {
        AppEvent::HeadChanged { repo_path, branch } => {
            serde_json::json!({ "repo_path": repo_path, "branch": branch })
        }
        AppEvent::RepoChanged { repo_path, kind } => {
            serde_json::json!({ "repo_path": repo_path, "kind": kind })
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
        AppEvent::PtyActivity { session_id } => {
            serde_json::json!({ "session_id": session_id })
        }
        AppEvent::PtyOsc133 {
            session_id,
            marker,
            line,
            exit_code,
        } => {
            serde_json::json!({
                "session_id": session_id,
                "marker": marker,
                "line": line,
                "exit_code": exit_code,
            })
        }
        AppEvent::PtyCwd { session_id, cwd } => {
            serde_json::json!({ "session_id": session_id, "cwd": cwd })
        }
        AppEvent::PluginWatcherLines { session_id, lines } => {
            serde_json::json!({ "session_id": session_id, "lines": lines })
        }
        AppEvent::PtyDescriptionChanged {
            session_id,
            description,
        } => {
            serde_json::json!({ "session_id": session_id, "description": description })
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
            origin_repo_path,
            origin_session_id,
        } => {
            serde_json::json!({
                "title": title,
                "message": message,
                "level": level,
                "sound": sound,
                "origin_repo_path": origin_repo_path,
                "origin_session_id": origin_session_id,
            })
        }
        AppEvent::McpConfirm {
            request_id,
            title,
            message,
            origin_repo_path,
            origin_session_id,
        } => {
            serde_json::json!({
                "request_id": request_id,
                "title": title,
                "message": message,
                "origin_repo_path": origin_repo_path,
                "origin_session_id": origin_session_id,
            })
        }
        AppEvent::McpConfirmResolved {
            request_id,
            confirmed,
        } => {
            serde_json::json!({ "request_id": request_id, "confirmed": confirmed })
        }
        // Payload-free: the receiver re-reads `repositories.json` itself.
        AppEvent::RepositoriesChanged => serde_json::json!({}),
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
        AppEvent::WorktreeRemoved { repo_path, branch } => {
            serde_json::json!({ "repo_path": repo_path, "branch": branch })
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
    use axum::response::IntoResponse;
    use futures_util::StreamExt;

    /// Read the next SSE chunk, or `None` if nothing arrives promptly. The
    /// generator is a pull stream: it only advances while polled, so "nothing
    /// arrives" needs a timeout rather than an immediate poll.
    async fn next_chunk(body: &mut axum::body::BodyDataStream) -> Option<String> {
        match tokio::time::timeout(Duration::from_millis(250), body.next()).await {
            Ok(Some(Ok(bytes))) => Some(String::from_utf8_lossy(&bytes).to_string()),
            _ => None,
        }
    }

    fn repo_changed() -> AppEvent {
        AppEvent::RepoChanged {
            repo_path: "/repo".into(),
            kind: crate::repo_watcher::RepoChangeKind::WorkingTree,
        }
    }

    fn dir_changed() -> AppEvent {
        AppEvent::DirChanged {
            dir_path: "/dir".into(),
        }
    }

    /// A panel that mounts late adds an event type the stream was not opened
    /// with. Reopening the stream to widen the filter loses everything published
    /// between the close and the new subscription — the bus has no replay — so
    /// the filter has to change on the live stream.
    #[tokio::test]
    async fn a_live_stream_widens_its_filter_without_reconnecting() {
        let state = crate::mcp_http::tests::test_state();
        let response = sse_events(
            State(state.clone()),
            Query(SseQuery {
                types: Some("repo-changed".into()),
                stream_id: Some("s1".into()),
            }),
        )
        .await
        .into_response();
        let mut body = response.into_body().into_data_stream();
        assert!(
            next_chunk(&mut body)
                .await
                .is_some_and(|c| c.contains("retry")),
            "the stream opens with the retry directive"
        );

        let _ = state.event_bus.send(repo_changed());
        assert!(
            next_chunk(&mut body)
                .await
                .is_some_and(|c| c.contains("repo-changed")),
            "the type it connected with arrives"
        );

        let _ = state.event_bus.send(dir_changed());
        assert!(
            next_chunk(&mut body).await.is_none(),
            "a type outside the filter is dropped"
        );

        assert_eq!(
            sse_update_types(
                State(state.clone()),
                axum::Json(SseTypesBody {
                    stream_id: "s1".into(),
                    types: vec!["repo-changed".into(), "dir-changed".into()],
                }),
            )
            .await,
            axum::http::StatusCode::NO_CONTENT
        );

        let _ = state.event_bus.send(dir_changed());
        assert!(
            next_chunk(&mut body)
                .await
                .is_some_and(|c| c.contains("dir-changed")),
            "the widened type arrives on the same connection"
        );
    }

    #[tokio::test]
    async fn a_stream_without_an_id_keeps_the_filter_it_connected_with() {
        let state = crate::mcp_http::tests::test_state();
        let response = sse_events(
            State(state.clone()),
            Query(SseQuery {
                types: Some("repo-changed".into()),
                stream_id: None,
            }),
        )
        .await
        .into_response();
        let mut body = response.into_body().into_data_stream();
        next_chunk(&mut body).await;

        // Nothing to update: the client must reconnect, and it learns that from
        // the 404 rather than from a silent success.
        assert_eq!(
            sse_update_types(
                State(state.clone()),
                axum::Json(SseTypesBody {
                    stream_id: "unknown".into(),
                    types: vec!["dir-changed".into()],
                }),
            )
            .await,
            axum::http::StatusCode::NOT_FOUND
        );

        let _ = state.event_bus.send(dir_changed());
        assert!(next_chunk(&mut body).await.is_none());
    }

    /// The registry must not outlive the streams it describes: every entry is
    /// dropped with its stream, and an EventSource that auto-reconnects reuses
    /// its id, so the guard of the *previous* connection must not take the new
    /// slot with it.
    #[test]
    fn a_filter_entry_dies_with_its_stream_and_never_takes_its_successor() {
        let filters = SseFilters::default();
        let (_rx, first) = filters.register("s1", None).expect("registered");
        assert_eq!(filters.tracked(), 1);

        let (_rx2, second) = filters.register("s1", None).expect("re-registered");
        assert_eq!(filters.tracked(), 1, "one id is one slot");
        drop(first);
        assert!(
            filters.update("s1", Some(vec!["repo-changed".into()])),
            "the reconnected stream still owns the slot"
        );

        drop(second);
        assert_eq!(filters.tracked(), 0);
        assert!(!filters.update("s1", None));
    }

    #[test]
    fn the_filter_registry_is_bounded() {
        let filters = SseFilters::default();
        let guards: Vec<_> = (0..MAX_FILTERED_STREAMS)
            .map(|i| {
                filters
                    .register(&format!("s{i}"), None)
                    .expect("registered")
            })
            .collect();
        assert!(
            filters.register("one-too-many", None).is_none(),
            "past the cap a stream runs with the filter it connected with"
        );
        // An already-tracked id is not a new stream, so it still updates.
        assert!(filters.register("s0", None).is_some());
        drop(guards);
    }

    #[test]
    fn an_absent_filter_passes_everything_and_an_empty_one_nothing() {
        assert!(allows(&None, "repo-changed"));
        assert!(!allows(&Some(Vec::new()), "repo-changed"));
        assert!(allows(&Some(vec!["repo-changed".into()]), "repo-changed"));
        assert!(!allows(&Some(vec!["repo-changed".into()]), "dir-changed"));
    }

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

    #[test]
    fn pty_description_changed_has_matching_sse_name_and_payload() {
        let event = AppEvent::PtyDescriptionChanged {
            session_id: "session-1".into(),
            description: None,
        };

        assert_eq!(event_type_name(&event), "pty-description-changed");
        assert_eq!(
            event_payload(&event),
            serde_json::json!({"session_id": "session-1", "description": null})
        );
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
