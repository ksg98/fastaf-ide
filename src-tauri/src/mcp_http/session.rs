use crate::pty::{build_shell_command, resolve_shell, spawn_reader_thread};
use crate::state::{OUTPUT_RING_BUFFER_CAPACITY, VT_LOG_BUFFER_CAPACITY, VtLogBuffer};
use crate::{AppState, MAX_CONCURRENT_SESSIONS, OutputRingBuffer, PtySession};
use axum::Json;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::stream::StreamExt;
use parking_lot::Mutex;
use portable_pty::PtySize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(feature = "desktop")]
use tauri::Emitter;
use uuid::Uuid;

use super::types::*;

/// Standard 404 response for missing sessions.
fn session_not_found() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({"error": "Session not found"})),
    )
}

pub(super) async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let uptime = state.server_start_time.elapsed().as_secs();
    let session_count = state.sessions.len();
    #[cfg(unix)]
    let socket_path = {
        let p = state.bound_socket_path.read();
        if p.as_os_str().is_empty() {
            None
        } else {
            Some(p.display().to_string())
        }
    };
    #[cfg(not(unix))]
    let socket_path = None;
    Json(HealthResponse {
        ok: true,
        uptime_secs: uptime,
        session_count,
        protocol_version: 1,
        socket_path,
    })
}

pub(super) async fn app_version() -> Json<super::types::VersionResponse> {
    Json(super::types::VersionResponse {
        version: env!("CARGO_PKG_VERSION"),
        git_hash: env!("BUILD_GIT_HASH"),
    })
}

pub(super) async fn list_sessions(State(state): State<Arc<AppState>>) -> Json<Vec<SessionInfo>> {
    let sessions: Vec<SessionInfo> = state
        .sessions
        .iter()
        .map(|entry| {
            let session_id = entry.key().clone();
            let session = entry.value().lock();
            let session_state = state.session_state_with_shell(&session_id);
            SessionInfo {
                session_id: session_id.clone(),
                cwd: session.cwd.clone(),
                worktree_path: session
                    .worktree
                    .as_ref()
                    .map(|w| w.path.to_string_lossy().to_string()),
                worktree_branch: session.worktree.as_ref().and_then(|w| w.branch.clone()),
                display_name: session.display_name.clone(),
                display_name_is_custom: session.display_name_is_custom,
                is_remote: session.is_remote,
                pty_description: state
                    .pty_descriptions
                    .get(&session_id)
                    .map(|value| value.value().clone()),
                state: session_state,
            }
        })
        .collect();
    Json(sessions)
}

pub(super) async fn write_to_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<WriteRequest>,
) -> impl IntoResponse {
    if let Err(e) = write_pty_input(&state, &session_id, &body.data) {
        if e == "Session not found" {
            return session_not_found();
        }
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        );
    }

    (StatusCode::OK, Json(serde_json::json!({"ok": true})))
}

pub(super) async fn write_parts_to_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<WritePartsRequest>,
) -> impl IntoResponse {
    let parts: Vec<&str> = body.parts.iter().map(String::as_str).collect();
    if let Err(e) = write_pty_input_parts(&state, &session_id, &parts) {
        if e == "Session not found" {
            return session_not_found();
        }
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        );
    }

    (StatusCode::OK, Json(serde_json::json!({"ok": true})))
}

/// Browser/PWA counterpart of the `enqueue_agent_command` Tauri command.
pub(super) async fn enqueue_command(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<EnqueueCommandRequest>,
) -> impl IntoResponse {
    match crate::pty::enqueue_user_command(&state, &session_id, &body.text) {
        Ok(outcome) => (
            StatusCode::OK,
            Json(serde_json::json!({"typed": outcome.typed, "queued": outcome.queued})),
        ),
        Err(e) if e == "Session not found" => session_not_found(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        ),
    }
}

/// Browser/PWA counterpart of the `clear_queued_agent_commands` Tauri command.
pub(super) async fn clear_queued_commands(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let cleared = crate::pty::clear_queued_commands(&state, &session_id);
    (StatusCode::OK, Json(serde_json::json!(cleared)))
}

/// Browser/PWA counterpart of the `list_queued_agent_commands` Tauri command.
pub(super) async fn list_queued_commands(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let queued = crate::pty::list_queued_commands(&state, &session_id);
    (StatusCode::OK, Json(serde_json::json!(queued)))
}

/// Browser/PWA counterpart of the `remove_queued_agent_command` Tauri command.
pub(super) async fn remove_queued_command(
    State(state): State<Arc<AppState>>,
    Path((session_id, command_id)): Path<(String, u64)>,
) -> impl IntoResponse {
    let removed = crate::pty::remove_queued_command(&state, &session_id, command_id);
    (StatusCode::OK, Json(serde_json::json!(removed)))
}

pub(crate) fn write_pty_input(
    state: &Arc<AppState>,
    session_id: &str,
    data: &str,
) -> Result<(), String> {
    write_pty_input_parts(state, session_id, &[data])
}

/// Write all input parts to the PTY under one writer lock, then apply capture
/// and input bookkeeping once per original request, in order.
pub(crate) fn write_pty_input_parts(
    state: &Arc<AppState>,
    session_id: &str,
    parts: &[&str],
) -> Result<(), String> {
    let byte_parts: Vec<&[u8]> = parts.iter().map(|part| part.as_bytes()).collect();
    state.write_pty_parts(session_id, &byte_parts)?;

    for part in parts {
        crate::pty_capture::record_input(session_id, part.as_bytes());
        apply_input_bookkeeping(state, session_id, part);
    }

    Ok(())
}

/// Write two input parts (e.g. text + a special-key sequence) to a session's
/// PTY under a SINGLE lock acquisition, then run the same post-write
/// bookkeeping (input-time stamp + InputLineBuffer FSM feed) that two
/// sequential `write_pty_input` calls would have run — once per part, in
/// order. Closes the interleave window a concurrent writer (peer injection,
/// desktop `write_pty`) could otherwise land in between the text write and
/// the Enter keystroke when the two writes took the PTY mutex separately.
pub(crate) fn write_pty_input_pair(
    state: &Arc<AppState>,
    session_id: &str,
    text: &str,
    key: &str,
) -> Result<(), String> {
    write_pty_input_parts(state, session_id, &[text, key])
}

fn write_pty_input_bytes(
    state: &Arc<AppState>,
    session_id: &str,
    data: &[u8],
) -> Result<(), String> {
    state.write_pty_parts(session_id, &[data])?;
    crate::pty_capture::record_input(session_id, data);
    if let Ok(text) = std::str::from_utf8(data) {
        apply_input_bookkeeping(state, session_id, text);
    }
    Ok(())
}

/// Post-write bookkeeping shared by all UTF-8 PTY input helpers: stamps
/// last-input time and feeds the
/// InputLineBuffer FSM to track slash_mode accurately. Runs once per input
/// part, after the single PTY lock for the complete write has been released.
pub(crate) fn apply_input_bookkeeping(state: &Arc<AppState>, session_id: &str, data: &str) {
    // Stamp last-input time (same as desktop write_pty) so the grid ticker
    // throttles frames for remote/PWA typing under CPU saturation too.
    crate::pty::stamp_input_ms(state, session_id);
    crate::state::resolve_choice_prompt_input(state, session_id, data);

    // Feed input through InputLineBuffer FSM to track slash_mode accurately.
    // The old substring heuristic false-positived on pastes starting with '/'.
    // Copy the FSM result and composer content, then release BOTH the inner
    // mutex and DashMap entry guard before any transition/delivery callback.
    // `flush_pending_injections` re-reads input_buffers; retaining the entry
    // guard across that call self-deadlocks its DashMap shard.
    let (actions, buffer_content) = {
        let input_entry = state
            .input_buffers
            .entry(session_id.to_string())
            .or_insert_with(|| {
                parking_lot::Mutex::new(crate::input_line_buffer::InputLineBuffer::new())
            });
        let mut buf = input_entry.lock();
        let actions = buf.feed(data);
        let buffer_content = buf.content();
        (actions, buffer_content)
    };
    let interrupted = actions
        .iter()
        .any(|a| matches!(a, crate::input_line_buffer::InputAction::Interrupt));
    let line_submitted = actions.iter().any(|a| {
        matches!(
            a,
            crate::input_line_buffer::InputAction::Line(_)
                | crate::input_line_buffer::InputAction::Interrupt
        )
    });
    if interrupted || data == "\x1b" {
        if let Some(sl) = state.silence_states.get(session_id) {
            sl.lock().note_interrupt_requested();
        }
    } else {
        for action in &actions {
            if let crate::input_line_buffer::InputAction::Line(content) = action {
                crate::pty::record_submitted_line(state, session_id, content.clone(), -1);
            }
        }
    }
    // Determine slash mode. The InputLineBuffer may accumulate junk from
    // terminal responses (e.g. DA reply "1;2c"), so buf.content() alone is
    // unreliable. Use multiple signals:
    let in_slash = if line_submitted {
        false
    } else if buffer_content.starts_with('/') {
        true
    } else if data == "/" {
        // Fresh slash keystroke from PWA/MCP — always enters slash mode
        true
    } else {
        // Maintain current slash_mode for subsequent chars (delta sync sends
        // one char at a time after the initial "/"), unless dismissed
        let is_bare_esc = data == "\x1b" || (data.contains('\x1b') && !data.contains("\x1b["));
        let dismissed = is_bare_esc || data.contains('\x03');
        !dismissed
            && state
                .slash_mode
                .get(session_id)
                .is_some_and(|v| v.load(std::sync::atomic::Ordering::Relaxed))
    };
    tracing::trace!(
        "write_pty slash_mode: in_slash={in_slash} buf='{}' data='{}'",
        buffer_content,
        data
    );
    state
        .slash_mode
        .entry(session_id.to_string())
        .or_insert_with(|| std::sync::atomic::AtomicBool::new(false))
        .store(in_slash, std::sync::atomic::Ordering::Relaxed);
    if buffer_content.is_empty() {
        crate::pty::flush_pending_injections(state, session_id);
    }
}

pub(super) async fn set_session_name(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<SetNameRequest>,
) -> impl IntoResponse {
    let entry = match state.sessions.get(&session_id) {
        Some(e) => e,
        None => return session_not_found(),
    };
    let mut session = entry.lock();
    session.display_name = body.name;
    session.display_name_is_custom = body.is_custom.unwrap_or(true);
    (StatusCode::OK, Json(serde_json::json!({"ok": true})))
}

pub(super) async fn resize_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<ResizeRequest>,
) -> impl IntoResponse {
    if let Err(msg) = super::validate_terminal_size(body.rows, body.cols) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": msg})),
        );
    }
    // Shared core: grid-before-SIGWINCH ordering + same-dims no-op (056-7545),
    // on the blocking pool — a whole-ring rewrap must not sit on a tokio worker.
    match crate::pty::resize_session_off_thread(&state, session_id.clone(), body.rows, body.cols)
        .await
    {
        Ok(Some(frame)) => {
            crate::pty::send_grid_frame(&state, &session_id, frame);
            (StatusCode::OK, Json(serde_json::json!({"ok": true})))
        }
        Ok(None) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))),
        Err(e) if e.starts_with("Session not found") => session_not_found(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Resize failed: {}", e)})),
        ),
    }
}

/// Dump the raw PTY byte flight recorder for a session (story 056-7545).
/// Returns the most recent raw output bytes (pre-transform, up to 2 MiB) as
/// binary, for offline replay via `replay_capture_from_env`.
pub(super) async fn get_raw_ring(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match state.pty_raw_rings.get(&session_id) {
        Some(ring) => {
            let bytes: Vec<u8> = {
                let ring = ring.lock();
                ring.iter().copied().collect()
            };
            (
                StatusCode::OK,
                [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
                bytes,
            )
                .into_response()
        }
        None => session_not_found().into_response(),
    }
}

pub(super) async fn get_output(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<OutputQuery>,
) -> impl IntoResponse {
    let format = query.format.as_deref().unwrap_or("raw");

    // format=log: return VT100-extracted clean log lines (best for mobile/REST consumers)
    if format == "log" {
        let vt_log = match state.vt_log_buffers.get(&session_id) {
            Some(b) => b,
            None => return session_not_found(),
        };
        let buf = vt_log.lock();
        let limit = query.limit.unwrap_or(usize::MAX);
        let total = buf.total_lines();
        let offset = match query.offset {
            Some(o) => o.min(total),
            None => total.saturating_sub(limit),
        };
        let (lines, _) = buf.lines_since_owned(offset, limit);
        // Absolute offset of the first line actually returned. `lines.len()` cannot
        // stand in for it: chrome lines occupy offset slots without being returned,
        // so a client subtracting the length would land inside the window it already
        // holds and replay those lines when scrolling up.
        let window_start = offset.max(buf.oldest_offset()).min(total);
        let trim = screen_chrome_cutoff(&buf);
        // Get styled screen rows, trimmed to same cutoff
        let styled = buf.screen_log_lines();
        let screen: Vec<_> = styled.into_iter().take(trim.cutoff).collect();
        let input_line = buf.prompt_input_text();
        let mut resp = serde_json::json!({
            "lines": lines,
            "total_lines": total,
            "offset": window_start,
            "screen": screen,
        });
        if let Some(il) = &input_line {
            resp["input_line"] = serde_json::json!(il);
        }
        return (StatusCode::OK, Json(resp));
    }

    // format=text: serve one canonical terminal snapshot. Do not concatenate
    // VtLogBuffer's finalized-log cursor with its current screen: after a row
    // resize grows the viewport, rows can move from history back onto the
    // screen while still being retained in the cursor log, producing duplicate
    // text even though the canonical terminal grid is correct.
    if format == "text" {
        let vt_log = match state.vt_log_buffers.get(&session_id) {
            Some(b) => b,
            None => return session_not_found(),
        };
        let buf = vt_log.lock();
        let total = buf.grid_total_lines();
        let limit = query.limit.unwrap_or(usize::MAX);
        let start = query
            .offset
            .unwrap_or_else(|| total.saturating_sub(limit))
            .min(total);
        let end = start.saturating_add(limit).min(total);
        let data = buf.grid_get_lines(start, end).join("\n");
        return (
            StatusCode::OK,
            Json(serde_json::json!({
                "data": data,
                "data_length": data.len(),
                "total_written": total,
            })),
        );
    }

    let ring = match state.output_buffers.get(&session_id) {
        Some(r) => r,
        None => return session_not_found(),
    };
    let limit = query.limit.unwrap_or(8192);
    let (bytes, total_written) = ring.lock().read_last(limit);
    let raw = String::from_utf8_lossy(&bytes).to_string();
    let data = raw;
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "data": data,
            "data_length": data.len(),
            "total_written": total_written
        })),
    )
}

pub(super) async fn close_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    if state.sessions.contains_key(&session_id) {
        // Send Ctrl+C then cleanup
        let _ = write_pty_input_bytes(&state, &session_id, &[0x03]);
        // Broadcast to SSE/WebSocket consumers BEFORE cleanup: cleanup_session reaps
        // this session's per-session PTY channel, so the closed frame must be emitted
        // while the channel still exists. broadcast keeps the buffered frame available
        // to live subscribers even after the sender is dropped, so they drain the
        // "closed" frame and THEN see the channel close (no lost close notification).
        tracing::info!(source = "session", session_id = %session_id, "Session closed: explicit close");
        state.emit_pty_event(crate::state::AppEvent::SessionClosed {
            session_id: session_id.clone(),
            reason: "explicit_close".to_string(),
        });
        #[cfg(feature = "desktop")]
        if let Some(app) = state.app_handle.read().as_ref() {
            let _ = app.emit(
                "session-closed",
                serde_json::json!({
                    "session_id": session_id,
                    "reason": "explicit_close",
                }),
            );
        }

        crate::pty::cleanup_session(&session_id, &state);

        (StatusCode::OK, Json(serde_json::json!({"ok": true})))
    } else {
        session_not_found()
    }
}

/// Shared PTY setup: opens a PTY, spawns the shell, registers buffers and reader thread.
///
/// Returns `(session_id, cwd_string)` on success. Both `create_session` and
/// `create_session_with_worktree` delegate here after deriving the cwd and worktree.
pub(super) fn spawn_pty_session(
    state: Arc<AppState>,
    shell: String,
    cwd: Option<String>,
    rows: u16,
    cols: u16,
    worktree: Option<crate::state::WorktreeInfo>,
    requested_id: Option<String>,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    // Honor a client-provided id when it is non-empty and not already taken
    // (browser duplicate-tab fix); otherwise mint a fresh one.
    let session_id = match requested_id {
        Some(id) if !id.is_empty() && !state.sessions.contains_key(&id) => id,
        _ => Uuid::new_v4().to_string(),
    };
    let (pair, child) = crate::pty::spawn_pty_pair_with_retry(
        PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        },
        || {
            let mut cmd = build_shell_command(&shell);
            if let Some(ref dir) = cwd {
                let dir = crate::cli::expand_tilde(dir);
                cmd.cwd(dir);
            }
            // This path used to inject neither shell integration nor an identity, so
            // every browser/remote/MCP-created session ran without OSC 133 markers and
            // without a `$TUIC_SESSION` to announce. Bring it in line with the desktop
            // path: no caller identity exists here, so the PTY key serves as both.
            crate::shell_integration::inject(&state.data_dir, &shell, &mut cmd);
            crate::pty::bind_pty_identity(&state, &mut cmd, &session_id, None);
            cmd
        },
    )
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
    })?;

    let writer = pair.master.take_writer().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to get PTY writer: {}", e)})),
        )
    })?;

    let reader = pair.master.try_clone_reader().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to get PTY reader: {}", e)})),
        )
    })?;

    let paused = Arc::new(AtomicBool::new(false));
    state.sessions.insert(
        session_id.clone(),
        Mutex::new(PtySession {
            writer: Arc::new(Mutex::new(writer)),
            master: pair.master,
            _child: child,
            paused: paused.clone(),
            worktree,
            cwd: cwd.clone(),
            display_name: None,
            display_name_is_custom: false,
            is_remote: true,
            shell: shell.clone(),
        }),
    );
    state.assign_term_alias(&session_id);
    state.metrics.total_spawned.fetch_add(1, Ordering::Relaxed);
    state
        .metrics
        .active_sessions
        .fetch_add(1, Ordering::Relaxed);

    state.output_buffers.insert(
        session_id.clone(),
        Mutex::new(OutputRingBuffer::new(OUTPUT_RING_BUFFER_CAPACITY)),
    );
    state.vt_log_buffers.insert(
        session_id.clone(),
        Mutex::new(VtLogBuffer::new(
            rows,
            cols.max(220),
            VT_LOG_BUFFER_CAPACITY,
        )),
    );
    state
        .last_output_ms
        .insert(session_id.clone(), std::sync::atomic::AtomicU64::new(0));
    let grid_watch_tx = crate::grid_gate::new_grid_watch();
    state.grid_watch.insert(session_id.clone(), grid_watch_tx);

    // Broadcast to SSE/WebSocket consumers (before state is moved to reader thread)
    state.emit_pty_event(crate::state::AppEvent::SessionCreated {
        session_id: session_id.clone(),
        cwd: cwd.clone(),
        agent_type: None,
        display_name: None,
    });

    #[cfg(feature = "desktop")]
    let state_ref = state.clone();
    spawn_reader_thread(reader, paused, session_id.clone(), state, None);

    #[cfg(feature = "desktop")]
    if let Some(app) = state_ref.app_handle.read().as_ref() {
        let _ = app.emit(
            "session-created",
            serde_json::json!({
                "session_id": session_id,
                "cwd": cwd,
                "display_name": null,
            }),
        );
    }

    Ok(session_id)
}

pub(super) async fn create_session(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateSessionRequest>,
) -> impl IntoResponse {
    if state.sessions.len() >= MAX_CONCURRENT_SESSIONS {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Max concurrent sessions reached"})),
        );
    }

    let rows = body.rows.unwrap_or(24);
    let cols = body.cols.unwrap_or(80);
    if let Err(msg) = super::validate_terminal_size(rows, cols) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": msg})),
        );
    }
    let shell = resolve_shell(body.shell);

    let spawn = tokio::task::spawn_blocking(move || {
        spawn_pty_session(state, shell, body.cwd, rows, cols, None, body.session_id)
    })
    .await
    .unwrap_or_else(|error| {
        Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("PTY spawn task panicked: {error}")})),
        ))
    });
    match spawn {
        Ok(session_id) => (
            StatusCode::CREATED,
            Json(serde_json::json!({"session_id": session_id})),
        ),
        Err(err) => err,
    }
}

pub(super) async fn pause_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let entry = match state.sessions.get(&session_id) {
        Some(e) => e,
        None => return session_not_found(),
    };
    entry.lock().paused.store(true, Ordering::Relaxed);
    state
        .metrics
        .pauses_triggered
        .fetch_add(1, Ordering::Relaxed);
    (StatusCode::OK, Json(serde_json::json!({"ok": true})))
}

pub(super) async fn resume_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let entry = match state.sessions.get(&session_id) {
        Some(e) => e,
        None => return session_not_found(),
    };
    entry.lock().paused.store(false, Ordering::Relaxed);
    (StatusCode::OK, Json(serde_json::json!({"ok": true})))
}

pub(super) async fn get_kitty_flags(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let flags = state
        .kitty_states
        .get(&session_id)
        .map(|entry| entry.lock().current_flags())
        .unwrap_or(0);
    (StatusCode::OK, Json(serde_json::json!(flags)))
}

pub(super) async fn get_foreground_process(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let agent = (|| -> Option<String> {
        let entry = state.sessions.get(&session_id)?;
        let session = entry.value().lock();
        #[cfg(not(windows))]
        {
            let pgid = session.master.process_group_leader()?;
            let name = crate::pty::process_name_from_pid(pgid as u32)?;
            crate::pty::classify_agent(&name).map(|s| s.to_string())
        }
        #[cfg(windows)]
        {
            drop(session);
            None
        }
    })();

    match agent {
        Some(name) => (StatusCode::OK, Json(serde_json::json!({"agent": name}))),
        None => (StatusCode::OK, Json(serde_json::json!({"agent": null}))),
    }
}

// --- PTY/terminal read-state queries (browser/remote parity, story 062). ---
// These mirror the desktop-only `#[tauri::command]`s in pty.rs by reading the
// same AppState directly — the commands themselves are cfg'd out of the remote
// build, so the access logic is replicated here (as get_foreground_process does).

/// Shell state atom ("busy"/"idle") for a session, or null if never produced output.
pub(super) async fn get_shell_state(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let value = state.shell_states.get(&session_id).and_then(|atom| {
        crate::pty::shell_state_wire(atom.load(Ordering::Relaxed)).map(str::to_string)
    });
    Json(serde_json::json!({ "state": value }))
}

/// Last relevant user prompt (>= 10 words) for a session, or null.
pub(super) async fn get_last_prompt(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let value = state.last_prompts.get(&session_id).map(|v| v.clone());
    Json(serde_json::json!({ "prompt": value }))
}

/// Current input-line buffer content for a session (empty string if not typing).
pub(super) async fn get_input_buffer_content(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let content = state
        .input_buffers
        .get(&session_id)
        .map(|entry| entry.lock().content())
        .unwrap_or_default();
    Json(serde_json::json!({ "content": content }))
}

/// PID of the deepest foreground process (PGID on Unix), or null.
pub(super) async fn get_session_leaf_pid(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let pid = (|| -> Option<u32> {
        let entry = state.sessions.get(&session_id)?;
        let session = entry.value().lock();
        #[cfg(not(windows))]
        {
            let pgid = session.master.process_group_leader()?;
            Some(pgid as u32)
        }
        #[cfg(windows)]
        {
            let child_pid = session._child.process_id()?;
            crate::pty::deepest_descendant_pid(child_pid)
        }
    })();
    Json(serde_json::json!({ "pid": pid }))
}

/// Non-shell foreground process name (e.g. "htop", "node"), or null if the
/// foreground is the shell itself. Used to warn before closing a tab.
pub(super) async fn has_foreground_process(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    const SHELLS: &[&str] = &[
        "zsh",
        "bash",
        "fish",
        "sh",
        "dash",
        "ksh",
        "csh",
        "tcsh",
        "nushell",
        "nu",
        "powershell",
        "pwsh",
        "cmd",
    ];
    let process = (|| -> Option<String> {
        let entry = state.sessions.get(&session_id)?;
        #[cfg(not(windows))]
        let pid = {
            let session = entry.value().lock();
            let pgid = session.master.process_group_leader()?;
            u32::try_from(pgid).ok()?
        };
        #[cfg(windows)]
        let pid = {
            let session = entry.value().lock();
            let child_pid = session._child.process_id()?;
            crate::pty::deepest_descendant_pid(child_pid)?
        };
        let name = crate::pty::process_name_from_pid(pid)?;
        if SHELLS.contains(&name.as_str()) {
            None
        } else {
            Some(name)
        }
    })();
    Json(serde_json::json!({ "process": process }))
}

/// Set a session's tab-visibility flag (focus/blur tracking; wakes on Unix).
pub(super) async fn set_session_visible(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<SessionVisibleRequest>,
) -> impl IntoResponse {
    state
        .session_visibility
        .insert(session_id.clone(), body.visible);
    #[cfg(unix)]
    if body.visible
        && let Err(e) = crate::pty::wake_session(&state, &session_id)
    {
        tracing::warn!(session_id, error = %e, "Wake on focus failed");
    }
    (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
}

pub(super) async fn get_stats(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.orchestrator_stats())
}

pub(super) async fn get_metrics(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.session_metrics_json())
}

pub(super) async fn get_process_stats(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(crate::pty::collect_process_stats(&state))
}

pub(super) async fn process_monitor_panel() -> impl IntoResponse {
    axum::response::Html(include_str!("process_monitor.html"))
}

pub(super) async fn create_session_with_worktree(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateSessionWithWorktreeRequest>,
) -> impl IntoResponse {
    if state.sessions.len() >= MAX_CONCURRENT_SESSIONS {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Max concurrent sessions reached"})),
        );
    }

    // Create the worktree first
    let wt_config = crate::worktree::WorktreeConfig {
        task_name: body.branch_name.clone(),
        base_repo: body.base_repo,
        branch: Some(body.branch_name),
        create_branch: true,
    };
    let worktrees_dir = crate::worktree::resolve_worktree_dir_for_repo(
        std::path::Path::new(&wt_config.base_repo),
        &state.worktrees_dir,
    );
    let wt_config_bg = wt_config.clone();
    let worktree = match tokio::task::spawn_blocking(move || {
        crate::worktree::create_worktree_with_stale_recovery(&worktrees_dir, &wt_config_bg, None)
    })
    .await
    {
        Ok(Ok(wt)) => wt,
        Ok(Err(e)) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            );
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("task panic: {e}")})),
            );
        }
    };

    let base_repo = wt_config.base_repo.clone();
    state.invalidate_repo_caches(&base_repo);
    let worktree_path_str = worktree.path.to_string_lossy().to_string();
    let worktree_branch = worktree.branch.clone();
    let branch_name = worktree_branch.clone().unwrap_or_default();
    let _ = state
        .event_bus
        .send(crate::state::AppEvent::WorktreeCreated {
            repo_path: base_repo.clone(),
            branch: branch_name.clone(),
            worktree_path: worktree_path_str.clone(),
        });
    #[cfg(feature = "desktop")]
    if let Some(handle) = state.app_handle.read().as_ref() {
        let _ = handle.emit(
            "worktree-created",
            serde_json::json!({
                "repo_path": &base_repo,
                "branch": &branch_name,
                "worktree_path": &worktree_path_str,
            }),
        );
    }

    let rows = body.config.rows.unwrap_or(24);
    let cols = body.config.cols.unwrap_or(80);
    if let Err(msg) = super::validate_terminal_size(rows, cols) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": msg})),
        );
    }
    let shell = resolve_shell(body.config.shell);

    let spawn_cwd = worktree_path_str.clone();
    let spawn = tokio::task::spawn_blocking(move || {
        spawn_pty_session(
            state,
            shell,
            Some(spawn_cwd),
            rows,
            cols,
            Some(worktree),
            body.config.session_id,
        )
    })
    .await
    .unwrap_or_else(|error| {
        Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("PTY spawn task panicked: {error}")})),
        ))
    });
    match spawn {
        Ok(session_id) => {
            let mut response = serde_json::json!({
                "session_id": session_id,
                "worktree_path": worktree_path_str.clone(),
                "branch": worktree_branch,
            });
            let repo_for_script = base_repo.clone();
            let cwd_for_script = worktree_path_str;
            if let Some(script) = tokio::task::spawn_blocking(move || {
                crate::config::resolve_effective_setup_script(&repo_for_script)
            })
            .await
            .ok()
            .flatten()
            {
                match tokio::task::spawn_blocking(move || {
                    crate::worktree::run_setup_script(script, cwd_for_script)
                })
                .await
                {
                    Ok(Ok(result)) => {
                        response["setup_script"] = result;
                    }
                    Ok(Err(e)) => {
                        response["setup_script_error"] = serde_json::json!(e);
                    }
                    Err(e) => {
                        response["setup_script_error"] =
                            serde_json::json!(format!("task panic: {e}"));
                    }
                }
            }
            (StatusCode::CREATED, Json(response))
        }
        Err(err) => err,
    }
}

/// WebSocket upgrade handler for streaming PTY output.
/// Bidirectional: server sends PTY output, client sends PTY input.
/// Supports `?format=text` to strip ANSI, `?format=log` for VT100 log lines.
pub(super) async fn ws_stream(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    Query(query): Query<OutputQuery>,
    State(state): State<Arc<AppState>>,
) -> Response {
    if !state.sessions.contains_key(&id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let format = query.format.as_deref().unwrap_or("raw");

    if format == "grid" {
        return ws
            .write_buffer_size(64 * 1024)
            .max_write_buffer_size(256 * 1024)
            .on_upgrade(move |socket| handle_ws_grid_session(socket, id, state));
    }

    // format=text and format=log both serve clean VtLogBuffer rows (no strip_ansi).
    let log_mode = format == "log" || format == "text";
    let initial_offset = query.offset;
    ws.on_upgrade(move |socket| handle_ws_session(socket, id, state, log_mode, initial_offset))
}

/// Handle a WebSocket connection for a PTY session.
///
/// Multiplexes two streams to the client:
/// 1. Raw PTY output via mpsc channel → `{"type":"output","data":"..."}`
/// 2. Parsed events via broadcast channel → `{"type":"parsed","event":{...}}`
///
/// When `log_mode` is true (`?format=log` or `?format=text`), instead of raw PTY
/// output the client receives VT100-extracted log lines:
/// `{"type":"log","lines":[...],"offset":N}`
///
/// Client → server messages are written to the PTY as input.
async fn handle_ws_session(
    socket: WebSocket,
    session_id: String,
    state: Arc<AppState>,
    log_mode: bool,
    initial_offset: Option<usize>,
) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    if log_mode {
        // Log/text mode: stream clean VtLogBuffer rows, no raw PTY chunks
        handle_ws_log_session(
            ws_sender,
            ws_receiver,
            session_id,
            state,
            initial_offset.unwrap_or(0),
        )
        .await;
        return;
    }

    // Subscribe to this session's per-session PTY event channel (no global-bus fan-out).
    let mut event_rx = state.subscribe_pty_events(&session_id);

    // Snapshot the ring buffer and register the live mpsc subscription
    // atomically while holding ring.lock(). The PTY writer takes the same
    // lock when appending + broadcasting to ws_clients, so serializing the
    // two sides guarantees every byte is delivered either via catch-up or
    // via the live channel — never both (duplicate) nor neither (gap).
    let (tx, mut rx) = crate::state::new_ws_client_channel();
    let snapshot = state.output_buffers.get(&session_id).map(|ring| {
        let r = ring.lock();
        let snap = if let Some(off) = initial_offset {
            r.read_since(off as u64)
        } else {
            r.read_last(OUTPUT_RING_BUFFER_CAPACITY)
        };
        state
            .ws_clients
            .entry(session_id.clone())
            .or_default()
            .push(tx);
        drop(r);
        snap
    });

    // Send catch-up data in chunks (64 KB) so the client can render progressively.
    const CATCHUP_CHUNK_SIZE: usize = 64 * 1024;
    if let Some((data, total)) = snapshot
        && !data.is_empty()
    {
        for chunk in data.chunks(CATCHUP_CHUNK_SIZE) {
            let text = String::from_utf8_lossy(chunk);
            if !text.is_empty() {
                let frame =
                    serde_json::json!({"type": "output", "data": text, "total_written": total});
                if futures_util::SinkExt::send(
                    &mut ws_sender,
                    Message::Text(frame.to_string().into()),
                )
                .await
                .is_err()
                {
                    // Client disconnected during catch-up. It was already
                    // registered above, so reap it here — this path never
                    // reaches the purge at the end of the read loop.
                    crate::state::purge_dead_ws_clients(&state.ws_clients, &session_id);
                    return;
                }
            }
        }
    }

    // Spawn a task to forward PTY output + parsed events to the WebSocket
    let sid_for_events = session_id.clone();
    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                // Raw PTY output from mpsc channel
                data = rx.recv() => {
                    let Some(data) = data else { break };
                    let frame = serde_json::json!({"type": "output", "data": data});
                    if futures_util::SinkExt::send(
                        &mut ws_sender,
                        Message::Text(frame.to_string().into()),
                    ).await.is_err() {
                        break;
                    }
                }
                // Parsed events from broadcast channel
                result = event_rx.recv() => {
                    match result {
                        Ok(event) => {
                            // Per-session channel — every event belongs to this session.
                            // Extract the inner payload (without serde tag wrapping).
                            let payload = match &event {
                                crate::state::AppEvent::PtyParsed { parsed, .. } => {
                                    serde_json::json!({"type": "parsed", "event": parsed})
                                }
                                crate::state::AppEvent::PtyExit { session_id: sid } => {
                                    serde_json::json!({"type": "exit", "session_id": sid})
                                }
                                // The browser counterpart of the desktop
                                // `pty-activity-{id}` Tauri event. Both ride the
                                // subscription `subscribePty` owns, so the two
                                // transports carry the same signal by construction
                                // rather than by coincidence. The grid WS below
                                // deliberately does NOT forward this — CanvasTerminal
                                // has no activity consumer, and a pulse nobody reads
                                // is a wake-up nobody needs.
                                crate::state::AppEvent::PtyActivity { session_id: sid } => {
                                    serde_json::json!({"type": "activity", "session_id": sid})
                                }
                                crate::state::AppEvent::PluginWatcherLines { session_id: sid, lines } => {
                                    serde_json::json!({"type": "watcher-lines", "session_id": sid, "lines": lines})
                                }
                                crate::state::AppEvent::SessionClosed { session_id: sid, reason } => {
                                    serde_json::json!({"type": "closed", "session_id": sid, "reason": reason})
                                }
                                crate::state::AppEvent::PtyDescriptionChanged { session_id: sid, description } => {
                                    serde_json::json!({"type": "pty-description", "session_id": sid, "description": description})
                                }
                                _ => continue,
                            };
                            if futures_util::SinkExt::send(
                                &mut ws_sender,
                                Message::Text(payload.to_string().into()),
                            ).await.is_err() {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(session_id = %sid_for_events, lagged = n, "WebSocket broadcast lagged");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    });

    // Read messages from the client and write to PTY
    let state_clone = state.clone();
    let sid = session_id.clone();
    while let Some(Ok(msg)) = ws_receiver.next().await {
        match msg {
            Message::Text(text) => {
                if let Err(error) = write_pty_input(&state_clone, &sid, &text) {
                    tracing::error!(session_id = %sid, %error, "PTY write failed");
                    break;
                }
            }
            Message::Binary(data) => {
                if let Err(error) = write_pty_input_bytes(&state_clone, &sid, &data) {
                    tracing::error!(session_id = %sid, %error, "PTY write failed");
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Client disconnected — abort the send task and purge the dead sender
    send_task.abort();
    crate::state::purge_dead_ws_clients(&state.ws_clients, &session_id);
}

/// Handle a WebSocket connection in log mode (`?format=log`).
///
/// Sends VT100-extracted log lines: catch-up on connect, then polls for new
/// lines every 200 ms and batches them as `{"type":"log","lines":[...],"offset":N}`.
/// The client can still send PTY input (written as-is to the PTY).
async fn handle_ws_log_session(
    mut ws_sender: futures_util::stream::SplitSink<WebSocket, Message>,
    mut ws_receiver: futures_util::stream::SplitStream<WebSocket>,
    session_id: String,
    state: Arc<AppState>,
    skip_offset: usize,
) {
    // Send catch-up: only lines accumulated AFTER skip_offset.
    // When the client already fetched lines via HTTP, skip_offset = total_lines
    // from that response, so the catch-up only sends the delta.
    let initial_offset = {
        if let Some(vt_log) = state.vt_log_buffers.get(&session_id) {
            let (total, catchup_frame) = {
                let buf = vt_log.lock();
                let total = buf.total_lines();
                let frame = if total > skip_offset {
                    let (lines, _) = buf.lines_since_owned(skip_offset, usize::MAX);
                    if !lines.is_empty() {
                        // total_lines is the post-read cursor (monotonic): the client
                        // stores it and passes it back as ?offset= on reconnect, so the
                        // next catch-up resumes from here instead of replaying from mount.
                        Some(serde_json::json!({"type": "log", "lines": lines, "offset": skip_offset, "total_lines": total}).to_string())
                    } else {
                        None
                    }
                } else {
                    None
                };
                (total, frame)
            }; // lock released here
            if let Some(frame_str) = catchup_frame {
                let _ =
                    futures_util::SinkExt::send(&mut ws_sender, Message::Text(frame_str.into()))
                        .await;
            }
            total
        } else {
            0
        }
    };

    // Spawn polling task: check for new lines every 200ms AND forward state changes.
    let sid_poll = session_id.clone();
    let state_poll = state.clone();
    let send_task = tokio::spawn(async move {
        let mut offset = initial_offset;
        let mut event_rx = state_poll.subscribe_pty_events(&sid_poll);
        let mut prev_screen_hash: u64 = 0;
        // Dedup: only send state frames when SessionState actually changed
        let mut prev_state: Option<crate::state::SessionState> = None;

        // Send initial state snapshot so the client has the correct status immediately
        if let Some(current) = state_poll.session_state_with_shell(&sid_poll) {
            let frame = serde_json::json!({"type": "state", "state": &current});
            prev_state = Some(current);
            let _ = futures_util::SinkExt::send(
                &mut ws_sender,
                Message::Text(frame.to_string().into()),
            )
            .await;
        }

        loop {
            // Track whether we need to check state and/or send log frames
            enum LoopAction {
                Poll,        // sleep arm: check state + send log/screen
                Event,       // event arm: check state only (relevant event)
                Skip,        // event arm: irrelevant event, skip state check
                SessionGone, // vt_log_buffer missing, exit loop
            }

            let action = tokio::select! {
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(200)) => {
                    if state_poll.vt_log_buffers.contains_key(&sid_poll) {
                        LoopAction::Poll
                    } else {
                        LoopAction::SessionGone
                    }
                }
                event = event_rx.recv() => {
                    // Per-session channel — every delivered event belongs to this
                    // session, so any Ok triggers a state re-check. On Closed the
                    // channel was reaped (session gone): exit instead of spinning on
                    // the immediately-ready error arm. Lagged is a transient skip.
                    match event {
                        Ok(_) => LoopAction::Event,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => LoopAction::SessionGone,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => LoopAction::Skip,
                    }
                }
            };

            if matches!(action, LoopAction::SessionGone) {
                break;
            }
            if matches!(action, LoopAction::Skip) {
                continue;
            }

            // On Event: yield to let the session_state_accumulator task process
            // the same broadcast event before we read the state.  Without this,
            // we may read stale state (the accumulator hasn't applied the event
            // yet) → dedup sees no change → client misses the update.
            if matches!(action, LoopAction::Event) {
                tokio::task::yield_now().await;
            }

            // Single session_state_with_shell call per iteration, used by both arms
            if let Some(current) = state_poll.session_state_with_shell(&sid_poll)
                && prev_state.as_ref() != Some(&current)
            {
                let frame = serde_json::json!({"type": "state", "state": &current});
                prev_state = Some(current);
                if futures_util::SinkExt::send(
                    &mut ws_sender,
                    Message::Text(frame.to_string().into()),
                )
                .await
                .is_err()
                {
                    break;
                }
            }

            // Poll arm: also send log lines and screen content
            if matches!(action, LoopAction::Poll) {
                let Some(vt_log) = state_poll.vt_log_buffers.get(&sid_poll) else {
                    break;
                };
                let (lines, new_offset, polled) = {
                    let buf = vt_log.lock();
                    let (l, o) = buf.lines_since_owned(offset, usize::MAX);
                    (l, o, poll_screen(&buf, prev_screen_hash))
                }; // lock released
                let input_line = polled.input_line;
                let screen_lines = polled.screen;
                let screen_changed = screen_lines.is_some();
                // Store the signature for every poll, not only the ones that
                // produce a frame: a screen of nothing but blanks styles to
                // nothing, and leaving the old hash in place made the next tick
                // rebuild it to reach the same conclusion.
                prev_screen_hash = polled.hash;
                // Send frame if there are new log lines OR screen content changed
                if !lines.is_empty() || screen_changed {
                    // total_lines = post-read monotonic cursor (== offset when no new
                    // lines). The client tracks it for reconnect resume — see catch-up above.
                    let mut frame = serde_json::json!({"type": "log", "offset": offset, "total_lines": new_offset});
                    if !lines.is_empty() {
                        frame["lines"] = serde_json::json!(lines);
                    }
                    if let Some(ref screen) = screen_lines {
                        frame["screen"] = serde_json::json!(screen);
                        if let Some(ref il) = input_line {
                            frame["input_line"] = serde_json::json!(il);
                        }
                    }
                    if futures_util::SinkExt::send(
                        &mut ws_sender,
                        Message::Text(frame.to_string().into()),
                    )
                    .await
                    .is_err()
                    {
                        break;
                    }
                    if !lines.is_empty() {
                        offset = new_offset;
                    }
                }
            }
        }
    });

    // Read messages from the client and write to PTY (input passthrough)
    while let Some(Ok(msg)) = ws_receiver.next().await {
        match msg {
            Message::Text(text) => {
                if let Err(error) = write_pty_input(&state, &session_id, &text) {
                    tracing::error!(session_id = %session_id, %error, "PTY write failed");
                    break;
                }
            }
            Message::Binary(data) => {
                if let Err(error) = write_pty_input_bytes(&state, &session_id, &data) {
                    tracing::error!(session_id = %session_id, %error, "PTY write failed");
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    send_task.abort();
}

/// Build the JSON text frame the grid WebSocket sends for one bus event, or
/// `None` for events this socket does not carry.
///
/// A function rather than an inline `match` so a test can assert the shape that
/// actually goes on the wire. A test that rebuilds the frame by hand proves only
/// that the test agrees with itself: it stays green while the wire carries
/// something the client cannot read.
///
/// SHAPE CONTRACT: `WsTransport` destructures each frame as
/// `const { type, ...payload } = event` and hands `payload` to the same handler
/// the desktop `listen()` feeds. So every frame here must be its Tauri event
/// payload plus a `type` discriminator — no renamed fields, no extra nesting —
/// or `CanvasTerminal` needs a per-transport branch.
fn grid_ws_frame(event: &crate::state::AppEvent) -> Option<serde_json::Value> {
    // Per-session channel — every event belongs to this session.
    Some(match event {
        crate::state::AppEvent::PtyParsed { parsed, .. } => {
            serde_json::json!({"type": "parsed", "event": parsed})
        }
        crate::state::AppEvent::PtyExit { session_id: sid } => {
            serde_json::json!({"type": "exit", "session_id": sid})
        }
        crate::state::AppEvent::PluginWatcherLines {
            session_id: sid,
            lines,
        } => {
            serde_json::json!({"type": "watcher-lines", "session_id": sid, "lines": lines})
        }
        crate::state::AppEvent::SessionClosed {
            session_id: sid,
            reason,
        } => {
            serde_json::json!({"type": "closed", "session_id": sid, "reason": reason})
        }
        crate::state::AppEvent::PtyDescriptionChanged {
            session_id: sid,
            description,
        } => {
            serde_json::json!({"type": "pty-description", "session_id": sid, "description": description})
        }
        // Mirrors the desktop `Osc133Event` field for field — see the shape
        // contract above. Without this a browser/PWA client had no command
        // blocks, no gutter marks and no Cmd+Up/Down navigation.
        crate::state::AppEvent::PtyOsc133 {
            marker,
            line,
            exit_code,
            ..
        } => {
            serde_json::json!({"type": "osc133", "marker": marker, "line": line, "exit_code": exit_code})
        }
        crate::state::AppEvent::PtyCwd { cwd, .. } => {
            serde_json::json!({"type": "cwd", "cwd": cwd})
        }
        _ => return None,
    })
}

/// Handle a WebSocket connection in grid mode (`?format=grid`).
///
/// Streams binary grid frames (same format as Tauri Channel) using the
/// `grid_watch` channel. The channel keeps only the newest frame, so a client
/// that cannot keep up skips intermediate ones — and those frames are DELTAS, so
/// a skip strands the rows it carried. Each frame therefore rides with a sequence
/// number (Rust-side only, the wire format is untouched) and a gap is repaired
/// with a fresh full frame instead of being rendered as a hole.
///
/// On connect, sends a full frame (all rows marked dirty). Subsequent frames
/// are delta-based (only changed rows). Client sends text messages for
/// commands (e.g. `{"type":"ack"}`) and binary messages for PTY input.
async fn handle_ws_grid_session(socket: WebSocket, session_id: String, state: Arc<AppState>) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Subscribe to the grid watch channel (newest-frame-wins for slow clients).
    let mut frame_rx = match state.grid_watch.get(&session_id) {
        Some(tx) => tx.subscribe(),
        None => {
            let _ = futures_util::SinkExt::send(&mut ws_sender, Message::Close(None)).await;
            return;
        }
    };
    // Whatever has been published so far is superseded by the full frame below,
    // so start from the current sequence rather than zero — otherwise the first
    // delta of a long-running session would always look like a gap.
    let mut last_seq = frame_rx.borrow_and_update().seq;

    // Send initial full frame so the client can render immediately. The helper
    // scopes the MutexGuard (dropped before the .await) and gives the damage back
    // so this connect does not cost the desktop channel its next frame.
    let initial_frame = full_frame_for_single_client(&state, &session_id);
    if let Some(frame) = initial_frame
        && futures_util::SinkExt::send(&mut ws_sender, Message::Binary(frame.into()))
            .await
            .is_err()
    {
        return;
    }

    // Subscribe to this session's per-session PTY event channel (exit, closed, parsed).
    let mut event_rx = state.subscribe_pty_events(&session_id);
    let sid_for_events = session_id.clone();
    let resync_state = state.clone();
    let resync_sid = session_id.clone();

    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                result = frame_rx.changed() => {
                    if result.is_err() { break; } // sender dropped
                    let (seq, frame) = {
                        let slot = frame_rx.borrow_and_update();
                        (slot.seq, slot.frame.clone())
                    };
                    // Frames the channel dropped carried dirty rows that exist
                    // nowhere else. Sending this delta on top of a row map missing
                    // them would leave stale content on screen with no error, so
                    // re-serialize the whole grid instead — through the helper that
                    // hands the damage back to the other transports.
                    //
                    // DEFERRED (2026-08-18) — a bell flag carried by a skipped frame
                    // is lost: the resync reports the grid's current state, and the
                    // bell is an event, not state. Fixing it means latching bells per
                    // subscriber, which is a second piece of per-client state on a
                    // path that only skips frames when the client is already too slow
                    // to keep up. Revisit if a missed bell is ever reported.
                    let frame = if crate::grid_gate::watch_dropped_frames(last_seq, seq) {
                        tracing::debug!(
                            session_id = %resync_sid,
                            last_seq,
                            seq,
                            "grid watch dropped frames, resyncing with a full frame"
                        );
                        full_frame_for_single_client(&resync_state, &resync_sid).unwrap_or(frame)
                    } else {
                        frame
                    };
                    last_seq = seq;
                    if !frame.is_empty()
                        && futures_util::SinkExt::send(
                            &mut ws_sender,
                            Message::Binary(frame.into()),
                        )
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                result = event_rx.recv() => {
                    match result {
                        Ok(event) => {
                            let Some(payload) = grid_ws_frame(&event) else { continue };
                            if futures_util::SinkExt::send(
                                &mut ws_sender,
                                Message::Text(payload.to_string().into()),
                            ).await.is_err() {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(session_id = %sid_for_events, lagged = n, "grid WS broadcast lagged");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    });

    // Read messages from the client
    let state_clone = state.clone();
    let sid = session_id.clone();
    while let Some(Ok(msg)) = ws_receiver.next().await {
        match msg {
            Message::Text(_text) => {
                // Reserved for client commands (e.g. resize, scroll).
                // No ACK needed — watch channel handles backpressure naturally.
            }
            Message::Binary(data) => {
                if let Err(error) = write_pty_input_bytes(&state_clone, &sid, &data) {
                    tracing::error!(session_id = %sid, %error, "PTY write failed");
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    send_task.abort();

    // The send task held the only other receiver, and aborting it drops it. If
    // that was the last one, nobody will ever read the frame still sitting in
    // the watch slot — free it instead of pinning it for the session's life.
    if let Some(watch_tx) = state.grid_watch.get(&session_id)
        && watch_tx.receiver_count() == 0
    {
        crate::grid_gate::release_grid_frame(&watch_tx);
    }
}

/// Remove agent TUI chrome from screen rows (status bars, prompt lines,
/// separators) and trim trailing empty rows.
///
/// Scans from the bottom for two anchor patterns:
/// 1. Separator line (all box-drawing chars like `────`) — cuts from there
/// 2. Prompt line (`❯`, `>`) — cuts from there, extending up past separators
///
/// The scan window is 15 rows to accommodate Claude Code's full footer
/// (prompt + input area + separator + status bar = ~12 rows).
/// Result of trimming screen chrome: cleaned rows.
struct TrimResult {
    /// How many rows were kept (cutoff index). Allows applying the same trim to parallel data.
    cutoff: usize,
}

use crate::chrome::find_chrome_cutoff;

/// Borrows: it reports a cutoff and reads nothing else, so taking the rows by
/// value only forced every caller to clone a screen it already had in hand.
fn trim_screen_chrome(rows: &[String]) -> TrimResult {
    let refs: Vec<&str> = rows.iter().map(|s| s.as_str()).collect();
    let cutoff = find_chrome_cutoff(&refs).unwrap_or(rows.len());
    TrimResult { cutoff }
}

/// Chrome cutoff for the buffer's current screen, borrowing the grid's cached
/// rows. The owned fallback is only for a buffer whose `process()` has never
/// run, which has no snapshot to lend.
fn screen_chrome_cutoff(buf: &crate::state::VtLogBuffer) -> TrimResult {
    match buf.screen_rows_ref() {
        Some(rows) => trim_screen_chrome(rows),
        None => trim_screen_chrome(&buf.screen_rows()),
    }
}

/// What one log-WS poll found on the screen.
struct ScreenPoll {
    /// The styled rows, present ONLY when the screen changed since `prev_hash`.
    screen: Option<Vec<crate::state::LogLine>>,
    input_line: Option<String>,
    /// Signature to pass back as `prev_hash` on the next poll.
    hash: u64,
}

/// Decide whether the screen changed, and build the styled rows only if it did.
///
/// The signature is the plain text of the visible rows plus the input line —
/// exactly what the old check reduced to, since it hashed `span.text` and
/// nothing else. Building the styled `Vec<LogLine>` first and hashing it
/// afterwards made an idle session materialize a full screen five times a
/// second, under the buffer's mutex, only to discard it.
///
/// The styled build stays inside the caller's lock because it reads the grid;
/// what changed is how often it runs, not where.
fn poll_screen(buf: &crate::state::VtLogBuffer, prev_hash: u64) -> ScreenPoll {
    use std::hash::{Hash, Hasher};

    let trim = screen_chrome_cutoff(buf);
    let input_line = buf.prompt_input_text();

    let owned;
    let rows: &[String] = match buf.screen_rows_ref() {
        Some(rows) => rows,
        None => {
            owned = buf.screen_rows();
            &owned
        }
    };
    let visible = &rows[..trim.cutoff.min(rows.len())];

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for row in visible {
        row.hash(&mut hasher);
    }
    input_line.hash(&mut hasher);
    let hash = hasher.finish();

    if hash == prev_hash {
        return ScreenPoll {
            screen: None,
            input_line,
            hash,
        };
    }

    let styled: Vec<_> = buf
        .screen_log_lines()
        .into_iter()
        .take(trim.cutoff)
        .collect();
    // screen_log_lines drops trailing blank rows, so a screen of nothing but
    // blanks styles to nothing. The old path sent no frame for it either.
    let screen = if styled.is_empty() {
        None
    } else {
        Some(styled)
    };
    ScreenPoll {
        screen,
        input_line,
        hash,
    }
}

// --- Terminal grid HTTP endpoints ---
//
// The grid reads take the vt mutex, which the PTY reader holds through a whole
// `serialize_dirty_rows`, so they go to the blocking pool through the same
// `pty::vt_try_read` the desktop commands use. Sharing the helper rather than
// the command is forced: the commands are `#[cfg(feature = "desktop")]` and
// these routes also compile into the headless `tuic-remote` binary. See
// `docs/backend/command-threading.md`.

pub(super) async fn terminal_scroll(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<super::types::TerminalScrollRequest>,
) -> impl IntoResponse {
    let Some(vt) = state.vt_log_buffers.get(&session_id) else {
        return session_not_found();
    };
    let frame = {
        let mut vt = vt.lock();
        vt.grid_scroll(body.delta);
        vt.serialize_dirty_rows()
    };
    crate::pty::send_grid_frame(&state, &session_id, frame);
    (StatusCode::OK, Json(serde_json::json!({"ok": true})))
}

pub(super) async fn terminal_scroll_to(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<super::types::TerminalScrollToRequest>,
) -> impl IntoResponse {
    let Some(vt) = state.vt_log_buffers.get(&session_id) else {
        return session_not_found();
    };
    let frame = {
        let mut vt = vt.lock();
        vt.grid_scroll_to_line(body.line);
        vt.serialize_dirty_rows()
    };
    crate::pty::send_grid_frame(&state, &session_id, frame);
    (StatusCode::OK, Json(serde_json::json!({"ok": true})))
}

/// Coalesced scroll to an absolute display offset. Mirrors the desktop
/// `terminal_scroll_to_offset` Tauri command: records the target and marks the
/// grid dirty so the frame ticker applies it under its own lock — taking NO vt
/// lock here, so scrolling never contends with the PTY output processor. The
/// ticker emits the resulting frame over the same bus SSE/WS feeds in browser
/// mode. This is the wheel + scrollbar-drag scroll path.
pub(super) async fn terminal_scroll_to_offset(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<super::types::TerminalScrollToOffsetRequest>,
) -> impl IntoResponse {
    if let Some(p) = state.pending_scroll.get(&session_id) {
        p.store(body.offset as i64, std::sync::atomic::Ordering::Relaxed);
    }
    if let Some(d) = state.grid_frame_dirty.get(&session_id) {
        d.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    (StatusCode::OK, Json(serde_json::json!({"ok": true})))
}

pub(super) async fn terminal_scroll_info(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match crate::pty::vt_try_read(&state, session_id, |vt| {
        serde_json::json!({
            "display_offset": vt.grid_display_offset(),
            "total_lines": vt.grid_total_lines(),
            "screen_lines": vt.grid_screen_lines(),
        })
    })
    .await
    {
        Ok(Some(info)) => Json(info).into_response(),
        Ok(None) => not_found_response(),
        Err(e) => read_failed_response(&e),
    }
}

/// A grid read whose session went away between the request and the pool hop.
fn not_found_response() -> axum::response::Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({"error": "Session not found"})),
    )
        .into_response()
}

/// The blocking-pool task itself failed — a panic in the read, or a runtime
/// shutting down. Distinct from a missing session, which is routine.
fn read_failed_response(error: &str) -> axum::response::Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error": error})),
    )
        .into_response()
}

pub(super) async fn terminal_search(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<super::types::TerminalSearchRequest>,
) -> impl IntoResponse {
    match crate::pty::vt_try_read(&state, session_id, move |vt| vt.grid_search(&body.query)).await {
        Ok(Some(matches)) => Json(serde_json::json!({"matches": matches})).into_response(),
        Ok(None) => not_found_response(),
        Err(e) => read_failed_response(&e),
    }
}

pub(super) async fn terminal_search_buffer(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<super::types::TerminalSearchRequest>,
) -> impl IntoResponse {
    match crate::pty::vt_try_read(&state, session_id, move |vt| {
        vt.grid_search_buffer(&body.query)
    })
    .await
    {
        Ok(Some(matches)) => Json(serde_json::json!({"matches": matches})).into_response(),
        Ok(None) => not_found_response(),
        Err(e) => read_failed_response(&e),
    }
}

pub(super) async fn terminal_get_row_text(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<super::types::TerminalRowQuery>,
) -> impl IntoResponse {
    match crate::pty::vt_try_read(&state, session_id, move |vt| {
        vt.grid_get_row_text(query.row)
    })
    .await
    {
        Ok(Some(text)) => Json(serde_json::json!({"text": text})).into_response(),
        Ok(None) => not_found_response(),
        Err(e) => read_failed_response(&e),
    }
}

/// Extract the text of a selection span (start/end row/col) from the grid.
pub(super) async fn terminal_get_selection_text(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(q): Query<super::types::TerminalSelectionQuery>,
) -> impl IntoResponse {
    match crate::pty::vt_try_read(&state, session_id, move |vt| {
        vt.grid_get_selection_text(q.start_row, q.start_col, q.end_row, q.end_col)
    })
    .await
    {
        Ok(Some(text)) => Json(serde_json::json!({"text": text})).into_response(),
        Ok(None) => not_found_response(),
        Err(e) => read_failed_response(&e),
    }
}

/// Unwrap a soft-wrapped logical line at `row` → `[logicalStartRow, text]`.
pub(super) async fn terminal_get_logical_line(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(q): Query<super::types::TerminalRowQuery>,
) -> impl IntoResponse {
    match crate::pty::vt_try_read(&state, session_id, move |vt| {
        vt.grid_get_logical_line(q.row)
    })
    .await
    {
        Ok(Some((idx, text))) => Json(serde_json::json!([idx, text])).into_response(),
        Ok(None) => not_found_response(),
        Err(e) => read_failed_response(&e),
    }
}

/// Hyperlink span at a cell → `[startCol, endCol, url]` or null (OSC 8).
pub(super) async fn terminal_hyperlink_span(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(q): Query<super::types::TerminalCellQuery>,
) -> impl IntoResponse {
    // Answers null for a gone session rather than 404: a hover can outlive the
    // tab it started on, and the frontend reads "no link here" either way.
    let span = crate::pty::vt_read(&state, session_id, move |vt| {
        vt.grid_hyperlink_span(q.row, q.col)
    })
    .await;
    match span {
        Ok(span) => Json(serde_json::json!(span)).into_response(),
        Err(e) => read_failed_response(&e),
    }
}

pub(super) async fn terminal_get_lines(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<super::types::TerminalLinesQuery>,
) -> impl IntoResponse {
    match crate::pty::vt_try_read(&state, session_id, move |vt| {
        vt.grid_get_lines(query.start, query.end)
    })
    .await
    {
        Ok(Some(lines)) => Json(serde_json::json!({"lines": lines})).into_response(),
        Ok(None) => not_found_response(),
        Err(e) => read_failed_response(&e),
    }
}

/// Serialize the whole grid for ONE client, without taking the rows the other
/// clients have not received yet.
///
/// Damage is tracked per session and `serialize_dirty_rows` consumes it, so a
/// frame built for a single WS socket would otherwise leave the desktop ticker
/// with nothing to send — the desktop would never learn about rows that changed
/// just before the WS client connected or resynced, and nothing would report it.
/// Marking the grid damaged again and waking the ticker costs one extra full
/// frame to the other clients and keeps every transport whole.
fn full_frame_for_single_client(state: &Arc<AppState>, session_id: &str) -> Option<Vec<u8>> {
    let frame = {
        let vt = state.vt_log_buffers.get(session_id)?;
        let mut vt = vt.lock();
        vt.grid_force_full_damage();
        let frame = vt.serialize_dirty_rows();
        vt.grid_force_full_damage();
        frame
    };
    if let Some(dirty) = state.grid_frame_dirty.get(session_id) {
        dirty.store(true, Ordering::Relaxed);
    }
    if frame.is_empty() { None } else { Some(frame) }
}

/// Wrap packed row bytes as a binary body.
///
/// Deliberately not `Json(bytes)`: that spells a 141 KB chunk as ~350 KB of
/// decimal numbers for the client to parse back into the bytes it started as.
/// The desktop command hands the same payload over raw, and `rpcImpl` decides
/// between `arrayBuffer()` and `json()` on this header alone.
fn styled_rows_response(bytes: Vec<u8>) -> impl IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        bytes,
    )
}

/// Styled row range as packed bytes (same encoding as the desktop
/// `terminal_styled_rows` command). Fills the CanvasTerminal client-side row
/// cache so scrolled-back history renders during smooth scroll in browser mode
/// instead of showing blank rows. Returns an empty body when the session or
/// range is gone — the frontend treats that as "nothing to cache".
pub(super) async fn terminal_styled_rows(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<super::types::TerminalStyledRowsQuery>,
) -> axum::response::Response {
    match crate::pty::vt_read(&state, session_id, move |vt| {
        vt.grid_serialize_styled_range(query.start, query.count)
    })
    .await
    {
        Ok(bytes) => styled_rows_response(bytes).into_response(),
        Err(e) => read_failed_response(&e),
    }
}

pub(super) async fn terminal_get_cursor_line(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match crate::pty::vt_try_read(&state, session_id, |vt| vt.grid_get_cursor_line()).await {
        Ok(Some(text)) => Json(serde_json::json!({"text": text})).into_response(),
        Ok(None) => not_found_response(),
        Err(e) => read_failed_response(&e),
    }
}

pub(super) async fn terminal_hyperlink_at(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<super::types::TerminalCellQuery>,
) -> impl IntoResponse {
    match crate::pty::vt_try_read(&state, session_id, move |vt| {
        vt.grid_hyperlink_at(query.row, query.col)
    })
    .await
    {
        Ok(Some(url)) => Json(serde_json::json!({"url": url})).into_response(),
        Ok(None) => not_found_response(),
        Err(e) => read_failed_response(&e),
    }
}

pub(super) async fn terminal_request_frame(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let Some(vt) = state.vt_log_buffers.get(&session_id) else {
        return session_not_found();
    };
    let frame = {
        let mut vt = vt.lock();
        vt.grid_force_full_damage();
        vt.serialize_dirty_rows()
    };
    crate::pty::send_grid_frame(&state, &session_id, frame);
    (StatusCode::OK, Json(serde_json::json!({"ok": true})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    struct WriteProbe {
        writes: Arc<parking_lot::Mutex<Vec<Vec<u8>>>>,
        flushes: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[cfg(unix)]
    impl std::io::Write for WriteProbe {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.writes.lock().push(buf.to_vec());
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.flushes
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(())
        }
    }

    #[cfg(unix)]
    #[test]
    fn split_escape_then_slash_opens_slash_mode_but_concatenated_input_does_not() {
        let state = super::super::tests::test_state();
        let split_session_id = "split-escape-slash";
        crate::state::tests_support::insert_dummy_session(&state, split_session_id);

        write_pty_input_parts(&state, split_session_id, &["\x1b", "/"])
            .expect("split input writes to the PTY");

        let split_slash_mode = state
            .slash_mode
            .get(split_session_id)
            .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed));
        assert!(
            split_slash_mode,
            "Escape and slash delivered as separate parts must open slash mode"
        );

        let concatenated_session_id = "concatenated-escape-slash";
        crate::state::tests_support::insert_dummy_session(&state, concatenated_session_id);
        write_pty_input(&state, concatenated_session_id, "\x1b/")
            .expect("concatenated input writes to the PTY");

        let concatenated_slash_mode = state
            .slash_mode
            .get(concatenated_session_id)
            .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed));
        assert!(
            !concatenated_slash_mode,
            "the concatenated Escape/slash request must remain distinguishable from two parts"
        );
    }

    #[cfg(unix)]
    #[test]
    fn split_choice_key_clears_the_prompt_but_concatenated_input_does_not() {
        fn choice_state() -> crate::state::SessionState {
            crate::state::SessionState {
                awaiting_input: true,
                choice_prompt: Some(crate::output_parser::ChoicePromptPayload {
                    title: "Choose an option".to_string(),
                    options: vec![crate::output_parser::ChoiceOption {
                        key: "1".to_string(),
                        label: "Proceed".to_string(),
                        highlighted: true,
                        destructive: false,
                        hint: None,
                    }],
                    dismiss_key: None,
                    amend_key: None,
                }),
                ..Default::default()
            }
        }

        let state = super::super::tests::test_state();
        let concatenated_session_id = "concatenated-choice-key";
        crate::state::tests_support::insert_dummy_session(&state, concatenated_session_id);
        state
            .session_states
            .insert(concatenated_session_id.to_string(), choice_state());
        write_pty_input(&state, concatenated_session_id, "1x")
            .expect("concatenated input writes to the PTY");
        assert!(
            state
                .session_states
                .get(concatenated_session_id)
                .unwrap()
                .choice_prompt
                .is_some(),
            "a concatenated option key must not resolve an exact-key choice prompt"
        );

        let split_session_id = "split-choice-key";
        crate::state::tests_support::insert_dummy_session(&state, split_session_id);
        state
            .session_states
            .insert(split_session_id.to_string(), choice_state());
        write_pty_input_parts(&state, split_session_id, &["1", "x"])
            .expect("split input writes to the PTY");
        assert!(
            state
                .session_states
                .get(split_session_id)
                .unwrap()
                .choice_prompt
                .is_none(),
            "an exact option key delivered as its own part must resolve the choice prompt"
        );
    }

    #[cfg(unix)]
    #[test]
    fn n_input_parts_share_one_writer_flush_and_preserve_write_boundaries() {
        let state = super::super::tests::test_state();
        let session_id = "n-part-single-lock";
        crate::state::tests_support::insert_dummy_session(&state, session_id);
        let writes = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let flushes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let writer: crate::state::SharedPtyWriter =
            Arc::new(parking_lot::Mutex::new(Box::new(WriteProbe {
                writes: Arc::clone(&writes),
                flushes: Arc::clone(&flushes),
            })));
        state.sessions.get(session_id).unwrap().lock().writer = writer;

        write_pty_input_parts(&state, session_id, &["first", "second", "third"])
            .expect("all parts write to the PTY");

        assert_eq!(
            flushes.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "N parts must use one write_pty_parts call, which flushes once"
        );
        assert_eq!(
            *writes.lock(),
            vec![b"first".to_vec(), b"second".to_vec(), b"third".to_vec()],
            "the single locked write must still deliver every input as its own part"
        );
    }

    #[test]
    fn mcp_regression_input_bookkeeping_releases_guard_before_pending_delivery() {
        let state = super::super::tests::test_state();
        let session_id = "deadlock-regression";
        state.session_states.insert(
            session_id.to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                ..Default::default()
            },
        );
        state
            .pending_injections
            .entry(session_id.to_string())
            .or_default()
            .push_back(crate::state::PendingInjection::peer_message(
                "queued message",
            ));

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            apply_input_bookkeeping(&state, session_id, "\r");
            let _ = done_tx.send(());
        });

        done_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("input bookkeeping must not self-deadlock while checking pending delivery");
    }

    #[test]
    fn bare_enter_uses_the_same_submission_bookkeeping_as_desktop_input() {
        let state = super::super::tests::test_state();
        let session_id = "http-bare-enter";
        state.session_states.insert(
            session_id.to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                awaiting_input: true,
                question_text: Some("Apply these edits?".to_string()),
                question_confident: true,
                ..Default::default()
            },
        );
        let mut events = state.event_bus.subscribe();

        apply_input_bookkeeping(&state, session_id, "\r");

        assert_eq!(state.session_states.get(session_id).unwrap().turn_epoch, 1);
        let event = events.try_recv().expect("bare Enter emits UserInput");
        let crate::state::AppEvent::PtyParsed { parsed, .. } = event else {
            panic!("expected parsed input event");
        };
        assert_eq!(parsed["type"], "user-input");
        assert_eq!(parsed["content"], "");
    }

    // is_separator_line tests live in chrome.rs (canonical location)

    // --- trim_screen_chrome ---

    #[test]
    fn trim_removes_prompt_and_separator() {
        let rows: Vec<String> = vec![
            "content line 1".into(),
            "content line 2".into(),
            "────────────────────────────────────────".into(),
            "❯ ".into(),
            "────────────────────────────────────────".into(),
            "  [Opus 4.6 | Max] tuicommander git:(main)".into(),
            "  ⏵⏵ bypass permissions on".into(),
        ];
        let result = trim_screen_chrome(&rows);
        assert_eq!(result.cutoff, 2);
    }

    #[test]
    fn trim_handles_decorated_separator_with_badge() {
        let rows: Vec<String> = vec![
            "some output".into(),
            "──────────────────────────────── pwa ──".into(),
            "❯ hello".into(),
            "──────────────────────────────── pwa ──".into(),
            "  status bar".into(),
        ];
        let result = trim_screen_chrome(&rows);
        assert_eq!(result.cutoff, 1);
    }

    #[test]
    fn trim_no_chrome_keeps_all() {
        let rows: Vec<String> = vec!["line 1".into(), "line 2".into(), "line 3".into()];
        let result = trim_screen_chrome(&rows);
        assert_eq!(result.cutoff, 3);
        // The caller keeps its rows: the trim only reports a cutoff.
        assert_eq!(rows.len(), 3);
    }

    #[test]
    fn trim_empty_input() {
        let result = trim_screen_chrome(&[]);
        assert_eq!(result.cutoff, 0);
    }

    // --- Log-WS screen polling (604-cb45 F14) ---
    //
    // The poll runs 5x/s per connected log client. Building the styled screen
    // before asking whether it changed made an idle session pay for a full
    // Vec<LogLine> — under the VtLogBuffer mutex — and throw it away.

    fn vt_log_with(output: &str) -> crate::state::VtLogBuffer {
        let mut buf = crate::state::VtLogBuffer::new(24, 80, 1000);
        buf.process(output.as_bytes());
        buf
    }

    #[test]
    fn screen_poll_materializes_only_on_a_change() {
        let buf = vt_log_with("hello world\r\n");

        let first = poll_screen(&buf, 0);
        assert!(
            first.screen.is_some(),
            "the first poll has nothing to compare against"
        );

        // Same buffer, same hash: nothing to send, so nothing to build.
        let second = poll_screen(&buf, first.hash);
        assert!(
            second.screen.is_none(),
            "an unchanged screen must not be materialized"
        );
        assert_eq!(
            second.hash, first.hash,
            "the signature must be stable across polls"
        );
    }

    #[test]
    fn screen_poll_reports_a_change_after_new_output() {
        let mut buf = vt_log_with("first\r\n");
        let first = poll_screen(&buf, 0);

        buf.process(b"second\r\n");
        let second = poll_screen(&buf, first.hash);

        assert!(second.screen.is_some(), "new output must reach the client");
        assert_ne!(second.hash, first.hash);
    }

    #[test]
    fn screen_poll_returns_the_same_rows_the_old_path_built() {
        let buf = vt_log_with("alpha\r\nbeta\r\n");

        let polled = poll_screen(&buf, 0)
            .screen
            .expect("a fresh screen is a change");
        let expected: Vec<_> = buf
            .screen_log_lines()
            .into_iter()
            .take(screen_chrome_cutoff(&buf).cutoff)
            .collect();

        assert_eq!(polled.len(), expected.len());
        for (got, want) in polled.iter().zip(expected.iter()) {
            assert_eq!(
                got.spans
                    .iter()
                    .map(|s| s.text.as_str())
                    .collect::<Vec<_>>(),
                want.spans
                    .iter()
                    .map(|s| s.text.as_str())
                    .collect::<Vec<_>>(),
            );
        }
    }

    #[test]
    fn screen_poll_treats_a_blank_screen_as_no_change() {
        // A buffer that has run but shows nothing: the old code sent no frame
        // because the styled screen came back empty after trailing-blank
        // trimming, and the cheap hash must not start sending one.
        let buf = vt_log_with("");
        assert!(poll_screen(&buf, 0).screen.is_none());
    }

    // --- WebSocket catch-up/subscribe race ---
    //
    // Regression guard for the ring-buffer catch-up race: the PTY writer and
    // the WS handler must serialize `ring.write` + `ws_clients.send` on both
    // sides via `ring.lock()`. If the two sides drift into separate critical
    // sections, bytes written during the window are delivered twice (once in
    // the catch-up snapshot, once through the live mpsc queue).
    //
    // This test reproduces the contract with tight concurrent loops and
    // asserts that every written byte is observed exactly once by a late
    // subscriber that reads its snapshot + drains its mpsc queue.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ws_catchup_no_duplicate_with_concurrent_writer() {
        use crate::state::OutputRingBuffer;
        use parking_lot::Mutex as PlMutex;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};

        const CHUNK_COUNT: u64 = 5_000;
        const CHUNK_SIZE: usize = 8; // just the index, no filler
        const CAPACITY: usize = CHUNK_COUNT as usize * CHUNK_SIZE * 2;
        // Subscriber waits until the writer has committed this many chunks
        // before attaching — guarantees a non-empty snapshot without relying
        // on wall-clock sleep.
        const ATTACH_AFTER: u64 = 100;

        let ring: Arc<PlMutex<OutputRingBuffer>> =
            Arc::new(PlMutex::new(OutputRingBuffer::new(CAPACITY)));
        let clients: Arc<PlMutex<Vec<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>>> =
            Arc::new(PlMutex::new(Vec::new()));
        let writer_progress: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let subscriber_attached: Arc<std::sync::atomic::AtomicBool> =
            Arc::new(std::sync::atomic::AtomicBool::new(false));

        // PTY writer: mirror the pty.rs critical section — ring.write + broadcast
        // under a single ring.lock().
        let writer_ring = ring.clone();
        let writer_clients = clients.clone();
        let writer_progress_w = writer_progress.clone();
        let subscriber_attached_w = subscriber_attached.clone();
        let writer = tokio::task::spawn_blocking(move || {
            for i in 0..CHUNK_COUNT {
                let payload = i.to_be_bytes().to_vec();

                // Mirror pty.rs: ring.write + broadcast under one ring.lock().
                let mut ring_guard = writer_ring.lock();
                ring_guard.write(&payload);
                {
                    let mut subs = writer_clients.lock();
                    subs.retain(|tx| tx.send(payload.clone()).is_ok());
                }
                drop(ring_guard);

                writer_progress_w.store(i + 1, Ordering::Release);

                // After ATTACH_AFTER chunks, wait for the subscriber to attach
                // before continuing — ensures the race window is exercised.
                if i + 1 == ATTACH_AFTER {
                    while !subscriber_attached_w.load(Ordering::Acquire) {
                        std::hint::spin_loop();
                    }
                }
            }
        });

        // Subscriber: attach mid-stream. Spins on the atomic counter instead
        // of sleeping, so the race window is exercised deterministically.
        let sub_ring = ring.clone();
        let sub_clients = clients.clone();
        let writer_progress_s = writer_progress.clone();
        let subscriber_attached_s = subscriber_attached.clone();
        let subscriber = tokio::task::spawn_blocking(move || {
            // Spin until the writer has made enough progress for a non-empty snapshot.
            while writer_progress_s.load(Ordering::Acquire) < ATTACH_AFTER {
                std::hint::spin_loop();
            }

            let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
            let (snapshot_bytes, snapshot_total) = {
                let r = sub_ring.lock();
                let snap = r.read_last(CAPACITY);
                sub_clients.lock().push(tx);
                snap
            };
            // Signal the writer that we're attached — it can resume writing.
            subscriber_attached_s.store(true, Ordering::Release);
            (snapshot_bytes, snapshot_total, rx)
        });

        let (snapshot_bytes, snapshot_total, mut rx) = subscriber.await.unwrap();
        writer.await.unwrap();

        // Drain remaining live frames.
        let mut live_bytes: Vec<u8> = Vec::new();
        while let Ok(chunk) = rx.try_recv() {
            live_bytes.extend_from_slice(&chunk);
        }

        // Reconstruct the chunk indices seen by the subscriber. Every chunk
        // is exactly CHUNK_SIZE bytes = one u64 BE index.
        let extract_indices = |bytes: &[u8]| -> Vec<u64> {
            bytes
                .as_chunks::<CHUNK_SIZE>()
                .0
                .iter()
                .map(|c| u64::from_be_bytes(*c))
                .collect()
        };

        let snapshot_indices = extract_indices(&snapshot_bytes);
        let live_indices = extract_indices(&live_bytes);

        // Precondition: both streams must be non-empty, otherwise the race
        // window was not exercised and the boundary invariants are vacuous.
        assert!(
            !snapshot_indices.is_empty(),
            "subscriber attached too late — no snapshot data"
        );
        assert!(
            !live_indices.is_empty(),
            "writer finished before subscriber — race not exercised"
        );

        // Invariants:
        // 1. Snapshot indices are strictly monotonically increasing by 1.
        for pair in snapshot_indices.windows(2) {
            assert_eq!(pair[1], pair[0] + 1, "snapshot not contiguous: {:?}", pair);
        }
        // 2. Live indices are strictly monotonically increasing by 1.
        for pair in live_indices.windows(2) {
            assert_eq!(pair[1], pair[0] + 1, "live not contiguous: {:?}", pair);
        }
        // 3. No overlap: the last snapshot index must be exactly one less
        //    than the first live index (no duplicate, no gap).
        let first_live = *live_indices
            .first()
            .expect("live_indices must be non-empty");
        let last_snap = *snapshot_indices
            .last()
            .expect("snapshot_indices must be non-empty");
        assert_eq!(
            first_live,
            last_snap + 1,
            "catch-up/live boundary wrong: last snapshot={last_snap}, first live={first_live}"
        );
        // 4. Every chunk written is accounted for exactly once.
        let total_seen = snapshot_indices.len() + live_indices.len();
        assert_eq!(
            total_seen as u64, CHUNK_COUNT,
            "expected all {CHUNK_COUNT} chunks, got {total_seen}"
        );
        // 5. total_written reported by the snapshot matches the number of
        //    bytes the writer had committed at snapshot time.
        assert!(snapshot_total <= CHUNK_COUNT * CHUNK_SIZE as u64);
        assert!(snapshot_total >= snapshot_indices.len() as u64 * CHUNK_SIZE as u64);
    }

    // --- Single-client full frames (story 601-82ef) ---
    //
    // Damage is tracked once per session, not per subscriber, and
    // `serialize_dirty_rows` CONSUMES it. So a full frame built for one WS client
    // silently takes the rows every other client was about to receive: the desktop
    // ticker's next serialize returns nothing and the desktop never learns those
    // rows changed. That is invisible row-map corruption on the other transport,
    // which is why this path has to hand the damage back.

    /// Feed enough output to dirty the grid, then drain the frame the ticker would
    /// have sent, leaving the buffer in the state a live session is in.
    fn dirty_session(state: &Arc<AppState>, session_id: &str, text: &str) {
        state.vt_log_buffers.insert(
            session_id.to_string(),
            parking_lot::Mutex::new(crate::state::VtLogBuffer::new(24, 80, 1000)),
        );
        state.grid_frame_dirty.insert(
            session_id.to_string(),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        let vt = state.vt_log_buffers.get(session_id).expect("just inserted");
        let mut vt = vt.lock();
        vt.process(text.as_bytes());
    }

    #[test]
    fn a_full_frame_for_one_client_does_not_consume_the_others_rows() {
        let state = super::super::tests::test_state();
        dirty_session(&state, "shared-damage", "hello from the pty\r\n");

        let frame = full_frame_for_single_client(&state, "shared-damage")
            .expect("a dirty session must produce a frame");
        assert!(!frame.is_empty());

        // What the desktop ticker does on its next tick.
        let ticker_frame = {
            let vt = state
                .vt_log_buffers
                .get("shared-damage")
                .expect("session exists");
            let mut vt = vt.lock();
            vt.serialize_dirty_rows()
        };
        assert!(
            !ticker_frame.is_empty(),
            "the WS resync ate the rows the desktop channel was about to be sent"
        );
    }

    /// The ticker only serializes when the session is marked dirty, so handing the
    /// damage back is worthless unless it also wakes the ticker up.
    #[test]
    fn a_full_frame_for_one_client_wakes_the_ticker() {
        let state = super::super::tests::test_state();
        dirty_session(&state, "wake-ticker", "hello\r\n");
        state
            .grid_frame_dirty
            .get("wake-ticker")
            .expect("flag exists")
            .store(false, std::sync::atomic::Ordering::Relaxed);

        full_frame_for_single_client(&state, "wake-ticker").expect("frame");

        assert!(
            state
                .grid_frame_dirty
                .get("wake-ticker")
                .expect("flag exists")
                .load(std::sync::atomic::Ordering::Relaxed),
            "restored damage that no tick will ever pick up is still a lost frame"
        );
    }

    #[test]
    fn a_full_frame_for_a_session_that_is_gone_is_none() {
        let state = super::super::tests::test_state();
        assert!(full_frame_for_single_client(&state, "no-such-session").is_none());
    }

    // --- Styled rows over HTTP (story 601-82ef) ---
    //
    // The desktop command hands these bytes over raw (`tauri::ipc::Response`), so
    // the browser transport must get them raw too, or the same `fetchChunk` code
    // has to branch per transport. `rpcImpl` picks `resp.arrayBuffer()` off the
    // content-type alone — the header IS the contract.

    #[tokio::test]
    async fn styled_rows_travel_as_binary_not_as_a_json_number_array() {
        use axum::body::to_bytes;

        let bytes = vec![26u8, 0, 255, 7];
        let response = styled_rows_response(bytes.clone()).into_response();

        assert_eq!(
            response
                .headers()
                .get(axum::http::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/octet-stream"),
            "rpcImpl branches on this header to call arrayBuffer()"
        );

        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body must be readable");
        assert_eq!(body.as_ref(), bytes.as_slice(), "bytes must survive intact");
    }

    /// A closed session or an out-of-range request serializes to nothing. That is
    /// a valid empty chunk, not an error — and it must still be typed binary so
    /// the client decodes it the same way as any other chunk.
    #[tokio::test]
    async fn an_empty_styled_row_range_is_still_a_binary_body() {
        use axum::body::to_bytes;

        let response = styled_rows_response(Vec::new()).into_response();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/octet-stream")
        );
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body must be readable");
        assert!(body.is_empty());
    }

    // --- Grid WS frame shapes (story 623-d369) ---
    //
    // The client destructures every frame as `const { type, ...payload } = event`
    // and hands `payload` to the same handler the desktop `listen()` feeds. So a
    // frame is correct only if it equals its Tauri payload plus a `type` key.
    //
    // These drive the real `grid_ws_frame` and compare against the serialized
    // Rust struct the desktop side emits — NOT against a hand-built object. A
    // test that rebuilds the expected shape by hand agrees only with itself and
    // stays green while the wire carries something the client cannot read.

    /// Strip the discriminator: what is left must be the Tauri event payload.
    fn frame_payload(frame: &serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        let mut map = frame.as_object().expect("frame must be an object").clone();
        assert!(map.remove("type").is_some(), "frame must carry a type");
        map
    }

    #[test]
    fn grid_ws_osc133_frame_matches_the_desktop_event_payload() {
        for (marker, exit_code) in [("A", None), ("D", Some(0)), ("D", Some(130))] {
            let frame = grid_ws_frame(&crate::state::AppEvent::PtyOsc133 {
                session_id: "s1".to_string(),
                marker: marker.to_string(),
                line: 42,
                exit_code,
            })
            .expect("osc133 must be carried by the grid WS");

            assert_eq!(frame["type"], "osc133");

            // The exact payload the desktop AppHandle emits for the same marker.
            let desktop = serde_json::to_value(crate::terminal_grid::Osc133Event {
                marker: marker.to_string(),
                line: 42,
                exit_code,
            })
            .expect("Osc133Event must serialize");

            assert_eq!(
                serde_json::Value::Object(frame_payload(&frame)),
                desktop,
                "grid WS payload drifted from the desktop Osc133Event ({marker})"
            );
        }
    }

    /// `exit_code: None` must survive as an explicit `null`, not vanish. The
    /// client reads `exit_code ?? undefined`, so a missing key and a null key
    /// happen to behave alike today — but a dropped key is one `skip_serializing_if`
    /// away from meaning "field removed" to any other consumer.
    #[test]
    fn grid_ws_osc133_frame_keeps_a_null_exit_code() {
        let frame = grid_ws_frame(&crate::state::AppEvent::PtyOsc133 {
            session_id: "s1".to_string(),
            marker: "A".to_string(),
            line: 0,
            exit_code: None,
        })
        .expect("osc133 must be carried by the grid WS");

        assert!(frame.get("exit_code").is_some(), "exit_code key must exist");
        assert!(frame["exit_code"].is_null());
    }

    /// The cwd payload is `{ cwd }` on BOTH transports. It cannot be a bare
    /// string on the wire — a frame needs its `type` discriminator — so the
    /// desktop emit was changed to match rather than the client made to branch.
    #[test]
    fn grid_ws_cwd_frame_carries_the_same_object_as_the_desktop_event() {
        let frame = grid_ws_frame(&crate::state::AppEvent::PtyCwd {
            session_id: "s1".to_string(),
            cwd: "/tmp/project".to_string(),
        })
        .expect("cwd must be carried by the grid WS");

        assert_eq!(frame["type"], "cwd");
        assert_eq!(
            serde_json::Value::Object(frame_payload(&frame)),
            serde_json::json!({ "cwd": "/tmp/project" })
        );
    }

    /// The regression this story fixes: both events used to reach the desktop
    /// AppHandle alone, so a browser/PWA client got no command blocks, no gutter
    /// marks, no Cmd+Up/Down navigation and no cwd tracking.
    #[test]
    fn grid_ws_carries_osc133_and_cwd_at_all() {
        assert!(
            grid_ws_frame(&crate::state::AppEvent::PtyOsc133 {
                session_id: "s1".to_string(),
                marker: "A".to_string(),
                line: 1,
                exit_code: None,
            })
            .is_some(),
            "OSC 133 must reach browser clients"
        );
        assert!(
            grid_ws_frame(&crate::state::AppEvent::PtyCwd {
                session_id: "s1".to_string(),
                cwd: "/tmp".to_string(),
            })
            .is_some(),
            "OSC 7 cwd must reach browser clients"
        );
    }

    /// Not every bus event belongs on this socket. The activity pulse
    /// (story 625-56b0) rides the subscribePty stream and has no consumer here,
    /// and waking every grid client for it would be pure cost.
    #[test]
    fn grid_ws_drops_events_it_has_no_consumer_for() {
        assert!(
            grid_ws_frame(&crate::state::AppEvent::PtyActivity {
                session_id: "s1".to_string(),
            })
            .is_none(),
            "the activity pulse must not be forwarded on the grid WS"
        );
    }

    // --- Grid watch channel (format=grid WS endpoint) ---

    /// Verifies that the grid_watch channel delivers frames with latest-frame-wins
    /// semantics: a slow receiver that misses intermediate sends still gets the
    /// most recent frame on its next `changed().await`.
    #[tokio::test]
    async fn grid_watch_latest_frame_wins() {
        let (tx, mut rx) = tokio::sync::watch::channel(Vec::<u8>::new());

        // Send 3 frames without the receiver polling
        tx.send(vec![1, 2, 3]).unwrap();
        tx.send(vec![4, 5, 6]).unwrap();
        tx.send(vec![7, 8, 9]).unwrap();

        // Receiver sees only the latest
        rx.changed().await.unwrap();
        let frame = rx.borrow_and_update().clone();
        assert_eq!(frame, vec![7, 8, 9]);

        // No pending change after consuming latest
        let result = tokio::time::timeout(std::time::Duration::from_millis(10), rx.changed()).await;
        assert!(result.is_err(), "should timeout — no new frame");
    }

    /// Verifies that a newly subscribed receiver gets the current value
    /// immediately (supports initial full-frame delivery in handle_ws_grid_session).
    #[tokio::test]
    async fn grid_watch_subscriber_gets_current_value() {
        let (tx, _rx) = tokio::sync::watch::channel(Vec::<u8>::new());

        // Publish a frame
        tx.send(vec![10, 20, 30]).unwrap();

        // New subscriber sees current value via borrow()
        let rx2 = tx.subscribe();
        let current = rx2.borrow().clone();
        assert_eq!(current, vec![10, 20, 30]);
    }

    /// Verifies that spawn_pty_session registers a grid_watch channel for the session,
    /// so that handle_ws_grid_session can subscribe to it (regression for BUG-2).
    #[tokio::test]
    async fn spawn_pty_session_registers_grid_watch() {
        let state = super::super::tests::test_state();

        assert!(state.grid_watch.is_empty());

        let result = super::spawn_pty_session(
            state.clone(),
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()),
            None,
            24,
            80,
            None,
            None,
        );

        let session_id = match result {
            Ok(id) => id,
            Err(_) => return, // PTY unavailable in CI — skip gracefully
        };

        assert!(
            state.grid_watch.contains_key(&session_id),
            "spawn_pty_session must register a grid_watch channel"
        );

        // Verify the channel is functional, and that a published frame carries
        // the sequence number the WS reader needs to spot a dropped delta.
        let tx = state.grid_watch.get(&session_id).unwrap();
        let mut rx = tx.subscribe();
        let first_seq = rx.borrow_and_update().seq;
        crate::grid_gate::publish_grid_frame(&tx, vec![1, 2, 3]);
        rx.changed().await.unwrap();
        let slot = rx.borrow_and_update();
        assert_eq!(slot.frame, vec![1, 2, 3]);
        assert_eq!(slot.seq, first_seq + 1);
    }

    /// A client-provided session id is honored (browser duplicate-tab fix): the
    /// browser pre-registers this id locally so the session-created echo is
    /// recognized as locally-created.
    #[tokio::test]
    async fn spawn_pty_session_honors_requested_id() {
        let state = super::super::tests::test_state();
        let result = super::spawn_pty_session(
            state.clone(),
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()),
            None,
            24,
            80,
            None,
            Some("client-provided-id".to_string()),
        );
        // PTY unavailable in CI — skip gracefully
        if let Ok(id) = result {
            assert_eq!(
                id, "client-provided-id",
                "must honor the client-provided id"
            );
        }
    }

    /// A requested id that collides with an existing session is rejected in
    /// favor of a fresh uuid, so a buggy/duplicate client id can never hijack
    /// or alias another live session.
    #[tokio::test]
    async fn spawn_pty_session_rejects_duplicate_requested_id() {
        let state = super::super::tests::test_state();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let first = match super::spawn_pty_session(
            state.clone(),
            shell.clone(),
            None,
            24,
            80,
            None,
            Some("dup-id".to_string()),
        ) {
            Ok(id) => id,
            Err(_) => return, // PTY unavailable in CI — skip gracefully
        };
        assert_eq!(first, "dup-id");
        let second = super::spawn_pty_session(
            state.clone(),
            shell,
            None,
            24,
            80,
            None,
            Some("dup-id".to_string()),
        )
        .expect("second spawn should succeed with a fresh id");
        assert_ne!(
            second, "dup-id",
            "duplicate requested id must fall back to a fresh uuid"
        );
    }
}
