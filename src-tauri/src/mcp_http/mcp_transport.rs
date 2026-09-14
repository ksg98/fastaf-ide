use crate::pty::{resolve_shell, spawn_reader_thread};
use crate::state::{OUTPUT_RING_BUFFER_CAPACITY, VT_LOG_BUFFER_CAPACITY, VtLogBuffer};
use crate::{AppState, MAX_CONCURRENT_SESSIONS, OutputRingBuffer, PtySession};
use axum::Json;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use parking_lot::Mutex;
use portable_pty::{CommandBuilder, PtySize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
#[cfg(feature = "desktop")]
use tauri::Emitter;
use uuid::Uuid;

/// Serialize a value to JSON, returning a structured error on failure instead of silent null.
fn to_json_or_error<T: serde::Serialize>(value: T) -> serde_json::Value {
    match serde_json::to_value(value) {
        Ok(v) => v,
        Err(e) => serde_json::json!({"error": format!("Serialization failed: {e}")}),
    }
}

fn serialize_tool_result(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// Private transport marker used to carry a proxied `tools/call` result through
/// the collapsed `call_tool` meta-path without confusing it with a native
/// handler value. The marker is removed before any public response is emitted.
const UPSTREAM_TOOL_RESULT_MARKER: &str = "__tuic_upstream_tool_result";

fn mark_upstream_tool_result(value: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ UPSTREAM_TOOL_RESULT_MARKER: value })
}

fn unmark_upstream_tool_result(value: serde_json::Value) -> serde_json::Value {
    value
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get(UPSTREAM_TOOL_RESULT_MARKER))
        .cloned()
        .unwrap_or(value)
}

fn upstream_tool_result(value: &serde_json::Value) -> Option<&serde_json::Value> {
    value
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get(UPSTREAM_TOOL_RESULT_MARKER))
}

/// Produce the JSON-RPC `result` for a `tools/call` response.
///
/// A successful upstream call already speaks the MCP CallToolResult contract,
/// so preserve a valid object field-for-field at the JSON value level. Malformed
/// upstream values and every native TUIC value retain the compact text fallback.
fn format_tool_call_result(result: &serde_json::Value, is_error: bool) -> serde_json::Value {
    if let Some(upstream) = upstream_tool_result(result)
        && upstream
            .as_object()
            .and_then(|object| object.get("content"))
            .is_some_and(serde_json::Value::is_array)
    {
        return upstream.clone();
    }

    let fallback = upstream_tool_result(result).unwrap_or(result);
    serde_json::json!({
        "content": [{ "type": "text", "text": serialize_tool_result(fallback) }],
        "isError": is_error
    })
}

fn insert_optional_value(
    object: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: Option<serde_json::Value>,
) {
    if let Some(value) = value {
        object.insert(key.to_string(), value);
    }
}

/// Single source of truth for detecting Claude Code (or tuic-bridge) clients.
fn detect_claude_code_client(client_name: Option<&str>) -> bool {
    client_name.is_some_and(|n| n.contains("claude") || n.contains("tuic-bridge"))
}

/// Grok accepts exactly one `__` delimiter in a qualified MCP tool id. TUIC's
/// upstream names would become `tuicommander__upstream__tool` after Grok adds
/// the server namespace, so expose the existing meta-tool surface for that
/// client instead of letting it silently discard every proxied tool.
fn client_requires_meta_tools(client_name: Option<&str>) -> bool {
    client_name
        .map(str::to_ascii_lowercase)
        .is_some_and(|name| name.starts_with("grok-shell-"))
}

/// Detect Claude Code from the User-Agent header when the MCP clientInfo is
/// unavailable (e.g. after session auto-recovery following a TUIC restart).
fn detect_claude_code_from_headers(headers: &HeaderMap) -> bool {
    headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|ua| ua.to_ascii_lowercase())
        .is_some_and(|ua| ua.contains("claude") || ua.contains("tuic-bridge"))
}

/// Whether the recipient can consume `notifications/claude/channel` inside an
/// already active turn. Every MCP client may own an SSE stream, but the channel
/// notification is a Claude Code extension and transport receipt does not
/// submit a new prompt. Managed sessions therefore use the channel only while
/// canonical Claude lifecycle state is working; an idle or completed composer
/// must take the PTY submission path. External peers have no PTY fallback and
/// retain the owner capability as their authority.
fn recipient_supports_active_claude_channel(
    state: &AppState,
    recipient: &str,
    mcp_session_id: &str,
    managed_recipient: bool,
) -> bool {
    let owner_supports_channel = state
        .mcp_sessions
        .get(mcp_session_id)
        .is_some_and(|session| session.is_claude_code && session.has_sse_stream);
    if !owner_supports_channel {
        return false;
    }
    if !managed_recipient {
        return true;
    }
    state
        .session_state_with_shell(recipient)
        .is_some_and(|session| {
            session.agent_type.as_deref() == Some("claude")
                && session.agent_state.as_deref() == Some("working")
        })
}

/// Map MCP client name to FastAF agent type key.
/// Returns None when the client cannot be identified.
fn resolve_agent_type(client_name: Option<&str>) -> Option<&'static str> {
    let name = client_name?.to_ascii_lowercase();
    if name.contains("claude") || name.contains("tuic-bridge") {
        Some("claude")
    } else if name.contains("codex") {
        Some("codex")
    } else if name.contains("cursor") {
        Some("cursor")
    } else if name.contains("gemini") {
        Some("gemini")
    } else if name.contains("aider") {
        Some("aider")
    } else if name.contains("amp") {
        Some("amp")
    } else if name.contains("goose") {
        Some("goose")
    } else {
        None
    }
}

/// Resolve effective intent_tab_title / suggest_followups for a connecting agent.
/// Semantics: `global AND (per_agent ?? true)`. Global acts as a kill-switch for
/// the whole feature; per-agent is an escape hatch (default ON) to disable the
/// marker on a specific agent where rendering or parsing misbehaves.
fn resolve_marker_flags(state: &Arc<AppState>, client_name: Option<&str>) -> (bool, bool) {
    marker_flags_for_agent(state, resolve_agent_type(client_name))
}

/// Same rule, keyed by agent type instead of by client name, so a caller that
/// already knows the agent (a live session, the marker diagnostics) does not
/// have to reverse-engineer a client name to ask the question (#4421).
pub(crate) fn marker_flags_for_agent(state: &AppState, agent_type: Option<&str>) -> (bool, bool) {
    let global_intent = state.config.read().intent_tab_title;
    let global_suggest = state.config.read().suggest_followups;

    let agents_cfg = crate::config::load_agents_config();
    let agent_settings = agent_type.and_then(|t| agents_cfg.agents.get(t));

    let show_intent = global_intent
        && agent_settings
            .and_then(|s| s.intent_tab_title)
            .unwrap_or(true);

    let show_suggest = global_suggest
        && agent_settings
            .and_then(|s| s.suggest_followups)
            .unwrap_or(true);

    (show_intent, show_suggest)
}

/// SIMP-1: Drain registered HTML tabs for a closing/killed/exited session and
/// emit `close-html-tabs` to the frontend. SIL-3: log a warning if the emit
/// fails (don't drop silently — orphan tabs in UI hint at a missing app handle
/// or a broken event channel).
///
/// Shared by `session(close)`, `session(kill)`, and `pty::mark_session_exited`
/// (natural exit) so all three exit paths drain `session_html_tabs` identically.
pub(crate) fn emit_close_html_tabs(state: &AppState, session_id: &str) {
    let Some((_, tab_ids)) = state.session_html_tabs.remove(session_id) else {
        return;
    };
    let _ = state.event_bus.send(crate::state::AppEvent::CloseHtmlTabs {
        tab_ids: tab_ids.clone(),
    });
    #[cfg(feature = "desktop")]
    #[allow(clippy::collapsible_if)]
    if let Some(app) = state.app_handle.read().as_ref() {
        if let Err(err) = app.emit("close-html-tabs", serde_json::json!({ "tab_ids": tab_ids })) {
            tracing::warn!(
                source = "session",
                session_id = %session_id,
                tab_count = tab_ids.len(),
                error = %err,
                "failed to emit close-html-tabs — frontend tabs may be orphaned"
            );
        }
    }
}

/// Validate that a string is a well-formed UUID in canonical 8-4-4-4-12 form.
/// Used to reject non-UUID `tuic_session` values at register time to prevent
/// prompt-injection via preamble string interpolation (SEC-1).
///
/// Length check rejects the `uuid` crate's accepted simple/urn/braced forms —
/// `$TUIC_SESSION` is always written canonical, and narrowing the accepted
/// surface keeps the injection guard tight.
fn is_valid_uuid(s: &str) -> bool {
    s.len() == 36 && Uuid::parse_str(s).is_ok()
}

/// Current unix time in milliseconds. Centralizes the `SystemTime` boilerplate
/// duplicated across the messaging/spawn paths.
fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Peer ownership spans several DashMaps, so registration/reconnect takeover
/// must update them as one critical section rather than racing map-by-map.
static PEER_IDENTITY_BIND_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// A bridge checks liveness every three seconds. A session is an active owner
/// while it has a real SSE subscriber, or while requests arrived recently enough
/// to cover one missed health tick. Mere presence in `mcp_sessions` is not
/// liveness: entries intentionally remain for up to one hour.
const MCP_OWNER_ACTIVITY_GRACE: std::time::Duration = std::time::Duration::from_secs(6);

/// Takeover rejection is a *permanent* condition while the incumbent lives, and
/// the loser retries every three seconds forever — one duplicated MCP
/// registration produced 5004 identical WARN lines in a single day, burying
/// every other log. Report the first rejection per claimant pair in full, then
/// one periodic summary carrying the suppressed count.
const TAKEOVER_REJECT_SUMMARY_INTERVAL: std::time::Duration = std::time::Duration::from_secs(300);

/// Drop claimants idle for this long, so a long-lived app does not accumulate
/// one entry per short-lived MCP session.
const TAKEOVER_REJECT_ENTRY_TTL: std::time::Duration = std::time::Duration::from_secs(3600);

struct TakeoverRejectLog {
    suppressed: u64,
    last_reported: std::time::Instant,
}

static TAKEOVER_REJECT_LOG: LazyLock<Mutex<HashMap<(String, String), TakeoverRejectLog>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Decide how to report one takeover rejection.
///
/// Returns `Some(suppressed_since_last_report)` when this occurrence must be
/// logged at WARN — `Some(0)` is the first sighting of the pair — and `None`
/// when it is a repeat that the caller should log at debug instead.
fn takeover_rejection_report(tuic_session: &str, mcp_sid: &str) -> Option<u64> {
    let now = std::time::Instant::now();
    let mut log = TAKEOVER_REJECT_LOG.lock();

    log.retain(|_, entry| now.duration_since(entry.last_reported) < TAKEOVER_REJECT_ENTRY_TTL);

    match log.get_mut(&(tuic_session.to_string(), mcp_sid.to_string())) {
        None => {
            log.insert(
                (tuic_session.to_string(), mcp_sid.to_string()),
                TakeoverRejectLog {
                    suppressed: 0,
                    last_reported: now,
                },
            );
            Some(0)
        }
        Some(entry) => {
            if now.duration_since(entry.last_reported) >= TAKEOVER_REJECT_SUMMARY_INTERVAL {
                let suppressed = entry.suppressed;
                entry.suppressed = 0;
                entry.last_reported = now;
                Some(suppressed)
            } else {
                entry.suppressed += 1;
                None
            }
        }
    }
}

/// Cap for a peer message typed into a terminal. Longer messages become a
/// pointer to the inbox rather than flooding the recipient's screen.
const INJECT_MAX_BYTES: usize = 2048;

/// One-shot guard for a deferred initial prompt. No success event is emitted;
/// only a prompt still pending after this interval notifies the parent.
const INITIAL_PROMPT_DELIVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Placeholder stored in `session_parent` when a caller spawns before binding
/// its MCP connection to a TUIC peer identity. The later `register` call swaps
/// this for the stable TUIC session UUID and migrates any early lifecycle mail.
const PENDING_PARENT_PREFIX: &str = "pending-mcp:";

fn pending_parent_id(mcp_session_id: &str) -> String {
    format!("{PENDING_PARENT_PREFIX}{mcp_session_id}")
}

/// Interval a client should poll a task handle at. Floored well above zero so a
/// stuck orchestrator cannot hot-loop the server.
const TASK_POLL_INTERVAL_MS: u64 = 1000;

/// Owner recorded for a caller with no identity of any kind. `agent spawn` is
/// loopback-only and per AGENTS.md the OS user is the auth boundary, so anonymous
/// local callers share one bucket rather than being locked out of their own tasks.
const ANONYMOUS_TASK_OWNER: &str = "loopback";

/// Every identity the caller may legitimately claim, most specific first.
///
/// The first element stamps a new task; the whole set is what an ownership check
/// accepts. Both matter: a caller that spawns before registering is stamped with
/// its pending id, and once it auto-binds its specific identity changes — it must
/// not lose the handle it was already given. `pending_parent_id` is the same alias
/// `link_pending_children_to_parent` reconciles for child sessions.
fn caller_task_identities(caller_tuic: Option<&str>, mcp_session_id: Option<&str>) -> Vec<String> {
    let mut identities: Vec<String> = caller_tuic
        .map(str::to_string)
        .into_iter()
        .chain(mcp_session_id.map(pending_parent_id))
        .collect();
    if identities.is_empty() {
        identities.push(ANONYMOUS_TASK_OWNER.to_string());
    }
    identities
}

/// The identity a new task is stamped with.
fn task_owner_identity(caller_tuic: Option<&str>, mcp_session_id: Option<&str>) -> String {
    caller_task_identities(caller_tuic, mcp_session_id).swap_remove(0)
}

fn link_pending_children_to_parent(
    state: &AppState,
    mcp_session_id: &str,
    parent_tuic_session: &str,
) -> usize {
    let pending_parent = pending_parent_id(mcp_session_id);
    let children: Vec<String> = state
        .session_parent
        .iter()
        .filter(|entry| entry.value() == &pending_parent)
        .map(|entry| entry.key().clone())
        .collect();
    for child in &children {
        state
            .session_parent
            .insert(child.clone(), parent_tuic_session.to_string());
    }
    if let Some((_, messages)) = state.agent_inbox.remove(&pending_parent) {
        for message in messages {
            let message_id = message.id.clone();
            let message_timestamp = state.push_agent_inbox(parent_tuic_session, message);
            crate::pty::route_registered_orchestrator_mail(
                state,
                parent_tuic_session,
                &message_id,
                message_timestamp,
            );
        }
    }
    if let Some((_, missed)) = state.agent_inbox_evictions.remove(&pending_parent) {
        *state
            .agent_inbox_evictions
            .entry(parent_tuic_session.to_string())
            .or_default() += missed;
    }

    children.len()
}

/// Frame a peer message as a single line to type into the recipient's terminal.
/// Newlines are collapsed to spaces (a multi-line paste into a TUI is fragile);
/// oversized bodies become a pointer to the inbox. The full, untouched content
/// always remains available via `agent action=inbox`.
fn frame_peer_message(sender_name: &str, content: &str) -> String {
    let one_line = content.replace(['\n', '\r'], " ");
    let framed = format!("[TUIC message from {sender_name}] {one_line}");
    if framed.len() > INJECT_MAX_BYTES {
        format!("[TUIC] new message from {sender_name} — read it with: agent action=inbox")
    } else {
        framed
    }
}

/// HTTP header the bridge asserts to declare which PTY session it belongs to.
/// The value is the agent's `$TUIC_SESSION` (the PTY tab UUID), which the bridge
/// inherits from its parent agent process's environment.
const TUIC_SESSION_HEADER: &str = "x-tuic-session";

/// Bind an MCP session to a PTY (tuic) session identity: upsert `peer_agents`
/// and the `mcp_to_session` / `session_to_mcp` reverse indices. Callers hold
/// `PEER_IDENTITY_BIND_LOCK` after applying the shared live-owner policy below.
fn bind_peer_identity_locked(
    state: &AppState,
    mcp_sid: &str,
    tuic_session: &str,
    name: String,
    project: Option<String>,
    registered_at: u64,
) {
    let prior_mcp = state
        .peer_agents
        .get(tuic_session)
        .map(|peer| peer.mcp_session_id.clone())
        .filter(|prior| !prior.is_empty() && prior != mcp_sid);

    // A reconnect changes the protocol-session id. Retire the old routing
    // entries before publishing the replacement so inbox ownership cannot be
    // split between the stale and current bridge.
    if let Some(prior_mcp) = prior_mcp {
        state
            .mcp_to_session
            .remove_if(&prior_mcp, |_, mapped| mapped == tuic_session);
        let remove_reverse = if let Some(mut reverse) = state.session_to_mcp.get_mut(tuic_session) {
            reverse.retain(|sid| sid != &prior_mcp);
            reverse.is_empty()
        } else {
            false
        };
        if remove_reverse {
            state.session_to_mcp.remove(tuic_session);
        }
        // The retired bridge may still hold `agent wait` leases. They outlive its
        // routing entries and keep beating terminal delivery, so the reconnected
        // peer would go unwoken until they time out.
        state.revoke_waiters_for_reconnect(tuic_session);
    }

    state.peer_agents.insert(
        tuic_session.to_string(),
        crate::state::PeerAgent {
            tuic_session: tuic_session.to_string(),
            mcp_session_id: mcp_sid.to_string(),
            name,
            project,
            registered_at,
        },
    );
    state
        .mcp_to_session
        .insert(mcp_sid.to_string(), tuic_session.to_string());
    let mut reverse = state
        .session_to_mcp
        .entry(tuic_session.to_string())
        .or_default();
    if !reverse.iter().any(|s| s == mcp_sid) {
        reverse.push(mcp_sid.to_string());
    }
}

/// Who holds an identity when another protocol session asks for it.
enum PeerIdentityOwnership {
    /// Nothing live stands in the way. The payload is the stale prior owner,
    /// whose routing entries and wait leases must be retired on the way in.
    Vacant(Option<String>),
    /// Another protocol session owns it and is still live. Whether that means
    /// "share" or "refuse" is the caller's call, not this predicate's.
    LiveOwner,
}

fn mcp_session_has_live_owner(state: &AppState, mcp_sid: &str) -> bool {
    let has_sse_subscriber = state
        .messaging_channels
        .get(mcp_sid)
        .is_some_and(|sender| sender.receiver_count() > 0);
    if has_sse_subscriber {
        return true;
    }
    state
        .mcp_sessions
        .get(mcp_sid)
        .is_some_and(|meta| meta.last_activity.elapsed() <= MCP_OWNER_ACTIVITY_GRACE)
}

/// Report who holds the identity. The caller must hold `PEER_IDENTITY_BIND_LOCK`
/// so the liveness answer and the routing-map change it drives form one critical
/// section.
fn peer_identity_ownership_locked(
    state: &AppState,
    mcp_sid: &str,
    tuic_session: &str,
) -> PeerIdentityOwnership {
    let prior_mcp = state
        .peer_agents
        .get(tuic_session)
        .map(|peer| peer.mcp_session_id.clone())
        .filter(|prior| !prior.is_empty() && prior != mcp_sid);

    if prior_mcp
        .as_deref()
        .is_some_and(|prior| mcp_session_has_live_owner(state, prior))
    {
        return PeerIdentityOwnership::LiveOwner;
    }

    PeerIdentityOwnership::Vacant(prior_mcp)
}

/// True when this protocol session already routes to the identity, which only
/// happens after an earlier header assertion or registration bound the two.
fn mcp_session_routes_to(state: &AppState, mcp_sid: &str, tuic_session: &str) -> bool {
    state
        .mcp_to_session
        .get(mcp_sid)
        .is_some_and(|bound| bound.value() == tuic_session)
}

/// Add a co-owner to an identity a live sibling already owns: routing entries
/// only, so the sibling keeps delivery ownership. Two live bridges that traded
/// ownership on every request would flip the delivery channel back and forth;
/// the inbox is keyed by the PTY identity, so sharing the routes is enough for
/// both to read the same mail.
fn join_peer_identity_locked(state: &AppState, mcp_sid: &str, tuic_session: &str) {
    state
        .mcp_to_session
        .insert(mcp_sid.to_string(), tuic_session.to_string());
    let mut reverse = state
        .session_to_mcp
        .entry(tuic_session.to_string())
        .or_default();
    if !reverse.iter().any(|s| s == mcp_sid) {
        reverse.push(mcp_sid.to_string());
    }
}

/// Retire the identity a caller just abandoned by registering a different one.
///
/// Only a terminal-less identity is retired: it is a mailbox nobody can reach any
/// more once its single owner has moved on, and leaving it behind is how
/// `list_peers` accumulates addresses that silently swallow every message sent to
/// them. Mail already buffered under it is carried over rather than dropped —
/// those are the replies the caller went looking for in the first place. An
/// abandoned identity that still owns a PTY is left alone; its terminal, not this
/// registration, decides its lifetime.
/// What a retire attempt actually did. The skip case used to be a silent early
/// return, which is how mail addressed to a superseded identity sat unread with
/// nobody told: `register` now reports it back to the caller.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IdentityHandoff {
    /// The prior identity was abandoned; its mail moved and was re-routed.
    Migrated { messages: usize },
    /// The prior identity still owns a live PTY, so it is a reachable peer rather
    /// than an abandoned one. Migrating would take mail from a working agent.
    SkippedLivePty { pending: usize },
}

fn retire_repaired_phantom_identity(
    state: &AppState,
    phantom: &str,
    repaired: &str,
) -> IdentityHandoff {
    // The retire spans several maps, and `send` reads one of them (`peer_agents`)
    // to decide whether a recipient exists before buffering. Both halves take
    // `PEER_IDENTITY_BIND_LOCK` so a send can only land entirely before the
    // retire — and be carried over with the rest of the inbox — or entirely
    // after it, where the missing peer makes it an explicit refusal. Routing the
    // carried mail happens after the guard drops: it wakes PTYs and must not
    // hold an identity lock across that I/O.
    let carried: Vec<(String, u64)> = {
        let _bind_guard = PEER_IDENTITY_BIND_LOCK.lock();
        if state.live_pty_for_peer(phantom).is_some() {
            let pending = state
                .agent_inbox
                .get(phantom)
                .map(|inbox| inbox.len())
                .unwrap_or(0);
            return IdentityHandoff::SkippedLivePty { pending };
        }
        let was_orchestrator = state.orchestrator_peers.remove(phantom).is_some();
        if was_orchestrator {
            let children: Vec<String> = state
                .session_parent
                .iter()
                .filter(|entry| entry.value() == phantom)
                .map(|entry| entry.key().clone())
                .collect();
            for child in children {
                state.session_parent.insert(child, repaired.to_string());
            }
            state.orchestrator_peers.insert(repaired.to_string());
        }
        // Drop the addressable identity before draining: a send blocked on the
        // guard then finds no recipient instead of refilling the inbox we just
        // emptied.
        state.peer_agents.remove(phantom);
        let carried = match state.agent_inbox.remove(phantom) {
            Some((_, pending)) => pending
                .into_iter()
                .map(|message| {
                    let message_id = message.id.clone();
                    let message_timestamp = state.push_agent_inbox(repaired, message);
                    (message_id, message_timestamp)
                })
                .collect(),
            None => Vec::new(),
        };
        // The cursor indexes the mail we just moved, so it moves with it. `max`
        // because the replacing identity may have read mail of its own already;
        // a migrated message whose logical timestamp had to be bumped past the
        // cursor is re-delivered once, which is the harmless direction to err in.
        let phantom_cursor = state
            .agent_read_cursor
            .get(phantom)
            .map(|cursor| *cursor.value())
            .unwrap_or(0);
        advance_agent_cursor(state, repaired, phantom_cursor);
        drop_identity_buffers(state, phantom);
        carried
    };
    let migrated = carried.len();
    for (message_id, message_timestamp) in carried {
        crate::pty::route_registered_orchestrator_mail(
            state,
            repaired,
            &message_id,
            message_timestamp,
        );
    }
    tracing::info!(
        source = "agent_msg",
        event = "phantom_identity_retired",
        phantom = %phantom,
        repaired = %repaired,
        "Retired a terminal-less identity its owner abandoned"
    );
    let _ = state
        .event_bus
        .send(crate::state::AppEvent::PeerUnregistered {
            tuic_session: phantom.to_string(),
        });
    IdentityHandoff::Migrated { messages: migrated }
}

fn register_peer_identity(
    state: &AppState,
    mcp_sid: &str,
    tuic_session: &str,
    name: String,
    project: Option<String>,
    registered_at: u64,
) -> Result<Option<String>, String> {
    let _bind_guard = PEER_IDENTITY_BIND_LOCK.lock();
    match peer_identity_ownership_locked(state, mcp_sid, tuic_session) {
        PeerIdentityOwnership::Vacant(prior_mcp) => {
            bind_peer_identity_locked(state, mcp_sid, tuic_session, name, project, registered_at);
            Ok(prior_mcp)
        }
        // A session that already routes to the identity was bound to it by an
        // earlier header assertion, so it is a sibling bridge inside the same
        // PTY rather than a claimant — register is its rename, not a takeover.
        PeerIdentityOwnership::LiveOwner if mcp_session_routes_to(state, mcp_sid, tuic_session) => {
            join_peer_identity_locked(state, mcp_sid, tuic_session);
            if let Some(mut peer) = state.peer_agents.get_mut(tuic_session) {
                peer.name = name;
                if project.is_some() {
                    peer.project = project;
                }
            }
            Ok(None)
        }
        PeerIdentityOwnership::LiveOwner => {
            Err("tuic_session is already registered to another active MCP session".to_string())
        }
    }
}

/// Auto-bind an MCP session to its PTY identity from the `x-tuic-session` header
/// that tuic-bridge asserts (it inherits `TUIC_SESSION` from the agent PTY).
/// Makes managed-peer identity automatic — no explicit `agent register` needed, which
/// matters for clients that never surface initialize `instructions` (e.g. Codex).
/// Ignored unless the header is a well-formed UUID. Preserves an existing peer's
/// display name/project across a bridge reconnect (only `register` renames).
/// A fresh MCP session may reclaim a stale owner, but cannot replace another
/// subscribed or recently active bridge. Returns whether a bind happened.
fn apply_initialize_identity(state: &AppState, mcp_sid: &str, header: Option<&str>) -> bool {
    let Some(tuic) = header.filter(|s| !s.is_empty()) else {
        return false;
    };
    if !is_valid_uuid(tuic) {
        return false;
    }
    // Steady state for a connected bridge: it already routes to the identity and
    // already owns it, so both branches below would rewrite the values that are
    // there. Every bridge asserts this header on a `ping` every 3s, so without
    // this the liveness poll serialises N terminals on a process-global mutex to
    // do nothing. Any disagreement between the maps still takes the lock.
    if mcp_session_routes_to(state, mcp_sid, tuic)
        && state
            .peer_agents
            .get(tuic)
            .is_some_and(|peer| peer.mcp_session_id == mcp_sid)
    {
        return true;
    }
    let _bind_guard = PEER_IDENTITY_BIND_LOCK.lock();
    // Only a process that inherited this PTY's `$TUIC_SESSION` can assert the
    // header, so a second asserting bridge is a sibling inside that PTY, not a
    // claimant from outside it — Codex opens two. It joins the identity's routing
    // instead of taking it over; ownership stays with the bridge that has it, so
    // two live siblings cannot trade the delivery channel on every request.
    let prior_mcp = match peer_identity_ownership_locked(state, mcp_sid, tuic) {
        PeerIdentityOwnership::Vacant(prior_mcp) => prior_mcp,
        PeerIdentityOwnership::LiveOwner => {
            join_peer_identity_locked(state, mcp_sid, tuic);
            return true;
        }
    };
    let (name, project, registered_at) = match state.peer_agents.get(tuic) {
        Some(existing) => (
            existing.name.clone(),
            existing.project.clone(),
            existing.registered_at,
        ),
        None => ("agent".to_string(), None, now_unix_ms()),
    };
    bind_peer_identity_locked(state, mcp_sid, tuic, name, project, registered_at);
    if let Some(prior_mcp) = prior_mcp {
        tracing::warn!(
            source = "mcp_initialize",
            event = "stale_binding_takeover",
            tuic_session = %tuic,
            prior_mcp_session = %prior_mcp,
            mcp_session = %mcp_sid,
            "Reclaimed stale MCP peer binding during initialize"
        );
    }
    true
}

/// Resolve the cwd of the managed PTY asserted by the bridge header without
/// changing peer ownership or routing. Spawn uses this only as a cwd hint when
/// identity binding is legitimately unavailable (for example, a live-owner
/// conflict); messaging continues to rely exclusively on the binding maps.
fn managed_parent_cwd_from_header(
    state: &AppState,
    mcp_session_id: Option<&str>,
    header: Option<&str>,
) -> Option<String> {
    let tuic_session = header.filter(|value| is_valid_uuid(value))?;
    if let Some(bound_tuic) = mcp_session_id.and_then(|sid| state.mcp_to_session.get(sid))
        && bound_tuic.value() != tuic_session
    {
        return None;
    }
    state
        .sessions
        .get(tuic_session)
        .and_then(|session| session.lock().cwd.clone())
}

/// Refresh a protocol session and re-assert its PTY identity on every request.
/// Both maps are in-memory and disappear on a TUIC restart; a long-lived bridge
/// may keep its old MCP session id, so merely recreating `mcp_sessions` is not
/// enough to keep `agent send` registered.
fn refresh_mcp_session(
    state: &AppState,
    mcp_sid: &str,
    is_claude_code: bool,
    tuic_session_header: Option<&str>,
) {
    if let Some(mut meta) = state.mcp_sessions.get_mut(mcp_sid) {
        meta.last_activity = std::time::Instant::now();
    } else {
        state.mcp_sessions.insert(
            mcp_sid.to_string(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code,
                requires_meta_tools: false,
                has_sse_stream: false,
                sse_generation: 0,
                repo_path: None,
            },
        );
    }
    apply_initialize_identity(state, mcp_sid, tuic_session_header);
}

/// Reuse the bridge's live protocol session when it proxies the downstream
/// client's initialize request. The bridge eagerly initializes once so it can
/// expose tools while the client is starting, then forwards the client's own
/// initialize with that session ID. Minting a second ID here would make the
/// live-owner guard correctly reject the same bridge as an identity takeover.
fn initialize_session_id(state: &AppState, headers: &HeaderMap) -> (String, InitializeKind) {
    let presented = headers
        .get(MCP_SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|session_id| is_valid_uuid(session_id));
    match presented {
        Some(sid) if state.mcp_sessions.contains_key(sid) => {
            (sid.to_string(), InitializeKind::Resumed)
        }
        // The client came back holding a session id we no longer have — reaped by
        // the idle sweep, or lost with a restart. It gets a new one and never
        // learns why. This is the moment an agent reports "FastAF is back",
        // so it is the one case that must not be silent.
        Some(sid) => (
            Uuid::new_v4().to_string(),
            InitializeKind::Reconnected {
                presented: sid.to_string(),
            },
        ),
        None => (Uuid::new_v4().to_string(), InitializeKind::Fresh),
    }
}

/// How a client arrived at `initialize`. Logged so a claim about the MCP
/// connection dropping is checkable against the record instead of taken on trust:
/// previously only the peer-binding takeover was logged, and only when a prior
/// binding happened to exist, so an ordinary reconnect left no trace at all.
#[derive(Debug, Clone, PartialEq, Eq)]
enum InitializeKind {
    /// First contact: no session id presented.
    Fresh,
    /// Presented a session id we still hold — the same connection continuing.
    Resumed,
    /// Presented a session id we no longer hold. A new one was minted.
    Reconnected { presented: String },
}

impl InitializeKind {
    fn as_str(&self) -> &'static str {
        match self {
            InitializeKind::Fresh => "fresh",
            InitializeKind::Resumed => "resumed",
            InitializeKind::Reconnected { .. } => "reconnected",
        }
    }
}

/// Build server instructions for the MCP initialize response.
/// Tells the connecting agent what tools are available, which repos are managed,
/// and what sessions are currently active so it can orient itself.
fn build_mcp_instructions(state: &Arc<AppState>, client_name: Option<&str>) -> String {
    let collapse_tools = state.config.read().collapse_tools;
    build_mcp_instructions_for_mode(state, client_name, collapse_tools)
}

fn build_mcp_instructions_for_mode(
    state: &Arc<AppState>,
    client_name: Option<&str>,
    collapse_tools: bool,
) -> String {
    let ver = env!("CARGO_PKG_VERSION");
    let mut out = String::with_capacity(2048);

    // ── Identity ──────────────────────────────────────────────────────
    out.push_str(&format!("# FastAF v{ver}\n\n"));
    out.push_str(
        "You are connected to FastAF, a terminal session orchestrator for AI coding agents.\n\n",
    );

    // ── TUIC protocol (mandatory line markers) ─────────────────────────
    // Wire-level tokens parsed by the host TUI. Concision rules do NOT apply —
    // dropping a marker breaks the UI (stale tab title, missing suggestion bar).
    let (show_intent, show_suggest) = resolve_marker_flags(state, client_name);
    out.push_str("## TUIC Protocol — Required Output Markers\n\n");
    out.push_str("Protocol tokens (not prose). Emit even under concision/no-preamble rules from user configs — dropping breaks UI.\n\n");
    out.push_str(&format!(
        "- `ack` — exactly once per MCP connection or reconnect, the first assistant message MUST start: `FastAF v{ver} is connected.` Never repeat it on each conversational turn.\n"
    ));
    if show_intent {
        out.push_str("- `intent: <desc> (<title>)` at the start of every user task and on each material work-phase change. Describe the work currently in progress in present tense; `<title>` ≤3 words, spaces not hyphens.\n");
    }
    if show_suggest {
        out.push_str("- `suggest:` — after task done: `suggest: [ A | B | C ]` — wrap the WHOLE list in one `[ … ]`, EXACTLY 3 items separated by `|`, each item ≤40 chars. The brackets bound the token (parsed even if it wraps); never emit 4+ items.\n");
    }
    out.push('\n');

    // ── Tools ────────────────────────────────────────────────────────
    if collapse_tools {
        // Speakeasy mode: discovery flow and domain context live in the
        // meta-tool descriptions, NOT here, so they don't compete with
        // protocol markers for the model's attention at turn 1.
        out.push_str("## Tools\n\n");
        out.push_str("Tool discovery and invocation via `search_tools` / `get_tool_schema` / `call_tool` — see their descriptions for usage.\n\n");
        out.push_str("**Worktrees:** never `git worktree add/remove` — always use `repo action=worktree_create` / `worktree_remove` so TUIC tracks the worktree and can spawn a PTY inside.\n\n");
    } else {
        out.push_str("## Tools\n\n");
        out.push_str("- `session` (PTY panes, tmux-equivalent): list, create, submit, input, output, status, wait, resize, close, kill, pause, resume, process_stats\n");
        out.push_str("- `agent` (AI peers + messaging): spawn, wait, detect, stats, metrics, register, list_peers, send, inbox\n");
        out.push_str("- `task` (poll a spawn that outlives a wait): get, cancel\n");
        out.push_str("- `repo` (repos, PRs, worktrees): list, active, prs, status, worktree_list, worktree_create, worktree_remove\n");
        out.push_str("- `ui` (tabs, toasts, confirm dialogs): tab, toast, confirm\n");
        out.push_str("- `plugin_dev_guide`: plugin authoring reference\n\n");
        out.push_str("**Worktrees:** always `repo action=worktree_create`/`worktree_remove` — never `git worktree add/remove` (TUIC must track them to spawn a PTY inside).\n\n");
        out.push_str("**UI feedback:** `ui action=toast` on task done/blocking error · `ui action=confirm` BEFORE destructive ops (rm -rf, git reset --hard, force push, DROP TABLE) · `ui action=tab` for structured output >20 lines · `ui action=screenshot id=<panel-id>` to see rendered output (Read the returned path).\n\n");
    }

    if collapse_tools {
        out.push_str("**Submit:** `call_tool tool_name=session arguments={action:submit,session_id,input}` once; never split text/Enter; never poll.\n\n");
    } else {
        out.push_str("**Submit:** `session action=submit session_id=<id> input=<text>` once; never split text/Enter; never poll.\n\n");
    }

    // ── Workflow (phase-grouped) ──────────────────────────────────────
    // 4 bullets by phase instead of 7 tool-by-tool steps. Details live in each
    // tool's description (JSON schema); this section gives the mental model.
    // Suppressed in collapse mode — concrete invocations go through call_tool.
    if !collapse_tools {
        out.push_str("## Workflow\n\n");
        out.push_str("- **Discover:** `repo action=list|prs|active` · `agent action=detect`.\n");
        out.push_str("- **Spawn:** `session action=create` (shell) · `agent action=spawn` (AI) · `repo action=worktree_create` (isolated). `agent_type` resolves run config names first (case-insensitive), then agent binary names.\n");
        out.push_str("- **Observe:** `session action=status|output` · `agent action=inbox` · `task action=get` for work longer than the 300s wait cap.\n");
        out.push_str(
            "- **Coordinate:** `agent action=register/send/inbox` for peer messaging.\n\n",
        );
    }

    // ── Multi-agent work — critical pre-spawn knowledge only ─────────
    // Full operational workflow (monitor semantics, cleanup, examples) lives
    // in the agent(register) response. Here we keep only the three anchors
    // a fresh agent needs BEFORE its first tool call:
    //   1. how to obtain identity ($TUIC_SESSION env → UUID)
    //   2. golden path (register → spawn → inbox, never stream peer output)
    //   3. when worktrees apply (isolated branches)
    let peer_count = state.peer_agents.len();
    let is_claude_code = detect_claude_code_client(client_name);
    out.push_str("## Multi-Agent Work\n\n");
    if peer_count > 0 {
        out.push_str(&format!(
            "**{peer_count}** peer agent(s) connected. There is no separate `swarm` action; use the `agent` and `session` primitives below.\n\n"
        ));
    } else {
        out.push_str("There is no separate `swarm` action; multi-agent orchestration uses `agent` and `session` primitives.\n\n");
    }
    out.push_str("- **Identity:** managed PTYs auto-bind from `$TUIC_SESSION`. Headerless external callers use `agent action=register` without a UUID to receive an MCP-scoped identity; pass `tuic_session` only to reclaim an explicit stable UUID.\n");
    out.push_str("- **Orchestrator role:** declare it with `agent action=register orchestrator=true`; use `false` to remove it. Spawn never infers the role. `mail_wake=managed_pty_lifecycle` is server-derived; external/headerless peers remain wait/inbox-only.\n");
    out.push_str("- **Same repo:** `agent action=spawn` peers; wait with `agent action=wait`, then read `agent action=inbox`. Lifecycle notifications carry state only; workers must report results with `agent action=send`. Use `session output` only as an anomaly fallback when a child failed to send its result.\n");
    out.push_str("- **Isolated branches:** `repo action=worktree_create spawn_session=true`.\n");
    if is_claude_code {
        out.push_str("- **Single isolated task (CC only):** `repo action=worktree_create` then delegate via returned `cc_agent_hint` (absolute paths). ONLY valid use of native Agent/Task.\n");
    }
    out.push('\n');

    // ── Dynamic: repos ──────────────────────────────────────────────
    let repo_settings = crate::config::load_repo_settings();
    if !repo_settings.repos.is_empty() {
        out.push_str("## Repos\n\n");
        let mut repos: Vec<_> = repo_settings.repos.iter().collect();
        repos.sort_by_key(|(path, _)| path.to_string());
        for (path, entry) in &repos {
            let name = if entry.display_name.is_empty() {
                path.rsplit('/').next().unwrap_or(path)
            } else {
                &entry.display_name
            };
            out.push_str(&format!("- **{name}** `{path}`\n"));
        }
        out.push('\n');
    }

    // ── Dynamic: sessions ───────────────────────────────────────────
    let sessions: Vec<_> = state
        .sessions
        .iter()
        .map(|entry| {
            let id = entry.key().clone();
            let session = entry.value().lock();
            (
                id,
                session.cwd.clone(),
                session.worktree.as_ref().and_then(|w| w.branch.clone()),
            )
        })
        .collect();

    if !sessions.is_empty() {
        out.push_str("## Sessions\n\n");
        for (id, cwd, branch) in &sessions {
            let short_id = &id[..8.min(id.len())];
            let cwd = cwd.as_deref().unwrap_or("—");
            let branch = branch.as_deref().unwrap_or("—");
            out.push_str(&format!("- `{short_id}` {cwd} ({branch})\n"));
        }
        out.push('\n');
    }

    out
}

/// Validate a repo path for MCP tool calls, returning a JSON error value on failure.
fn validate_mcp_repo_path(path: &str) -> Result<(), serde_json::Value> {
    super::validate_path_string(path).map_err(|msg| serde_json::json!({"error": msg}))
}

const SESSION_ACTIONS: &str = "list, create, submit, input, output, resize, close, kill, pause, resume, status, process_stats, wait";
const AGENT_ACTIONS: &str =
    "spawn, detect, stats, metrics, register, list_peers, send, inbox, wait";
const REPO_ACTIONS: &str =
    "list, active, prs, status, worktree_list, worktree_create, worktree_remove";
const UI_ACTIONS: &str = "tab, toast, confirm, screenshot";
const CONFIG_ACTIONS: &str = "get, save, list_ai_prompts, load_ai_prompt, save_ai_prompt, list_prompts, load_prompt, save_prompt";
const DEBUG_ACTIONS: &str = "agent_detection, logs, sessions, invoke_js, help";

// Legacy action constants — still referenced by handlers until dispatch refactor (story 1091).
// Remove these when handle_mcp_tool_call dispatch is updated.
const LEGACY_AGENT_ACTIONS: &str = "detect, spawn, stats, metrics";
const LEGACY_GITHUB_ACTIONS: &str = "prs, status, issues, close_issue, reopen_issue";
const LEGACY_WORKTREE_ACTIONS: &str = "list, create, remove";
const LEGACY_WORKSPACE_ACTIONS: &str = "list, active";
const LEGACY_UI_ACTIONS: &str = "tab";
const LEGACY_NOTIFY_ACTIONS: &str = "toast, confirm";
const LEGACY_MESSAGING_ACTIONS: &str = "register, list_peers, send, inbox";
const LEGACY_DEBUG_ACTIONS: &str = "agent_detection, logs, sessions, invoke_js";
const LEGACY_TASK_ACTIONS: &str = "get, cancel";

/// Full MCP tool definitions — 8 base native tools + all `ai_terminal_*` tools.
///
/// This returns the unfiltered schema list. Public listing/search paths MUST
/// route through [`filtered_native_tools`] to honour `disabled_native_tools`
/// and `ai_terminal_mcp_enabled`. Leaking the raw list to external clients
/// exposes tool metadata for gated tools.
fn native_tool_definitions() -> serde_json::Value {
    let mut defs = serde_json::json!([
        {
            "name": "session",
            "description": "PTY multiplexer (replaces tmux). Create terminals, send input (send-keys), read output (capture-pane), manage lifecycle.\n\nActions:\n- list: All active sessions and states in one call. Use for every global overview; never fan out per-session status calls. Returns display_name (assigned name), alias (independent repo-derived short address), is_caller, shell_state (PTY activity), and agent_state (starting|working|awaiting_input|idle|completed; completed requires suggest marker). Absent optional fields are omitted, not null.\n- create: New PTY. Returns {session_id}. Optional: cwd, shell, rows, cols.\n- submit: Submit one non-empty command to a confirmed-idle managed agent and wait internally for a bounded receipt. Use one call; never split text and Enter; never poll after it. Returns submission_id, submitted, write_state, acknowledged, retry_safe, turn_epoch, composer_state (tracked InputLineBuffer, not application state), and acknowledgement or a precise reason. Acknowledgement means child terminal movement after Enter, not semantic application acceptance. Never queues; partial composers, dialogs, busy agents, and older queued commands reject before writing.\n- input: Raw text/key compatibility surface. Send text and/or special_key; ok confirms PTY write only.\n- output: Read terminal output. Returns {data, cursor, scrollback_lines, oldest_offset, exited, exit_code}. Use as an anomaly fallback for a child that failed to send its result, not as the normal orchestration channel. scrollback_lines = total lines in buffer (up to 10000); oldest_offset = first available line number. Patterns: (1) Snapshot: omit since_cursor, default limit=50 gives last 50 lines. (2) Delta read: since_cursor=<previous cursor> returns only new lines. (3) Navigate backwards: from_line=oldest_offset reads from the beginning of the buffer. (4) Arbitrary window: from_line=N, limit=50 reads any 50-line slice.\n- status: Session state; absent optional fields are omitted.\n- wait: Block (server-side) until session_id is idle or exited (until=idle|exited), or timeout_ms elapses. One cheap call instead of a status polling loop. Returns {met, timed_out, shell_state?, exit_code?}.\n- resize: Change PTY dimensions.\n- close: Graceful shutdown (Ctrl+C, waits).\n- kill: Force SIGKILL (use when close fails).\n- pause: Pause output buffering. resume: Resume.\n- process_stats: CPU% and RSS memory for TUIC and all child process trees. Returns {processes: [{session_id, name, pid, rss_kb, cpu_pct}]}. Use to diagnose high CPU/memory.",
            "inputSchema": { "type": "object", "properties": {
                "action": { "type": "string", "description": "One of: list, create, submit, input, output, status, wait, resize, close, kill, pause, resume, process_stats" },
                "session_id": { "type": "string", "description": "Session ID (required for submit, input, output, resize, close, pause, resume, wait)" },
                "until": { "type": "string", "description": "Wait target: 'idle' or 'exited' (action=wait, default idle)" },
                "timeout_ms": { "type": "integer", "minimum": 1, "maximum": 300000, "description": "action=submit: acknowledgement wait, clamped 250-10000ms, default 3000. action=wait: max wait, default 60000; values at or above 300000 run as 295000." },
                "input": { "type": "string", "description": "Non-empty command (action=submit) or raw text (action=input)" },
                "pty_description": { "type": ["string", "null"], "description": "Short orchestrator-supplied description shown above the PTY (action=submit or input)" },
                "special_key": { "type": "string", "description": "Special key: enter, tab, ctrl+c, ctrl+d, ctrl+z, ctrl+l, ctrl+a, ctrl+e, ctrl+k, ctrl+u, ctrl+w, ctrl+r, up, down, left, right, home, end, backspace, delete, escape (action=input)" },
                "rows": { "type": "integer", "description": "Terminal rows (action=create or resize)" },
                "cols": { "type": "integer", "description": "Terminal cols (action=create or resize)" },
                "shell": { "type": "string", "description": "Shell binary path (action=create)" },
                "cwd": { "type": "string", "description": "Working directory (action=create)" },
                "limit": { "type": "integer", "description": "Max lines to return (default 50). Use 50-100 for snapshots; delta reads (since_cursor) are already bounded by new content (action=output)" },
                "from_line": { "type": "integer", "description": "Absolute line number to start reading from. Use oldest_offset from a previous response to read from the beginning of the buffer. Omit to read the tail (action=output)" },
                "format": { "type": "string", "description": "Output format: ANSI escape codes are stripped by default; pass 'raw' to preserve them (action=output)" },
                "since_cursor": { "type": "integer", "description": "Cursor from a previous output response — returns only new lines since this position. Most token-efficient for polling. Omit for snapshot (action=output)" }
            }, "required": ["action"] }
        },
        {
            "name": "agent",
            "description": "AI agent orchestration. There is no separate swarm action: use these agent/session primitives to spawn and coordinate managed peers.\n\nOrchestration in 5 lines:\n1. Managed PTYs auto-bind from $TUIC_SESSION. A headerless external caller calls register without tuic_session to receive an MCP-scoped UUID, or supplies an explicit stable UUID to reclaim it.\n2. Spawn a named peer: spawn name=worker prompt=<task> [agent_type=codex|gemini|...] → {session_id, name}.\n3. Wait for it: agent action=wait (new mail; omit since, the cursor is kept server-side) or session action=wait session_id=<id> until=idle|exited. Cheap blocking call — do NOT poll in a loop. Both cap at 300s: for work that runs longer, or across a reconnect, poll the spawn's task_id with task action=get instead — the outcome is recorded even with nobody waiting.\n4. Talk to it: send to=<peer> message=<text>. Ordinary managed agents keep direct delivery. A registered orchestrator keeps peer payloads in its inbox; only idle/completed lifecycle may submit a generic `agent action=inbox` wake.\n5. Lifecycle notifications carry state only. Every worker must report task output or blockers with send; use session output only if a child anomalously failed to send.\n\nActions:\n- spawn: Launch agent in new PTY (localhost only). Optional name is assigned before prompt delivery. Returns {session_id, name, task_id, poll_interval_ms, monitor_with, peer_monitor_with?}.\n- wait: Block until new inbox mail. Omit `since` — the server resumes from your last read position; pass it only to override (since=0 replays everything). Success inlines every retained fresh message (up to the 100-message inbox capacity) in chronological order. Every response carries next_since, timeout included. An active wait suppresses terminal wake.\n- detect: Installed agents [{name, path, version}].\n- stats: {active_sessions, max_sessions, available_slots}.\n- metrics: Cumulative {total_spawned, total_failed, bytes_emitted, pauses_triggered}.\n- register: Bind an external/headerless caller, or rename/set the project of an auto-bound managed peer. tuic_session is optional; omission generates a stable identity for this MCP connection. Reconnecting under a NEW uuid? Pass `replaces=<old_uuid>` or its inbox is stranded — the response reports superseded_identity, mail_migrated, and mail_stranded + identity_warning when the old identity still owns a live PTY (its mail is left alone). Check `terminal` in the response: false means nothing can be typed into you and no message can wake you — you must consume your own inbox with wait/inbox.\n- list_peers: List peers. Optional: project filter. Absent project is omitted.\n- send: Message a peer (requires to, message). Returns `delivered`: false means no active wait or safe wake surfaced it, so it remains inbox-only. `delivery_path` is the single source of truth for the route: waiter, generic/coalesced orchestrator wake, sse channel, terminal, or inbox-only. Adds recipient_state={shell_state?,agent_state?} only for a real managed PTY.\n- inbox: Read messages. Returns next_since. Optional: limit, since (omit to resume from the server-side cursor).",
            "inputSchema": { "type": "object", "properties": {
                "action": { "type": "string", "description": "One of: spawn, wait, detect, stats, metrics, register, list_peers, send, inbox" },
                "timeout_ms": { "type": "integer", "minimum": 1, "maximum": 300000, "description": "Max wait in ms (action=wait; default 60000). Values at or above 300000 run as 295000 so the reply beats a 300s client-side tool-call deadline. On timeout returns {timed_out:true}." },
                "prompt": { "type": "string", "description": "Task prompt for the agent (action=spawn)" },
                "pty_description": { "type": ["string", "null"], "description": "Short description of the PTY task shown above the terminal (action=spawn)" },
                "cwd": { "type": "string", "description": "Working directory (action=spawn)" },
                "model": { "type": "string", "description": "Structured model flag; preserved when args is also set (action=spawn)" },
                "print_mode": { "type": "boolean", "description": "false (default): visible TUI tab, observable via agent(inbox). true: headless, no tab. (action=spawn)" },
                "output_format": { "type": "string", "description": "Output format, e.g. 'json' (action=spawn)" },
                "agent_type": { "type": "string", "description": "Agent type OR run config name. Resolved as: (1) run config name match across enabled agents, (2) agent binary name (claude, codex, aider, goose, gemini, ...). Case-insensitive. (action=spawn)" },
                "binary_path": { "type": "string", "description": "Override agent binary path (action=spawn)" },
                "args": { "type": "array", "items": { "type": "string" }, "description": "Additional CLI args; composed with structured flags and agent defaults (action=spawn)" },
                "rows": { "type": "integer", "description": "Terminal rows (action=spawn)" },
                "cols": { "type": "integer", "description": "Terminal cols (action=spawn)" },
                "tuic_session": { "type": "string", "description": "Optional explicit stable UUID (action=register). Managed PTYs normally auto-bind; a headerless caller may omit this to receive an MCP-scoped UUID." },
                "replaces": { "type": "string", "description": "Prior tuic_session this registration supersedes (action=register). Required to inherit the old identity's inbox when reconnecting under a new UUID — there is no implicit link across protocol sessions, and identity is never guessed. Ignored when that identity still owns a live PTY; the response then reports mail_stranded." },
                "name": { "type": "string", "description": "Non-empty peer/session display name (action=spawn optional; action=register optional; default: 'agent')" },
                "project": { "type": "string", "description": "Git repo root path (action=register optional, action=list_peers filter)" },
                "orchestrator": { "type": "boolean", "description": "Explicitly enable or remove orchestrator inbox-only routing (action=register). Omission preserves the current role; spawning a child never infers it." },
                "to": { "type": "string", "description": "Recipient tuic_session UUID (action=send, required)" },
                "message": { "type": "string", "description": "Message content, max 64KB (action=send, required)" },
                "since": { "type": "integer", "description": "Logical unix-millis cursor (action=inbox|wait). OMIT IT: the server remembers your last read position and resumes from there. Pass it only to override — since=0 deliberately replays the whole inbox. Every wait/inbox response carries next_since, including on timeout" }
            }, "required": ["action"] }
        },
        {
            "name": "task",
            "description": "Poll a long-running task handle without blocking. `agent action=spawn` returns a task_id; use it here instead of holding a wait open, which is capped at 300s and loses the outcome if the connection drops.\n\nThe outcome is recorded when the agent exits whether or not anyone was listening, so a reconnecting orchestrator can still collect it (for up to 24h).\n\nActions:\n- get: Current state. Returns {task_id, status, status_message?, result?, error_detail?, poll_interval_ms}. status is working|input_required|completed|failed|cancelled; the last three are final and never change again. A failed task reports why in error_detail, NOT in error — a top-level `error` always means the call itself failed. Poll no faster than poll_interval_ms.\n- cancel: Mark the task cancelled. Does NOT kill the agent — use session action=kill for that. A cancel is final: the agent's later exit cannot overwrite it.",
            "inputSchema": { "type": "object", "properties": {
                "action": { "type": "string", "description": "One of: get, cancel" },
                "task_id": { "type": "string", "description": "Task handle returned by agent action=spawn (required)" }
            }, "required": ["action", "task_id"] }
        },
        {
            "name": "repo",
            "description": "Repository and version control. Query workspace repos, GitHub PR/CI status, manage git worktrees.\n\nActions:\n- list: Open repos with branch, dirty status, worktrees.\n- active: Focused repo path, branch, group.\n- prs: Open PRs with CI, merge readiness, reviews. Requires path.\n- status: Cross-repo {path, branch, ahead, behind, open_prs, failing_ci}.\n- worktree_list: Worktrees for a repo. Requires path.\n- worktree_create: Create worktree. Requires path. Optional: branch, base_ref, spawn_session.\n- worktree_remove: Remove worktree. Requires path, branch.",
            "inputSchema": { "type": "object", "properties": {
                "action": { "type": "string", "description": "One of: list, active, prs, status, worktree_list, worktree_create, worktree_remove" },
                "path": { "type": "string", "description": "Absolute path to git repository (required for prs, worktree_list, worktree_create, worktree_remove)" },
                "branch": { "type": "string", "description": "Branch name (action=worktree_create optional, action=worktree_remove required)" },
                "base_ref": { "type": "string", "description": "Base ref to branch from, default HEAD (action=worktree_create)" },
                "spawn_session": { "type": "boolean", "description": "Auto-create a PTY session in the worktree (action=worktree_create, default false)" }
            }, "required": ["action"] }
        },
        {
            "name": "ui",
            "description": "Control TUIC UI. Actions:\n- tab: open/update panel tab. Requires id, title, + html OR url.\n- toast: non-blocking notification. Requires title. Optional: message, level (info/warn/error), sound.\n- confirm: blocking dialog, shown on every client (desktop, browser, mobile PWA) plus a mobile push — the first answer wins. Returns {confirmed}, plus {reason} when it expired unanswered after 300s (treat that as a refusal, not a yes). Requires title.\n- screenshot: capture a panel as WebP. Requires id. Returns {path}. Read the path to view.\n\nURL schemes for tab:\n- http(s): loaded in sandboxed iframe.\n- file:///path: read via IPC and rendered as inline HTML (sandbox blocks direct file:// access).\n- tuic://edit/<path>?line=N: native code editor (no iframe). Prefix absolute paths with `//` (tuic://edit//Users/x/a.rs). Relative = active repo.\n- tuic://open/<path>: native markdown/preview tab.\n\nCustom schemes (vscode://) do NOT work in iframes.\n\nUse:\n- toast for done/error/long-job end; error=failure, warn=recoverable. Skip for micro-steps.\n- toast with sound=attention when you are working unattended and are BLOCKED on the user (question, approval, ambiguous requirement). It is the only sound that carries across a room; do not spend it on progress updates.\n- confirm BEFORE destructive ops (rm -rf, git reset --hard, force-push, DROP). Only proceed if confirmed.\n- tab http(s) for dashboards, reports, >20-line structured output.\n- tab tuic://edit to point user at source file+line (review, bug discussion) — beats pasting snippets.\n- screenshot to visually verify rendered HTML content in a panel you created.",
            "inputSchema": { "type": "object", "properties": {
                "action": { "type": "string", "description": "One of: tab, toast, confirm, screenshot" },
                "id": { "type": "string", "description": "Stable identifier for dedup — same id reuses existing tab (action=tab, required)" },
                "title": { "type": "string", "description": "Tab or notification title (action=tab/toast/confirm, required)" },
                "html": { "type": "string", "description": "Inline HTML content to render in sandboxed iframe (action=tab, mutually exclusive with url)" },
                "url": { "type": "string", "description": "Tab URL (action=tab, xor html). http(s) → iframe. file:///path → read and inline. tuic://edit/<path>?line=N → native editor. tuic://open/<path> → markdown tab. Absolute paths need `//` prefix." },
                "pinned": { "type": "boolean", "description": "Pin tab across all branches (default false)" },
                "focus": { "type": "boolean", "description": "Switch to this tab after open/update (action=tab, default true). Pass false to update silently without stealing focus." },
                "message": { "type": "string", "description": "Optional body text (action=toast/confirm)" },
                "level": { "type": "string", "description": "Toast level: info, warn, error (default: info)" },
                "sound": { "description": "Audible signal for action=toast (default: none). true = the tone matching `level`. Or name one: question, completion, error, warning, info, attention. `attention` is a triangular G4→G4→E5 callback, unlike any other sound in the app — use it when you are running unattended and need the user back (a blocking question, a decision only they can make). Plays through the user's notification settings, so volume, output device and mutes are respected.", "anyOf": [{ "type": "boolean" }, { "type": "string", "enum": ["question", "completion", "error", "warning", "info", "attention"] }] }
            }, "required": ["action"] }
        },
        {
            "name": "plugin_dev_guide",
            "description": "Returns comprehensive plugin authoring reference: manifest format, PluginHost API (all 4 tiers), structured event types, and working examples. Call before writing any plugin code.",
            "inputSchema": { "type": "object", "properties": {}, "required": [] }
        },
        {
            "name": "config",
            "description": "Read or write app configuration.\n\nActions (pass as 'action' parameter):\n- get: Returns app config (shell, font, theme, etc.). Password hash is stripped.\n- save: Persists configuration. Requires config object. Partial updates OK.\n- list_ai_prompts: Lists AI services with custom/default status.\n- load_ai_prompt: Returns prompt for a service (requires 'service' param). Includes prompt, default_prompt, is_custom.\n- save_ai_prompt: Sets custom prompt for a service (requires 'service' + 'prompt' params, null/empty resets to default). Localhost only.\n- list_prompts: Lists saved smart prompts (id, label, pinned — no text).\n- load_prompt: Returns full prompt entry by id (requires 'id' param).\n- save_prompt: Upserts a prompt by id (requires 'id', 'label', 'text'; optional 'pinned'). Localhost only.",
            "inputSchema": { "type": "object", "properties": {
                "action": { "type": "string", "description": "One of: get, save, list_ai_prompts, load_ai_prompt, save_ai_prompt, list_prompts, load_prompt, save_prompt" },
                "config": { "type": "object", "description": "Config fields to save (action=save)" },
                "service": { "type": "string", "description": "AI service name (action=load_ai_prompt, save_ai_prompt). Currently: diff_triage" },
                "prompt": { "type": "string", "description": "Custom prompt text (action=save_ai_prompt). Null or empty resets to default." },
                "id": { "type": "string", "description": "Prompt id (action=load_prompt, save_prompt)" },
                "label": { "type": "string", "description": "Prompt label (action=save_prompt)" },
                "text": { "type": "string", "description": "Prompt text (action=save_prompt)" },
                "pinned": { "type": "boolean", "description": "Pin prompt (action=save_prompt, optional)" }
            }, "required": ["action"] }
        },
        {
            "name": "debug",
            "description": "Diagnostics for FastAF internals. action=help returns the full usage guide.",
            "inputSchema": { "type": "object", "properties": {
                "action": { "type": "string", "description": "One of: agent_detection, logs, sessions, invoke_js, help" },
                "session_id": { "type": "string", "description": "PTY session UUID (action=agent_detection, optional — omit for all)" },
                "level": { "type": "string", "description": "Log level filter: debug, info, warn, error (action=logs)" },
                "source": { "type": "string", "description": "Log source filter (action=logs)" },
                "script": { "type": "string", "description": "JavaScript to execute in the WebView (action=invoke_js). The ONLY global is window.__TUIC__ — call action=help for the full API list. Example: return window.__TUIC__.terminals()" },
                "limit": { "type": "integer", "description": "Max entries (action=logs, default 50)" }
            }, "required": ["action"] }
        }
    ]);

    // Append ai_terminal_* tools (external MCP exposure of agent terminal tools).
    // Callers filter these out when `config.ai_terminal_mcp_enabled` is false.
    if let Some(arr) = defs.as_array_mut() {
        arr.extend(super::ai_terminal::tool_definitions());
    }

    // Guard invariant: native tool names must never contain "__" — that prefix
    // is the routing discriminator for upstream proxy tools.
    #[cfg(debug_assertions)]
    if let Some(arr) = defs.as_array() {
        for tool in arr {
            let name = tool["name"].as_str().unwrap_or("");
            debug_assert!(
                !name.contains("__"),
                "Native tool name '{name}' contains '__' — reserved for upstream namespace separator"
            );
        }
    }

    defs
}

/// The three meta-tool names used when `collapse_tools: true`.
/// Exposed for handler dispatch and tests.
pub(crate) const META_TOOL_NAMES: [&str; 3] = ["search_tools", "get_tool_schema", "call_tool"];

/// Speakeasy-style meta-tool definitions. When `collapse_tools: true`,
/// `merged_tool_definitions()` returns exactly these three tools instead of
/// the full native + upstream list. The model uses `search_tools` to discover
/// relevant tools by natural language, `get_tool_schema` to fetch the full
/// input schema for one, and `call_tool` to execute it.
///
/// Domain context and discovery flow are embedded in the tool descriptions
/// (not in server instructions) so they don't compete with protocol markers
/// for the model's attention at turn 1.
fn meta_tool_definitions(state: &Arc<AppState>) -> serde_json::Value {
    let upstream_count = state.mcp_upstream_registry.aggregated_tools().len();
    let upstream_suffix = if upstream_count > 0 {
        format!(", plus {upstream_count} upstream tool(s) from connected MCP servers")
    } else {
        String::new()
    };

    let search_desc = format!(
        "Find relevant FastAF tools by natural-language query. Returns a BM25-ranked \
         list of tool names + one-line summaries. Use this before calling any tool to discover \
         what is available, then call `get_tool_schema` for the full input schema of the tool \
         you want to use.\n\n\
         Domains available: terminal pane sessions (tmux replacement), AI agent orchestration + \
         messaging, repos/GitHub PRs/worktrees, UI tabs + notifications, plugin authoring \
         reference, app config, diagnostics{upstream_suffix}."
    );

    serde_json::json!([
        {
            "name": "search_tools",
            "description": search_desc,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural-language query describing what you want to do (e.g. 'manage terminal sessions', 'github PR status', 'cross-repo knowledge search')" },
                    "limit": { "type": "integer", "description": "Maximum number of results, default 10" }
                },
                "required": ["query"]
            }
        },
        {
            "name": "get_tool_schema",
            "description": "Return the full MCP tool definition (name, description, inputSchema) for a single tool by exact name. Call this after `search_tools` to get the arguments needed to invoke a tool.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tool_name": { "type": "string", "description": "Exact tool name as returned by search_tools" }
                },
                "required": ["tool_name"]
            }
        },
        {
            "name": "call_tool",
            "description": "Invoke a FastAF tool by name with arguments. Dispatches to native tools or upstream-proxied tools (`{upstream}__{tool}`). The arguments object must match the tool's inputSchema — fetch it via `get_tool_schema` first.\n\nFlow: `search_tools(query=\"…\")` → pick a name → `get_tool_schema(tool_name=…)` → `call_tool(tool_name=…, arguments={…})`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tool_name": { "type": "string", "description": "Exact tool name" },
                    "arguments": { "type": "object", "description": "Tool-specific arguments matching the inputSchema returned by get_tool_schema" }
                },
                "required": ["tool_name", "arguments"]
            }
        }
    ])
}

/// Returns native tools merged with upstream proxy tools (namespaced as `{upstream}__`).
///
/// When `config.collapse_tools: true`, returns exactly 3 meta-tools
/// (`search_tools`, `get_tool_schema`, `call_tool`) — the Speakeasy pattern for
/// massive context reduction.
///
/// Otherwise (default), returns native tools filtered by `disabled_native_tools`,
/// merged with upstream proxy tools. Upstream tools are omitted when no
/// upstreams are Ready.
/// Resolve an MCP session's repo_path → per-repo `mcp_upstreams` allowlist.
///
/// Returns `None` when the session has no repo_path or the repo has no
/// custom upstream allowlist (meaning: inherit all globally-enabled upstreams).
fn resolve_allowed_upstreams(
    state: &Arc<AppState>,
    mcp_session_id: Option<&str>,
) -> Option<Vec<String>> {
    let repo_path = mcp_session_id
        .and_then(|sid| state.mcp_sessions.get(sid))
        .and_then(|meta| meta.repo_path.clone())?;
    let repo_settings = crate::config::load_repo_settings();
    repo_settings
        .repos
        .get(&repo_path)
        .and_then(|entry| entry.mcp_upstreams.clone())
}

/// Apply the two config-driven filters (`disabled_native_tools`,
/// `ai_terminal_mcp_enabled`) to the full native tool list. Centralised so
/// every listing/search path uses the same rules — adding a future config
/// flag means editing one place instead of chasing duplicated closures.
fn filtered_native_tools(state: &Arc<AppState>) -> Vec<serde_json::Value> {
    let (disabled, ai_terminal_mcp_enabled) = {
        let cfg = state.config.read();
        let disabled: std::collections::HashSet<String> =
            cfg.disabled_native_tools.iter().cloned().collect();
        (disabled, cfg.ai_terminal_mcp_enabled)
    };
    native_tool_definitions()
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|t| {
            let name = t["name"].as_str().unwrap_or("");
            if !ai_terminal_mcp_enabled && super::ai_terminal::is_ai_terminal_tool(name) {
                return false;
            }
            !disabled.contains(name)
        })
        .collect()
}

fn merged_tool_definitions(
    state: &Arc<AppState>,
    mcp_session_id: Option<&str>,
) -> serde_json::Value {
    let force_meta_tools = mcp_session_id
        .and_then(|sid| state.mcp_sessions.get(sid))
        .is_some_and(|meta| meta.requires_meta_tools);
    merged_tool_definitions_for_mode(state, mcp_session_id, force_meta_tools)
}

fn merged_tool_definitions_for_mode(
    state: &Arc<AppState>,
    mcp_session_id: Option<&str>,
    force_meta_tools: bool,
) -> serde_json::Value {
    if force_meta_tools || state.config.read().collapse_tools {
        return meta_tool_definitions(state);
    }

    let mut tools = filtered_native_tools(state);
    let allowed = resolve_allowed_upstreams(state, mcp_session_id);
    let upstream_tools = state
        .mcp_upstream_registry
        .aggregated_tools_for_repo(allowed.as_deref());
    tools.extend(upstream_tools);

    serde_json::Value::Array(tools)
}

/// Translate special key names to terminal escape sequences
fn translate_special_key(key: &str) -> Option<&'static str> {
    match key {
        "enter" | "return" => Some("\r"),
        "tab" => Some("\t"),
        "escape" | "esc" => Some("\x1b"),
        "backspace" => Some("\x7f"),
        "delete" => Some("\x1b[3~"),
        "up" => Some("\x1b[A"),
        "down" => Some("\x1b[B"),
        "right" => Some("\x1b[C"),
        "left" => Some("\x1b[D"),
        "home" => Some("\x1b[H"),
        "end" => Some("\x1b[F"),
        "ctrl+c" => Some("\x03"),
        "ctrl+d" => Some("\x04"),
        "ctrl+z" => Some("\x1a"),
        "ctrl+l" => Some("\x0c"),
        "ctrl+a" => Some("\x01"),
        "ctrl+e" => Some("\x05"),
        "ctrl+k" => Some("\x0b"),
        "ctrl+u" => Some("\x15"),
        "ctrl+w" => Some("\x17"),
        "ctrl+r" => Some("\x12"),
        "ctrl+p" => Some("\x10"),
        "ctrl+n" => Some("\x0e"),
        _ => None,
    }
}

fn uses_agent_command_injection(agent_type: Option<&str>, key_seq: Option<&str>) -> bool {
    agent_type.is_some_and(crate::agent::prompt_prefill_only) && key_seq == Some("\r")
}

/// Extract action from args, returning a guidance error if missing
fn require_action<'a>(
    args: &'a serde_json::Value,
    tool: &str,
    available: &str,
) -> Result<&'a str, serde_json::Value> {
    args["action"]
        .as_str()
        .ok_or_else(|| serde_json::json!({"error": format!("Missing 'action'. Available actions for '{}': {}", tool, available)}))
}

/// Extract session_id from args with guidance error
fn require_session_id<'a>(
    args: &'a serde_json::Value,
    action: &str,
) -> Result<&'a str, serde_json::Value> {
    args["session_id"]
        .as_str()
        .ok_or_else(|| serde_json::json!({"error": format!("Action '{}' requires 'session_id'. Get valid IDs with session action='list'", action)}))
}

fn require_string<'a>(
    args: &'a serde_json::Value,
    field: &str,
) -> Result<&'a str, serde_json::Value> {
    args[field].as_str().ok_or_else(
        || serde_json::json!({"error": format!("Missing required parameter '{field}'")}),
    )
}

#[derive(Debug, PartialEq)]
enum PtyDescriptionUpdate {
    Unchanged,
    Set(Option<String>),
}

const INFERRED_PTY_DESCRIPTION_MAX_CHARS: usize = 160;

/// Parse the optional PTY description field. Omitted means unchanged; null or
/// an empty/whitespace-only string clears the current description.
fn parse_pty_description(
    args: &serde_json::Value,
) -> Result<PtyDescriptionUpdate, serde_json::Value> {
    let Some(value) = args.get("pty_description") else {
        return Ok(PtyDescriptionUpdate::Unchanged);
    };
    match value {
        serde_json::Value::Null => Ok(PtyDescriptionUpdate::Set(None)),
        serde_json::Value::String(text) => {
            let text = text.trim();
            Ok(PtyDescriptionUpdate::Set(
                (!text.is_empty()).then(|| text.to_string()),
            ))
        }
        _ => Err(serde_json::json!({
            "error": "'pty_description' must be a string or null"
        })),
    }
}

/// Resolve the description for a newly orchestrated PTY. Callers with a rich
/// orchestration surface can set or clear it explicitly; callers whose spawn
/// schema only carries a task prompt still get a compact, display-only summary.
/// This never changes the prompt delivered to the child.
fn resolve_spawn_pty_description(update: PtyDescriptionUpdate, prompt: &str) -> Option<String> {
    match update {
        PtyDescriptionUpdate::Set(description) => description,
        PtyDescriptionUpdate::Unchanged => {
            let collapsed = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
            if collapsed.is_empty() {
                return None;
            }

            let mut chars = collapsed.chars();
            let prefix: String = chars
                .by_ref()
                .take(INFERRED_PTY_DESCRIPTION_MAX_CHARS)
                .collect();
            if chars.next().is_none() {
                Some(prefix)
            } else {
                let mut truncated: String = prefix
                    .chars()
                    .take(INFERRED_PTY_DESCRIPTION_MAX_CHARS - 1)
                    .collect();
                truncated.push('…');
                Some(truncated)
            }
        }
    }
}

fn apply_pty_description(state: &AppState, session_id: &str, description: PtyDescriptionUpdate) {
    if let PtyDescriptionUpdate::Set(description) = description {
        state.set_pty_description(session_id, description);
    }
}

/// Extract path from args with guidance error
fn require_path(args: &serde_json::Value, action: &str) -> Result<String, serde_json::Value> {
    args["path"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| serde_json::json!({"error": format!("Action '{}' requires 'path' (absolute path to git repository)", action)}))
}

/// Build the full searchable tool corpus — native (filtered by
/// `disabled_native_tools`) merged with upstream aggregated tools.
///
/// Unlike [`merged_tool_definitions`], this bypasses the `collapse_tools`
/// branch: when collapsed, the client sees only the 3 meta-tools but the
/// handlers still need the full list to search over and dispatch to.
///
/// Upstream allow/deny filters are applied inside `aggregated_tools()`.
fn searchable_tool_definitions(state: &Arc<AppState>) -> Vec<serde_json::Value> {
    let mut tools = filtered_native_tools(state);
    tools.extend(state.mcp_upstream_registry.aggregated_tools());
    tools
}

/// Rebuild the cached `tool_search_index` from the current state.
///
/// Called on startup and on every `mcp_tools_changed` signal (native tool
/// toggle, upstream add/remove, upstream tools/list_changed).
pub(crate) fn rebuild_tool_search_index(state: &Arc<AppState>) {
    let tools = searchable_tool_definitions(state);
    let index = crate::tool_search::ToolSearchIndex::build(&tools);
    *state.tool_search_index.write() = index;
}

/// Spawn the background task that subscribes to `mcp_tools_changed` and
/// rebuilds `tool_search_index` on every signal. Also does an initial build
/// so the index is populated immediately.
pub(crate) fn spawn_tool_search_index_updater(state: Arc<AppState>) {
    // Initial build so search_tools works before the first tools_changed signal.
    rebuild_tool_search_index(&state);

    let mut rx = state.mcp_tools_changed.subscribe();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(()) => rebuild_tool_search_index(&state),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        source = "tool_search_index",
                        lagged = n,
                        "tools_changed bus lagged — rebuilding"
                    );
                    rebuild_tool_search_index(&state);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Handle `search_tools` meta-tool — BM25 search over the full corpus.
fn handle_search_tools(state: &Arc<AppState>, args: &serde_json::Value) -> serde_json::Value {
    let query = match args["query"].as_str() {
        Some(q) if !q.trim().is_empty() => q,
        _ => {
            return serde_json::json!({
                "error": "search_tools requires non-empty 'query' (natural-language string describing what you want to do)"
            });
        }
    };
    let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 100) as usize;

    let index = state.tool_search_index.read();
    let results = index.search(query, limit);

    let ranked: Vec<serde_json::Value> = results
        .iter()
        .map(|e| serde_json::json!({ "name": e.name, "summary": e.summary }))
        .collect();
    serde_json::json!({ "results": ranked, "count": ranked.len() })
}

/// Handle `get_tool_schema` meta-tool — exact-name lookup of a tool's full definition.
fn handle_get_tool_schema(state: &Arc<AppState>, args: &serde_json::Value) -> serde_json::Value {
    let tool_name = match args["tool_name"].as_str() {
        Some(n) if !n.trim().is_empty() => n,
        _ => {
            return serde_json::json!({
                "error": "get_tool_schema requires non-empty 'tool_name' (exact tool name from search_tools)"
            });
        }
    };

    let index = state.tool_search_index.read();

    match index.get_schema(tool_name) {
        Some(def) => def.clone(),
        None => serde_json::json!({
            "error": format!(
                "Tool '{}' not found. Use search_tools to discover available tools.",
                tool_name
            )
        }),
    }
}

/// Handle `call_tool` meta-tool — dispatch a named tool call to either
/// the native handler or the upstream proxy, preserving `addr` for
/// localhost-only restrictions (config save, notify confirm).
async fn handle_call_tool(
    state: &Arc<AppState>,
    addr: SocketAddr,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
    managed_parent_cwd: Option<&str>,
) -> serde_json::Value {
    let tool_name = match args["tool_name"].as_str() {
        Some(n) if !n.trim().is_empty() => n.to_string(),
        _ => {
            return serde_json::json!({
                "error": "call_tool requires non-empty 'tool_name' (exact tool name from search_tools or get_tool_schema)"
            });
        }
    };

    // Block recursive meta-tool invocation — meta-tools are invoked directly,
    // not routed through call_tool.
    if META_TOOL_NAMES.contains(&tool_name.as_str()) {
        return serde_json::json!({
            "error": format!(
                "call_tool cannot invoke meta-tool '{}'. Meta-tools (search_tools, get_tool_schema, call_tool) are invoked directly.",
                tool_name
            )
        });
    }

    let tool_args = args
        .get("arguments")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    let is_upstream = tool_name.contains("__");
    if is_upstream {
        let allowed = resolve_allowed_upstreams(state, mcp_session_id);
        match state
            .mcp_upstream_registry
            .proxy_tool_call_for_repo(&tool_name, tool_args, allowed.as_deref())
            .await
        {
            Ok(v) => mark_upstream_tool_result(v),
            Err(e) => serde_json::json!({ "error": e }),
        }
    } else {
        // Recursive async dispatch requires Box::pin. Meta names are blocked above.
        Box::pin(handle_mcp_tool_call_with_context(
            state,
            addr,
            &tool_name,
            &tool_args,
            mcp_session_id,
            managed_parent_cwd,
        ))
        .await
    }
}

/// Handle an MCP tools/call request, executing against the app state directly (no HTTP round-trip).
/// Also used by the `deep_link_mcp_call` Tauri command for the `tuic://cmd/` gateway.
pub(crate) async fn handle_mcp_tool_call(
    state: &Arc<AppState>,
    addr: SocketAddr,
    name: &str,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
) -> serde_json::Value {
    unmark_upstream_tool_result(
        handle_mcp_tool_call_with_context(state, addr, name, args, mcp_session_id, None).await,
    )
}

/// Run a synchronous tool handler on the blocking pool.
///
/// The sync handlers reach genuinely blocking work: `session close`/`kill` wait on the
/// child with `std::thread::sleep` (up to 200ms in `close_pty_core`/`kill_pty_core`),
/// agent injection sleeps `INJECT_ENTER_GAP` between the payload and the Enter, and
/// spawn/config paths issue blocking syscalls and disk I/O. Called inline from an async
/// handler these park a tokio worker for the whole duration.
async fn run_blocking_handler<F>(f: F) -> serde_json::Value
where
    F: FnOnce() -> serde_json::Value + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(value) => value,
        Err(e) => serde_json::json!({
            "error": format!("tool handler failed to complete: {e}")
        }),
    }
}

fn session_action_requires_blocking_pool(action: &str) -> bool {
    matches!(
        action,
        "create" | "input" | "kill" | "close" | "process_stats"
    )
}

fn agent_action_requires_blocking_pool(action: &str) -> bool {
    matches!(action, "spawn" | "detect" | "send")
}

async fn handle_mcp_tool_call_with_context(
    state: &Arc<AppState>,
    addr: SocketAddr,
    name: &str,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
    managed_parent_cwd: Option<&str>,
) -> serde_json::Value {
    // Enforce disabled_native_tools on every call path (not just the call_tool meta-tool).
    // Read-guard does not span an await and is released at the end of the `if` expression.
    if state
        .config
        .read()
        .disabled_native_tools
        .iter()
        .any(|d| d == name)
    {
        return serde_json::json!({"error": format!("Tool '{}' is disabled by configuration", name)});
    }
    // Resolve client identity at dispatch level — tool handlers get a plain bool
    let is_claude_code = mcp_session_id
        .and_then(|sid| state.mcp_sessions.get(sid))
        .map(|meta| meta.is_claude_code)
        .unwrap_or(false);
    match name {
        "session" => {
            // Executing / destructive session actions carry the same loopback
            // restriction as `agent spawn`: `submit` executes a managed-agent
            // composer command, while `input` writes raw bytes to a PTY's stdin
            // (arbitrary command execution on a shell session, unfiltered context
            // injection on an agent session). `create`/`kill`/`close` spawn or
            // destroy sessions, and `pause`/`resume` halt/resume output buffering
            // (a remote `pause` on any session is a DoS). A non-loopback MCP client
            // (authenticated remote, or admitted via lan_auth_bypass) must not reach
            // them — remote terminal control is served separately by the auth-gated
            // POST /sessions/{id}/write route. Read-only actions (list/output/status/…)
            // stay open for monitoring.
            let action = args["action"].as_str().unwrap_or("");
            if action == "wait" {
                // Read-only blocking wait — needs the async runtime for its poll
                // loop, so it can't live in the sync handle_session.
                handle_session_wait(state, args).await
            } else if action == "submit" && !addr.ip().is_loopback() {
                serde_json::json!({
                    "error": "This session action is restricted to localhost connections"
                })
            } else if action == "submit" {
                handle_session_submit(state, args).await
            } else if matches!(
                action,
                "create" | "input" | "kill" | "close" | "pause" | "resume"
            ) && !addr.ip().is_loopback()
            {
                serde_json::json!({
                    "error": "This session action is restricted to localhost connections"
                })
            } else if session_action_requires_blocking_pool(action) {
                let state = state.clone();
                let args = args.clone();
                let sid = mcp_session_id.map(str::to_owned);
                run_blocking_handler(move || handle_session(&state, &args, sid.as_deref())).await
            } else {
                handle_session(state, args, mcp_session_id)
            }
        }
        "agent" => {
            let action = args["action"].as_str().unwrap_or("");
            if action == "wait" {
                handle_agent_wait(state, args, mcp_session_id).await
            } else if agent_action_requires_blocking_pool(action) {
                let state = state.clone();
                let args = args.clone();
                let sid = mcp_session_id.map(str::to_owned);
                let parent_cwd = managed_parent_cwd.map(str::to_owned);
                run_blocking_handler(move || {
                    handle_agent_unified_with_parent_cwd(
                        &state,
                        addr,
                        &args,
                        sid.as_deref(),
                        parent_cwd.as_deref(),
                    )
                })
                .await
            } else {
                handle_agent_unified_with_parent_cwd(
                    state,
                    addr,
                    args,
                    mcp_session_id,
                    managed_parent_cwd,
                )
            }
        }
        "task" => {
            let state = state.clone();
            let args = args.clone();
            let sid = mcp_session_id.map(str::to_owned);
            run_blocking_handler(move || handle_task(&state, addr, &args, sid.as_deref())).await
        }
        "repo" => handle_repo(state, args, is_claude_code).await,
        "ui" => handle_ui_unified(state, addr, args, mcp_session_id).await,
        "plugin_dev_guide" => {
            serde_json::json!({"content": super::plugin_docs::PLUGIN_DOCS})
        }
        "config" => {
            let state = state.clone();
            let args = args.clone();
            run_blocking_handler(move || handle_config(&state, addr, &args)).await
        }
        "debug" => handle_debug_unified(state, addr, args),
        "search_tools" => handle_search_tools(state, args),
        "get_tool_schema" => handle_get_tool_schema(state, args),
        "call_tool" => {
            handle_call_tool(state, addr, args, mcp_session_id, managed_parent_cwd).await
        }
        n if super::ai_terminal::is_ai_terminal_tool(n) => {
            if !state.config.read().ai_terminal_mcp_enabled {
                return serde_json::json!({
                    "error": format!(
                        "Tool '{n}' is disabled. Enable `ai_terminal_mcp_enabled` in config to expose ai_terminal_* tools to external MCP clients."
                    )
                });
            }
            super::ai_terminal::handle(state, n, args).await
        }
        _ => serde_json::json!({"error": format!(
            "Unknown tool '{}'. Available: session, agent, repo, ui, plugin_dev_guide, config, debug, search_tools, get_tool_schema, call_tool, ai_terminal_*", name
        )}),
    }
}

/// Default `wait` timeout when the caller omits `timeout_ms`.
const WAIT_DEFAULT_MS: u64 = 60_000;
/// Advertised cap on a single server-side wait — the number in the tool schema.
const WAIT_MAX_MS: u64 = 300_000;
/// Headroom between the advertised cap and the wait we actually run.
///
/// A client aborts its own `tools/call` on a deadline of its own, and at least
/// one shipping client (Codex) uses exactly 300s — the same round number as our
/// cap. A wait that runs the full `WAIT_MAX_MS` therefore answers right on that
/// deadline and loses the race every time, turning the advertised maximum into a
/// guaranteed error instead of `{timed_out:true}`. The bridge already reserves
/// the same margin on its own response deadline. Kept client-agnostic on
/// purpose: a per-client table would have to be maintained against every client
/// release, and a wait that ends 5s early is indistinguishable to the caller.
const WAIT_CLIENT_DEADLINE_MARGIN_MS: u64 = 5_000;
/// The wait actually run for a caller asking for the cap or more.
const WAIT_EFFECTIVE_MAX_MS: u64 = WAIT_MAX_MS - WAIT_CLIENT_DEADLINE_MARGIN_MS;

/// Resolve the effective wait timeout: default when absent/zero, capped so the
/// reply beats the caller's own tool-call deadline.
fn clamp_wait_timeout(requested: Option<u64>) -> u64 {
    match requested {
        Some(ms) if ms > 0 => ms.min(WAIT_EFFECTIVE_MAX_MS),
        _ => WAIT_DEFAULT_MS,
    }
}

/// Whether a session's blocking-wait condition is currently satisfied.
/// `until` is "idle" (shell idle) or "exited" (process gone / exit code recorded).
fn session_wait_met(state: &AppState, session_id: &str, until: &str) -> bool {
    match until {
        // `exit_codes` is recorded by `mark_session_exited` and kept for the
        // tombstone TTL. Using only this signal avoids a false "exited" for a
        // never-created (typo'd) session id, which would otherwise return met
        // immediately because it isn't in `sessions`.
        "exited" => state.exit_codes.contains_key(session_id),
        // Default and "idle": shell state reached IDLE.
        _ => state
            .shell_states
            .get(session_id)
            .map(|a| a.load(std::sync::atomic::Ordering::Relaxed) == crate::pty::SHELL_IDLE)
            .unwrap_or(false),
    }
}

fn session_wait_response(
    state: &AppState,
    session_id: &str,
    until: &str,
    met: bool,
) -> serde_json::Value {
    if !met {
        return serde_json::json!({
            "met": false,
            "timed_out": true,
            "until": until,
        });
    }
    let shell_state = state.shell_states.get(session_id).and_then(|value| {
        crate::pty::shell_state_wire(value.load(std::sync::atomic::Ordering::Relaxed))
    });
    let mut response = serde_json::json!({
        "met": true,
        "timed_out": false,
        "until": until,
    });
    let object = response
        .as_object_mut()
        .expect("session wait response is an object");
    insert_optional_value(
        object,
        "shell_state",
        shell_state.map(|value| serde_json::Value::String(value.to_string())),
    );
    insert_optional_value(
        object,
        "exit_code",
        state
            .exit_codes
            .get(session_id)
            .map(|entry| serde_json::Value::from(*entry.value())),
    );
    response
}

/// `session action=wait` — block (server-side) until the session is idle or has
/// exited, or the timeout elapses. Replaces an LLM polling loop (each poll is a
/// full model turn) with one cheap blocking call.
async fn handle_session_wait(state: &Arc<AppState>, args: &serde_json::Value) -> serde_json::Value {
    let session_id = match require_session_id(args, "wait") {
        Ok(id) => id.to_string(),
        Err(e) => return e,
    };
    let until = args["until"].as_str().unwrap_or("idle");
    if !matches!(until, "idle" | "exited") {
        return serde_json::json!({"error": "wait 'until' must be 'idle' or 'exited'"});
    }
    let timeout_ms = clamp_wait_timeout(args["timeout_ms"].as_u64());
    // Reject an unknown session BEFORE subscribing. `subscribe_pty_events` uses
    // the DashMap entry API, so it CREATES a 256-slot broadcast channel for
    // whatever id it is handed. Session teardown reaps that entry — but only for
    // ids that were ever real sessions, so a caller passing made-up ids grew
    // `pty_event_channels` with entries nothing will ever remove. It also spared
    // the caller a pointless full-timeout block on a session that cannot exist.
    if !state.sessions.contains_key(&session_id) {
        return serde_json::json!({
            "error": format!("Unknown session \"{session_id}\"")
        });
    }
    // Subscribe before checking current state. This closes the lost-wake window
    // without polling: an earlier transition is visible in state, while a later
    // one is retained by the per-session event receiver.
    let mut events = state.subscribe_pty_events(&session_id);
    if session_wait_met(state, &session_id, until) {
        return session_wait_response(state, &session_id, until, true);
    }
    let woke = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), async {
        loop {
            match events.recv().await {
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if session_wait_met(state, &session_id, until) {
                        return true;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return false,
            }
        }
    })
    .await
    .unwrap_or(false);
    // Re-check at the timeout boundary so a simultaneous transition wins over
    // a spurious timed_out response.
    let met = woke || session_wait_met(state, &session_id, until);
    session_wait_response(state, &session_id, until, met)
}

const SUBMIT_ACK_DEFAULT_MS: u64 = 3_000;
const SUBMIT_ACK_MIN_MS: u64 = 250;
const SUBMIT_ACK_MAX_MS: u64 = 10_000;
const SUBMIT_ACK_CHECK_MS: u64 = 10;

struct StartedSubmission {
    submission_id: String,
    session_id: String,
    turn_epoch: u64,
    acknowledgement_offset: u64,
    timeout_ms: u64,
}

enum BeginSubmission {
    Response(serde_json::Value),
    Started(StartedSubmission),
}

fn submission_turn_epoch(state: &AppState, session_id: &str) -> u64 {
    state
        .session_states
        .get(session_id)
        .map(|session| session.turn_epoch)
        .unwrap_or(0)
}

fn submission_output_offset(state: &AppState, session_id: &str) -> Option<u64> {
    state
        .output_buffers
        .get(session_id)
        .map(|buffer| buffer.lock().total_written)
}

fn begin_session_submit(state: &Arc<AppState>, args: &serde_json::Value) -> BeginSubmission {
    let session_id = match require_session_id(args, "submit") {
        Ok(id) => id.to_string(),
        Err(error) => return BeginSubmission::Response(error),
    };
    let text = match args["input"].as_str() {
        Some(text) if !text.is_empty() => text,
        _ => {
            return BeginSubmission::Response(serde_json::json!({
                "error": "Action 'submit' requires non-empty 'input'"
            }));
        }
    };
    let submission_id = Uuid::new_v4().to_string();
    let turn_epoch = submission_turn_epoch(state, &session_id);
    if !state.sessions.contains_key(&session_id) {
        return BeginSubmission::Response(serde_json::json!({
            "status": "rejected",
            "submission_id": submission_id,
            "submitted": false,
            "write_state": "not_started",
            "acknowledged": false,
            "retry_safe": true,
            "reason": "session_not_found",
            "turn_epoch": turn_epoch,
            "composer_state": "unknown",
        }));
    }
    if submission_output_offset(state, &session_id).is_none() {
        return BeginSubmission::Response(serde_json::json!({
            "status": "rejected",
            "submission_id": submission_id,
            "submitted": false,
            "write_state": "not_started",
            "acknowledged": false,
            "retry_safe": true,
            "reason": "observation_unavailable",
            "turn_epoch": turn_epoch,
            "composer_state": "unknown",
        }));
    }

    match crate::pty::write_agent_submission_to_pty(state, &session_id, text) {
        crate::pty::AgentSubmissionWrite::Rejected {
            reason,
            composer_state,
        } => BeginSubmission::Response(serde_json::json!({
            "status": "rejected",
            "submission_id": submission_id,
            "submitted": false,
            "write_state": "not_started",
            "acknowledged": false,
            "retry_safe": true,
            "reason": reason,
            "turn_epoch": submission_turn_epoch(state, &session_id),
            "composer_state": composer_state,
        })),
        crate::pty::AgentSubmissionWrite::Failed(detail) => {
            BeginSubmission::Response(serde_json::json!({
                "status": "write_failed",
                "submission_id": submission_id,
                "submitted": false,
                "write_state": "not_started",
                "acknowledged": false,
                "retry_safe": true,
                "reason": "pty_write_failed",
                "detail": detail,
                "turn_epoch": submission_turn_epoch(state, &session_id),
                "composer_state": "empty",
            }))
        }
        crate::pty::AgentSubmissionWrite::Uncertain(detail) => {
            BeginSubmission::Response(serde_json::json!({
                "status": "write_uncertain",
                "submission_id": submission_id,
                "submitted": false,
                "write_state": "uncertain",
                "acknowledged": false,
                "retry_safe": false,
                "reason": "pty_write_uncertain",
                "detail": detail,
                "turn_epoch": submission_turn_epoch(state, &session_id),
                "composer_state": "unknown",
            }))
        }
        crate::pty::AgentSubmissionWrite::Complete {
            acknowledgement_offset,
        } => {
            // Reuse the same FSM path as raw MCP/HTTP input. The text and CR are
            // bookkeeping boundaries only; the framed PTY bytes were written once
            // above. This advances the authoritative turn epoch exactly once.
            crate::pty_capture::record_input(&session_id, text.as_bytes());
            crate::pty_capture::record_input(&session_id, b"\r");
            super::session::apply_input_bookkeeping(state, &session_id, text);
            super::session::apply_input_bookkeeping(state, &session_id, "\r");
            let timeout_ms = args["timeout_ms"]
                .as_u64()
                .unwrap_or(SUBMIT_ACK_DEFAULT_MS)
                .clamp(SUBMIT_ACK_MIN_MS, SUBMIT_ACK_MAX_MS);
            BeginSubmission::Started(StartedSubmission {
                submission_id,
                session_id: session_id.clone(),
                turn_epoch: submission_turn_epoch(state, &session_id),
                acknowledgement_offset,
                timeout_ms,
            })
        }
    }
}

async fn handle_session_submit(
    state: &Arc<AppState>,
    args: &serde_json::Value,
) -> serde_json::Value {
    let pty_description = match parse_pty_description(args) {
        Ok(description) => description,
        Err(error) => return error,
    };
    let blocking_state = Arc::clone(state);
    let blocking_args = args.clone();
    let begin = match tokio::task::spawn_blocking(move || {
        begin_session_submit(&blocking_state, &blocking_args)
    })
    .await
    {
        Ok(begin) => begin,
        Err(error) => {
            return serde_json::json!({
                "error": format!("tool handler failed to complete: {error}")
            });
        }
    };
    let started = match begin {
        BeginSubmission::Response(response) => return response,
        BeginSubmission::Started(started) => started,
    };
    apply_pty_description(state, &started.session_id, pty_description);

    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_millis(started.timeout_ms);
    loop {
        let current_epoch = submission_turn_epoch(state, &started.session_id);
        if current_epoch != started.turn_epoch {
            return serde_json::json!({
                "status": "superseded",
                "submission_id": started.submission_id,
                "submitted": true,
                "write_state": "complete",
                "acknowledged": false,
                "retry_safe": false,
                "reason": "turn_epoch_changed",
                "turn_epoch": started.turn_epoch,
                "current_turn_epoch": current_epoch,
                "composer_state": "cleared",
            });
        }
        if let Some(output_offset) = submission_output_offset(state, &started.session_id)
            && output_offset > started.acknowledgement_offset
        {
            return serde_json::json!({
                "status": "acknowledged",
                "submission_id": started.submission_id,
                "submitted": true,
                "write_state": "complete",
                "acknowledged": true,
                "retry_safe": false,
                "turn_epoch": started.turn_epoch,
                "composer_state": "cleared",
                "acknowledgement": {
                    "kind": "terminal_movement",
                    "screen_state": crate::pty::agent_submission_ack_kind(state, &started.session_id),
                    "output_offset": output_offset,
                },
            });
        }
        if !state.sessions.contains_key(&started.session_id) {
            let mut response = serde_json::json!({
                "status": "session_ended",
                "submission_id": started.submission_id,
                "submitted": true,
                "write_state": "complete",
                "acknowledged": false,
                "retry_safe": false,
                "reason": "session_ended_before_ack",
                "turn_epoch": started.turn_epoch,
                "composer_state": "unknown",
            });
            if let Some(exit_code) = state.exit_codes.get(&started.session_id) {
                response["exit_code"] = serde_json::json!(*exit_code.value());
            }
            return response;
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return serde_json::json!({
                "status": "ack_timeout",
                "submission_id": started.submission_id,
                "submitted": true,
                "write_state": "complete",
                "acknowledged": false,
                "retry_safe": false,
                "reason": "no_terminal_movement_after_enter",
                "turn_epoch": started.turn_epoch,
                "composer_state": "cleared",
                "timeout_ms": started.timeout_ms,
                "output_offset": submission_output_offset(state, &started.session_id),
            });
        }
        tokio::time::sleep(std::time::Duration::from_millis(
            SUBMIT_ACK_CHECK_MS.min((deadline - now).as_millis().max(1) as u64),
        ))
        .await;
    }
}

/// `agent action=wait` — block until the caller's inbox has a message newer than
/// `since` (unix ms), or the timeout elapses. The caller must be registered
/// (identity auto-binds at initialize, so this is normally already true).
struct ActiveAgentWaitGuard {
    state: Arc<AppState>,
    tuic_session: String,
    lease: u64,
    since: u64,
    finished: bool,
}

impl ActiveAgentWaitGuard {
    fn new(
        state: &Arc<AppState>,
        tuic_session: &str,
        since: u64,
    ) -> (Self, tokio::sync::watch::Receiver<u64>) {
        let (lease, events) = state.begin_agent_wait_with_events(tuic_session);
        (
            Self {
                state: Arc::clone(state),
                tuic_session: tuic_session.to_string(),
                lease,
                since,
                finished: false,
            },
            events,
        )
    }

    fn finish(&mut self, observe_fresh: bool) -> crate::state::AgentWaitFinish {
        if self.finished {
            return crate::state::AgentWaitFinish::default();
        }
        let finish =
            self.state
                .finish_agent_wait(&self.tuic_session, self.lease, self.since, observe_fresh);
        dispatch_waiter_handoff(&self.state, &self.tuic_session, &finish.terminal_handoff);
        self.finished = true;
        finish
    }
}

impl Drop for ActiveAgentWaitGuard {
    fn drop(&mut self) {
        self.finish(false);
    }
}

fn dispatch_waiter_handoff(state: &AppState, recipient: &str, message_ids: &[String]) {
    if message_ids.is_empty() {
        return;
    }
    let wanted: std::collections::HashSet<&str> = message_ids.iter().map(String::as_str).collect();
    let messages: Vec<crate::state::AgentMessage> = state
        .agent_inbox
        .get(recipient)
        .map(|inbox| {
            inbox
                .iter()
                .filter(|message| wanted.contains(message.id.as_str()))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    for message in messages {
        if crate::pty::route_registered_orchestrator_mail(
            state,
            recipient,
            &message.id,
            message.timestamp,
        )
        .is_some()
        {
            continue;
        }
        let framed = frame_peer_message(&message.from_name, &message.content);
        let outcome = crate::pty::deliver_message_to_managed_pty(state, recipient, &framed);
        crate::pty::settle_terminal_delivery(state, recipient, &message.id, outcome);
    }
}

const AGENT_WAIT_INLINE_LIMIT: usize = crate::state::AGENT_INBOX_CAPACITY;

fn bounded_agent_messages<'a>(
    messages: impl DoubleEndedIterator<Item = &'a crate::state::AgentMessage>,
    limit: usize,
) -> Vec<crate::state::AgentMessage> {
    let mut page: Vec<_> = messages.rev().take(limit).cloned().collect();
    page.reverse();
    page
}

/// Resolve the read position for a wait/inbox call.
///
/// An explicit `since` always wins — `since=0` is the deliberate "replay
/// everything" escape hatch and must stay honoured. Omitting it resumes from the
/// server-side cursor, so a caller that cannot thread the value (or that lost it
/// to a timeout) no longer falls back to replaying the whole inbox.
fn resolve_agent_since(state: &AppState, tuic_session: &str, args: &serde_json::Value) -> u64 {
    match args["since"].as_u64() {
        Some(explicit) => explicit,
        None => state
            .agent_read_cursor
            .get(tuic_session)
            .map(|entry| *entry.value())
            .unwrap_or(0),
    }
}

/// Drop every per-identity buffer that must not outlive a retired or torn-down
/// peer. `agent_inbox` stays out on purpose: retire drains it into the replacing
/// identity while teardown deletes it, so each caller owns that decision.
///
/// One function so the two teardown paths cannot disagree about the set — the
/// read cursor was added to `AppState` and wired into neither, which left it
/// growing without bound and let a replacing identity resume from zero.
fn drop_identity_buffers(state: &AppState, tuic_session: &str) {
    state.agent_inbox_evictions.remove(tuic_session);
    state.active_agent_waiters.remove(tuic_session);
    state.pending_injections.remove(tuic_session);
    state.session_to_mcp.remove(tuic_session);
    state.agent_read_cursor.remove(tuic_session);
}

/// Advance the stored read position. Never moves backwards: a deliberate replay
/// (`since=0`) must not rewind the cursor for the next omitted-`since` call.
fn advance_agent_cursor(state: &AppState, tuic_session: &str, cursor: u64) {
    let mut entry = state
        .agent_read_cursor
        .entry(tuic_session.to_string())
        .or_insert(0);
    if cursor > *entry {
        *entry = cursor;
    }
}

fn agent_wait_success_response(
    state: &AppState,
    tuic_session: &str,
    since: u64,
    finish: crate::state::AgentWaitFinish,
) -> serde_json::Value {
    let messages = bounded_agent_messages(finish.messages.iter(), AGENT_WAIT_INLINE_LIMIT);
    // Fall back to the position we read from, so `next_since` is present even when
    // the batch is empty — losing the cursor is what drove callers back to since=0.
    let next_since = messages
        .iter()
        .map(|message| message.timestamp)
        .max()
        .unwrap_or(since);
    advance_agent_cursor(state, tuic_session, next_since);
    serde_json::json!({
        "met": true,
        "timed_out": false,
        "new_messages": finish.fresh_count,
        "messages": messages,
        "next_since": next_since,
    })
}

async fn handle_agent_wait(
    state: &Arc<AppState>,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
) -> serde_json::Value {
    let caller_tuic = match mcp_session_id
        .and_then(|sid| state.mcp_to_session.get(sid).map(|e| e.value().clone()))
    {
        Some(t) => t,
        None => {
            return serde_json::json!({"error": "You are not registered. Identity normally auto-binds at initialize; ensure $TUIC_SESSION is set or call agent action=register."});
        }
    };
    let since = resolve_agent_since(state, &caller_tuic, args);
    let (mut active_wait, mut inbox_events) = ActiveAgentWaitGuard::new(state, &caller_tuic, since);
    let timeout_ms = clamp_wait_timeout(args["timeout_ms"].as_u64());
    if state.waiter_fresh_message_count(&caller_tuic, since) > 0 {
        return agent_wait_success_response(state, &caller_tuic, since, active_wait.finish(true));
    }
    let woke = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), async {
        loop {
            if inbox_events.changed().await.is_err() {
                return false;
            }
            if state.waiter_fresh_message_count(&caller_tuic, since) > 0 {
                return true;
            }
        }
    })
    .await
    .unwrap_or(false);
    let finish = active_wait.finish(true);
    if woke || finish.fresh_count > 0 {
        return agent_wait_success_response(state, &caller_tuic, since, finish);
    }
    // A timed-out wait must still hand back a usable cursor, or the caller has
    // nothing to pass but `since=0`. Prefer the stored position over the requested
    // one: a deliberate `since=0` replay that finds nothing new should resume from
    // where reading actually got to, not send the caller back to the start.
    let resume = state
        .agent_read_cursor
        .get(&caller_tuic)
        .map(|entry| *entry.value())
        .unwrap_or(0)
        .max(since);
    serde_json::json!({"met": false, "timed_out": true, "new_messages": 0, "next_since": resume})
}

fn handle_session(
    state: &Arc<AppState>,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
) -> serde_json::Value {
    let action = match require_action(args, "session", SESSION_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    match action {
        "list" => {
            let caller_tuic = mcp_session_id
                .and_then(|sid| state.mcp_to_session.get(sid))
                .map(|entry| entry.value().clone());
            let sessions: Vec<serde_json::Value> = state
                .sessions
                .iter()
                .map(|entry| {
                    let id = entry.key().clone();
                    let s = entry.value().lock();
                    #[cfg(not(windows))]
                    let pgid = s.master.process_group_leader();
                    #[cfg(windows)]
                    let pgid = s._child.process_id();
                    #[cfg(not(windows))]
                    let process_name =
                        pgid.and_then(|p| crate::pty::process_name_from_pid(p as u32));
                    #[cfg(windows)]
                    let process_name = pgid.and_then(crate::pty::process_name_from_pid);
                    let session_state = state.session_state_with_shell(&id);
                    let shell_state = session_state
                        .as_ref()
                        .and_then(|snapshot| snapshot.shell_state.clone());
                    let agent_state = session_state
                        .as_ref()
                        .and_then(|snapshot| snapshot.agent_state.clone());
                    let background_work = session_state
                        .as_ref()
                        .is_some_and(|snapshot| snapshot.background_work);
                    let alias = state.term_aliases.get(&id).map(|e| e.value().clone());
                    let child_pid = s._child.process_id();
                    #[cfg(unix)]
                    let standby = state.standby_sessions.contains_key(id.as_str());
                    #[cfg(not(unix))]
                    let standby = false;
                    let mut session = serde_json::json!({
                        "session_id": id,
                        "background_work": background_work,
                        "standby": standby,
                        "is_caller": caller_tuic.as_deref() == Some(id.as_str()),
                    });
                    let object = session
                        .as_object_mut()
                        .expect("session list entry is an object");
                    insert_optional_value(
                        object,
                        "child_pid",
                        child_pid.map(serde_json::Value::from),
                    );
                    insert_optional_value(object, "alias", alias.map(serde_json::Value::String));
                    insert_optional_value(
                        object,
                        "display_name",
                        s.display_name.clone().map(serde_json::Value::String),
                    );
                    insert_optional_value(
                        object,
                        "pty_description",
                        state
                            .pty_descriptions
                            .get(&id)
                            .map(|value| serde_json::Value::String(value.value().clone())),
                    );
                    insert_optional_value(
                        object,
                        "cwd",
                        s.cwd.clone().map(serde_json::Value::String),
                    );
                    insert_optional_value(
                        object,
                        "worktree_path",
                        s.worktree.as_ref().map(|worktree| {
                            serde_json::Value::String(worktree.path.to_string_lossy().to_string())
                        }),
                    );
                    insert_optional_value(
                        object,
                        "worktree_branch",
                        s.worktree
                            .as_ref()
                            .and_then(|worktree| worktree.branch.clone())
                            .map(serde_json::Value::String),
                    );
                    insert_optional_value(
                        object,
                        "foreground_pgid",
                        pgid.map(serde_json::Value::from),
                    );
                    insert_optional_value(
                        object,
                        "foreground_process",
                        process_name.map(serde_json::Value::String),
                    );
                    insert_optional_value(
                        object,
                        "shell_state",
                        shell_state.map(serde_json::Value::String),
                    );
                    insert_optional_value(
                        object,
                        "agent_state",
                        agent_state.map(serde_json::Value::String),
                    );
                    session
                })
                .collect();
            serde_json::json!(sessions)
        }
        "create" => {
            if state.sessions.len() >= MAX_CONCURRENT_SESSIONS {
                return serde_json::json!({"error": "Max concurrent sessions reached"});
            }
            let rows = args["rows"].as_u64().unwrap_or(24) as u16;
            let cols = args["cols"].as_u64().unwrap_or(80) as u16;
            if let Err(msg) = super::validate_terminal_size(rows, cols) {
                return serde_json::json!({"error": msg});
            }
            let shell = resolve_shell(args["shell"].as_str().map(|s| s.to_string()));
            let cwd = args["cwd"].as_str().map(|s| s.to_string());

            match super::session::spawn_pty_session(
                state.clone(),
                shell,
                cwd,
                rows,
                cols,
                None,
                None,
            ) {
                Ok(session_id) => serde_json::json!({"session_id": session_id}),
                Err((_, body)) => {
                    serde_json::json!({"error": body.0.get("error").and_then(|v| v.as_str()).unwrap_or("spawn failed")})
                }
            }
        }
        "input" => {
            let session_id = match require_session_id(args, "input") {
                Ok(id) => id,
                Err(e) => return e,
            };
            let text = args["input"].as_str().unwrap_or("");
            let key_seq: Option<&str> = if let Some(key) = args["special_key"].as_str() {
                match translate_special_key(key) {
                    Some(seq) => Some(seq),
                    None => {
                        return serde_json::json!({"error": format!("Unknown special key: {}", key)});
                    }
                }
            } else {
                None
            };
            let pty_description = match parse_pty_description(args) {
                Ok(description) => description,
                Err(error) => return error,
            };
            if text.is_empty()
                && key_seq.is_none()
                && matches!(&pty_description, PtyDescriptionUpdate::Unchanged)
            {
                return serde_json::json!({"error": "Action 'input' requires 'input' (text), 'special_key', or 'pty_description'"});
            }
            if text.is_empty() && key_seq.is_none() {
                if !state.sessions.contains_key(session_id) {
                    return serde_json::json!({"error": "Session not found"});
                }
                apply_pty_description(state, session_id, pty_description);
                return serde_json::json!({"ok": true});
            }
            let agent_type = state
                .session_states
                .get(session_id)
                .and_then(|s| s.agent_type.clone());

            // Submitting text to a prefill-only agent is not a generic text+key
            // pair. Codex/OpenCode require Ctrl-U framing, bracketed paste for
            // multiline prompts, and a real scheduling gap before CR. Reuse the
            // peer-injection recipe without changing Claude's working input path.
            if !text.is_empty() && uses_agent_command_injection(agent_type.as_deref(), key_seq) {
                if let Err(e) = crate::pty::write_agent_command_to_pty(state, session_id, text) {
                    return serde_json::json!({"error": e});
                }
                crate::pty_capture::record_input(session_id, text.as_bytes());
                crate::pty_capture::record_input(session_id, b"\r");
                super::session::apply_input_bookkeeping(state, session_id, text);
                super::session::apply_input_bookkeeping(state, session_id, "\r");
                apply_pty_description(state, session_id, pty_description);
                return serde_json::json!({"ok": true});
            }

            // Non-agent sessions and non-Enter special keys retain raw pair
            // semantics under one lock so concurrent writers cannot interleave.
            match (text.is_empty(), key_seq) {
                (false, Some(seq)) => {
                    if let Err(e) =
                        super::session::write_pty_input_pair(state, session_id, text, seq)
                    {
                        return serde_json::json!({"error": e});
                    }
                }
                (false, None) => {
                    if let Err(e) = super::session::write_pty_input(state, session_id, text) {
                        return serde_json::json!({"error": e});
                    }
                }
                (true, Some(seq)) => {
                    if let Err(e) = super::session::write_pty_input(state, session_id, seq) {
                        return serde_json::json!({"error": e});
                    }
                }
                (true, None) => unreachable!("checked above: text.is_empty() && key_seq.is_none()"),
            }
            apply_pty_description(state, session_id, pty_description);
            serde_json::json!({"ok": true})
        }
        "submit" => serde_json::json!({
            "error": "Action 'submit' requires the asynchronous MCP dispatch path"
        }),
        "output" => {
            let session_id = match require_session_id(args, "output") {
                Ok(id) => id,
                Err(e) => return e,
            };
            let limit = (args["limit"].as_u64().unwrap_or(50) as usize).max(1);

            // Resolve the session's lifecycle state.
            //
            // A session can be in four observable states here:
            //   1. Live       — present in `state.sessions`, child still running
            //   2. Draining   — present in `state.sessions`, child already exited
            //   3. Tombstoned — absent from `state.sessions` but buffers still present
            //                   (reader thread called `mark_session_exited` on EOF;
            //                   reaped by `spawn_tombstone_sweeper` after TTL)
            //   4. Unknown    — no trace at all; either never existed or already reaped
            //
            // `exited` is only true for (2) and (3) — cases where we have evidence
            // the process actually terminated. (4) returns a structured error.
            let session_entry = state.sessions.get(session_id);
            let buffers_present = state.vt_log_buffers.contains_key(session_id)
                || state.output_buffers.contains_key(session_id);

            let (exited, exit_code): (bool, Option<i64>) = if let Some(entry) = &session_entry {
                match entry.lock()._child.try_wait() {
                    Ok(Some(status)) => {
                        let code = if let Some(sig) = status.signal() {
                            128 + crate::pty::parse_signal_number(sig) as i64
                        } else {
                            status.exit_code() as i64
                        };
                        (true, Some(code))
                    }
                    _ => (false, None),
                }
            } else if buffers_present {
                // Tombstoned — the reader thread captured the exit code if it could.
                (
                    true,
                    state.exit_codes.get(session_id).map(|e| *e.value() as i64),
                )
            } else {
                // Unknown — no session entry, no buffers, no tombstone.
                (false, None)
            };
            drop(session_entry);
            // Default: serve clean rows from VtLogBuffer (no strip_ansi needed).
            // Pass format="raw" to get the raw ring buffer content with ANSI.
            if args["format"].as_str() != Some("raw") {
                let vt_log = match state.vt_log_buffers.get(session_id) {
                    Some(b) => b,
                    None => {
                        return serde_json::json!({
                            "error": "Session not found",
                            "reason": "session_not_found_or_reaped"
                        });
                    }
                };
                let buf = vt_log.lock();
                let total = buf.total_lines();
                let oldest = buf.oldest_offset();
                let scrollback_lines = total - oldest;

                // Delta read: if since_cursor provided, return only new scrollback lines.
                if let Some(since) = args["since_cursor"].as_u64().map(|v| v as usize) {
                    let (log_lines, new_cursor) = buf.lines_since_owned(since, limit);
                    let data: Vec<String> = log_lines.iter().map(|ll| ll.text()).collect();
                    let data = data.join("\n");
                    let mut response = serde_json::json!({"data": data, "data_length": data.len(), "cursor": new_cursor, "scrollback_lines": scrollback_lines, "oldest_offset": oldest, "exited": exited});
                    insert_optional_value(
                        response
                            .as_object_mut()
                            .expect("output response is an object"),
                        "exit_code",
                        exit_code.map(serde_json::Value::from),
                    );
                    return response;
                }

                // Absolute positioning: from_line overrides the default tail window.
                let offset = if let Some(from) = args["from_line"].as_u64().map(|v| v as usize) {
                    from.max(oldest)
                } else {
                    total.saturating_sub(limit)
                };
                let (log_lines, _) = buf.lines_since_owned(offset, limit);
                let screen: Vec<String> = buf
                    .screen_rows()
                    .into_iter()
                    .filter(|r| !r.is_empty())
                    .collect();
                let mut all_lines: Vec<String> = log_lines.iter().map(|ll| ll.text()).collect();
                // Only append screen rows when reading the tail (no from_line).
                if args["from_line"].is_null() {
                    all_lines.extend(screen);
                }
                let data = all_lines.join("\n");
                let mut response = serde_json::json!({"data": data, "data_length": data.len(), "cursor": total, "total_written": total, "scrollback_lines": scrollback_lines, "oldest_offset": oldest, "exited": exited});
                insert_optional_value(
                    response
                        .as_object_mut()
                        .expect("output response is an object"),
                    "exit_code",
                    exit_code.map(serde_json::Value::from),
                );
                return response;
            }
            let ring = match state.output_buffers.get(session_id) {
                Some(r) => r,
                None => {
                    return serde_json::json!({
                        "error": "Session not found",
                        "reason": "session_not_found_or_reaped"
                    });
                }
            };
            let (bytes, total_written) = ring.lock().read_last(limit);
            let data = String::from_utf8_lossy(&bytes).to_string();
            let mut response = serde_json::json!({"data": data, "data_length": data.len(), "total_written": total_written, "exited": exited});
            insert_optional_value(
                response
                    .as_object_mut()
                    .expect("output response is an object"),
                "exit_code",
                exit_code.map(serde_json::Value::from),
            );
            response
        }
        "resize" => {
            let session_id = match require_session_id(args, "resize") {
                Ok(id) => id,
                Err(e) => return e,
            };
            let rows = args["rows"].as_u64().unwrap_or(24) as u16;
            let cols = args["cols"].as_u64().unwrap_or(80) as u16;
            if let Err(msg) = super::validate_terminal_size(rows, cols) {
                return serde_json::json!({"error": msg});
            }
            let entry = match state.sessions.get(session_id) {
                Some(e) => e,
                None => return serde_json::json!({"error": "Session not found"}),
            };
            if let Err(e) = entry.lock().master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            }) {
                return serde_json::json!({"error": format!("Resize failed: {}", e)});
            }
            serde_json::json!({"ok": true})
        }
        "close" => {
            let session_id = match require_session_id(args, "close") {
                Ok(id) => id,
                Err(e) => return e,
            };
            // Self-close guard: prevent an agent from closing its own session.
            if let Some(sid) = mcp_session_id
                && let Some(own_pty) = state.mcp_to_session.get(sid)
                && own_pty.value() == session_id
            {
                return serde_json::json!({"error": "Cannot close own session. Use exit to terminate yourself."});
            }
            // Uses the same tombstone path as the Tauri close_pty command so
            // post-mortem MCP reads keep returning final output + exit code.
            // Idempotent: returns ok even if session was already tombstoned.
            let existed = crate::pty::close_pty_core(state, session_id, false).is_some()
                || state.vt_log_buffers.contains_key(session_id);
            if existed {
                // Notify frontend and SSE consumers so the tab is removed from
                // the UI. Without this the reader thread's EOF-driven
                // session-closed event may never fire (the cloned reader fd
                // keeps the pty master alive after close_pty_core drops it).
                state.emit_pty_event(crate::state::AppEvent::SessionClosed {
                    session_id: session_id.to_string(),
                    reason: "closed".to_string(),
                });
                #[cfg(feature = "desktop")]
                if let Some(app) = state.app_handle.read().as_ref() {
                    let _ = app.emit(
                        "session-closed",
                        serde_json::json!({
                            "session_id": session_id,
                            "reason": "closed",
                        }),
                    );
                }
            }
            // SIMP-1: drain HTML tabs registered by this session and emit close.
            emit_close_html_tabs(state.as_ref(), session_id);
            serde_json::json!({"ok": true})
        }
        "kill" => {
            let session_id = match require_session_id(args, "kill") {
                Ok(id) => id,
                Err(e) => return e,
            };
            // Self-kill guard: mirror the close branch — an agent must not SIGKILL itself.
            if let Some(sid) = mcp_session_id
                && let Some(own_pty) = state.mcp_to_session.get(sid)
                && own_pty.value() == session_id
            {
                return serde_json::json!({"error": "Cannot kill own session. Use exit to terminate yourself."});
            }
            if crate::pty::kill_pty_core(state, session_id) {
                tracing::info!(source = "session", session_id = %session_id, "Session killed: SIGKILL");
                state.emit_pty_event(crate::state::AppEvent::SessionClosed {
                    session_id: session_id.to_string(),
                    reason: "killed".to_string(),
                });
                #[cfg(feature = "desktop")]
                if let Some(app) = state.app_handle.read().as_ref() {
                    let _ = app.emit(
                        "session-closed",
                        serde_json::json!({
                            "session_id": session_id,
                            "reason": "killed",
                        }),
                    );
                }
                // SIMP-1: drain HTML tabs registered by this session and emit close.
                emit_close_html_tabs(state, session_id);
                serde_json::json!({"ok": true})
            } else {
                serde_json::json!({"error": "Session not found"})
            }
        }
        "pause" => {
            let session_id = match require_session_id(args, "pause") {
                Ok(id) => id,
                Err(e) => return e,
            };
            let entry = match state.sessions.get(session_id) {
                Some(e) => e,
                None => return serde_json::json!({"error": "Session not found"}),
            };
            entry.lock().paused.store(true, Ordering::Relaxed);
            serde_json::json!({"ok": true})
        }
        "resume" => {
            let session_id = match require_session_id(args, "resume") {
                Ok(id) => id,
                Err(e) => return e,
            };
            let entry = match state.sessions.get(session_id) {
                Some(e) => e,
                None => return serde_json::json!({"error": "Session not found"}),
            };
            entry.lock().paused.store(false, Ordering::Relaxed);
            serde_json::json!({"ok": true})
        }
        "status" => {
            let session_id = match require_session_id(args, "status") {
                Ok(id) => id,
                Err(e) => return e,
            };
            match state.session_state_with_shell(session_id) {
                Some(ss) => {
                    let exit_code = state.exit_codes.get(session_id).map(|e| *e.value());
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let since_ms = state
                        .shell_state_since_ms
                        .get(session_id)
                        .map(|a| a.load(std::sync::atomic::Ordering::Relaxed))
                        .unwrap_or(0);
                    let elapsed = if since_ms > 0 {
                        now_ms.saturating_sub(since_ms)
                    } else {
                        0
                    };
                    let is_idle = ss.shell_state.as_deref() == Some("idle");
                    let is_busy = ss.shell_state.as_deref() == Some("busy");
                    let delivery_uncertain = state
                        .silence_states
                        .get(session_id)
                        .map(|silence| silence.lock().injection_delivery_uncertain)
                        .unwrap_or(false);
                    #[cfg(unix)]
                    let standby = state.standby_sessions.contains_key(session_id);
                    #[cfg(not(unix))]
                    let standby = false;
                    let mut response = serde_json::json!({
                        "session_id": session_id,
                        "background_work": ss.background_work,
                        "awaiting_input": ss.awaiting_input,
                        "rate_limited": ss.rate_limited,
                        "delivery_uncertain": delivery_uncertain,
                        "last_activity_ms": ss.last_activity_ms,
                        "standby": standby,
                    });
                    let object = response
                        .as_object_mut()
                        .expect("session status response is an object");
                    insert_optional_value(
                        object,
                        "shell_state",
                        ss.shell_state.map(serde_json::Value::String),
                    );
                    insert_optional_value(
                        object,
                        "agent_state",
                        ss.agent_state.map(serde_json::Value::String),
                    );
                    insert_optional_value(
                        object,
                        "agent_type",
                        ss.agent_type.map(serde_json::Value::String),
                    );
                    insert_optional_value(
                        object,
                        "exit_code",
                        exit_code.map(serde_json::Value::from),
                    );
                    insert_optional_value(
                        object,
                        "idle_since_ms",
                        (is_idle && elapsed > 0).then(|| serde_json::json!(elapsed)),
                    );
                    insert_optional_value(
                        object,
                        "busy_duration_ms",
                        (is_busy && elapsed > 0).then(|| serde_json::json!(elapsed)),
                    );
                    response
                }
                None => serde_json::json!({"error": format!("Session '{}' not found", session_id)}),
            }
        }
        "process_stats" => {
            let stats = crate::pty::collect_process_stats(state);
            serde_json::json!({ "processes": stats })
        }
        other => serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'session'. Available: {}", other, SESSION_ACTIONS
        )}),
    }
}

async fn handle_github(state: &Arc<AppState>, args: &serde_json::Value) -> serde_json::Value {
    let action = match require_action(args, "github", LEGACY_GITHUB_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    match action {
        "prs" => {
            let path = match require_path(args, "prs") {
                Ok(p) => p,
                Err(e) => return e,
            };
            if let Err(e) = validate_mcp_repo_path(&path) {
                return e;
            }
            let statuses = if let Some(cached) = state.git_cache.github_status.get(&path) {
                Ok((*cached).clone())
            } else {
                crate::github::get_repo_pr_statuses_impl(&path, false, state).await
            };
            to_json_or_error(statuses)
        }
        "status" => {
            // Cross-repo aggregate: for each workspace repo, return branch/ahead/behind/open PRs
            // Reads from poller cache to avoid fan-out API calls
            let repo_data = crate::config::load_repositories();
            let repo_order = repo_data
                .get("repoOrder")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let mut results: Vec<serde_json::Value> = Vec::new();
            for path_val in &repo_order {
                let Some(path) = path_val.as_str() else {
                    continue;
                };
                let info = crate::git::get_repo_info_cached(state, path);
                if !info.is_git_repo {
                    continue;
                }
                let gh = crate::github::get_github_status_cached(state, path);
                let cached_prs: Vec<crate::github::BranchPrStatus> = state
                    .git_cache
                    .github_status
                    .get(path)
                    .map(|a| (*a).clone())
                    .unwrap_or_default();
                let open_prs = cached_prs.len();
                let failing_ci = cached_prs.iter().filter(|p| p.checks.failed > 0).count();
                results.push(serde_json::json!({
                    "path": path,
                    "branch": info.branch,
                    "status": info.status,
                    "ahead": gh.ahead,
                    "behind": gh.behind,
                    "open_prs": open_prs,
                    "failing_ci": failing_ci,
                }));
            }
            serde_json::json!(results)
        }
        "issues" => {
            let path = match require_path(args, "issues") {
                Ok(p) => p,
                Err(e) => return e,
            };
            if let Err(e) = validate_mcp_repo_path(&path) {
                return e;
            }
            let filter = args
                .get("filter")
                .and_then(|v| v.as_str())
                .unwrap_or("assigned");
            let result =
                crate::github::get_all_issues_impl(std::slice::from_ref(&path), filter, state)
                    .await;
            match result {
                Ok(mut map) => serde_json::json!(map.remove(&path).unwrap_or_default()),
                Err(e) => serde_json::json!({"error": e}),
            }
        }
        "close_issue" => {
            let path = match require_path(args, "close_issue") {
                Ok(p) => p,
                Err(e) => return e,
            };
            if let Err(e) = validate_mcp_repo_path(&path) {
                return e;
            }
            let issue_number = args
                .get("issue_number")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            if issue_number == 0 {
                return serde_json::json!({"error": "Missing required parameter: issue_number"});
            }
            match crate::github::close_issue_impl(&path, issue_number, state).await {
                Ok(()) => serde_json::json!({"ok": true}),
                Err(e) => serde_json::json!({"error": e}),
            }
        }
        "reopen_issue" => {
            let path = match require_path(args, "reopen_issue") {
                Ok(p) => p,
                Err(e) => return e,
            };
            if let Err(e) = validate_mcp_repo_path(&path) {
                return e;
            }
            let issue_number = args
                .get("issue_number")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            if issue_number == 0 {
                return serde_json::json!({"error": "Missing required parameter: issue_number"});
            }
            match crate::github::reopen_issue_impl(&path, issue_number, state).await {
                Ok(()) => serde_json::json!({"ok": true}),
                Err(e) => serde_json::json!({"error": e}),
            }
        }
        other => serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'github'. Available: {}", other, LEGACY_GITHUB_ACTIONS
        )}),
    }
}

/// Create a PTY session in the given directory, returning the session ID.
/// Reuses the same setup as `session action=create` but with fixed defaults.
fn create_session_in_dir(state: &Arc<AppState>, cwd: &str) -> Result<String, String> {
    let shell = resolve_shell(None);
    super::session::spawn_pty_session(
        state.clone(),
        shell,
        Some(cwd.to_string()),
        24,
        80,
        None,
        None,
    )
    .map_err(|(_, body)| {
        body.0
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("spawn failed")
            .to_string()
    })
}

fn worktree_remove_success_response(branch_delete_warning: Option<String>) -> serde_json::Value {
    let mut response = serde_json::json!({"ok": true});
    insert_optional_value(
        response
            .as_object_mut()
            .expect("worktree remove response is an object"),
        "branch_delete_warning",
        branch_delete_warning.map(serde_json::Value::String),
    );
    response
}

async fn handle_worktree(
    state: &Arc<AppState>,
    args: &serde_json::Value,
    is_claude_code: bool,
) -> serde_json::Value {
    let action = match require_action(args, "worktree", LEGACY_WORKTREE_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    match action {
        "list" => {
            let path = match require_path(args, "list") {
                Ok(p) => p,
                Err(e) => return e,
            };
            if let Err(e) = validate_mcp_repo_path(&path) {
                return e;
            }
            match crate::worktree::get_worktree_paths(path) {
                Ok(wts) => to_json_or_error(wts),
                Err(e) => serde_json::json!({"error": e}),
            }
        }
        "create" => {
            let path = match require_path(args, "create") {
                Ok(p) => p,
                Err(e) => return e,
            };
            if let Err(e) = validate_mcp_repo_path(&path) {
                return e;
            }
            let branch = args["branch"].as_str().map(|s| s.to_string());
            let base_ref = args["base_ref"].as_str().map(|s| s.to_string());

            // Generate a branch name if not specified
            let branch_name = branch.unwrap_or_else(|| {
                let existing: Vec<String> = match crate::worktree::get_worktree_paths(path.clone())
                {
                    Ok(wts) => wts.keys().cloned().collect(),
                    Err(e) => {
                        tracing::warn!("Failed to list worktrees for name generation: {e}");
                        vec![]
                    }
                };
                crate::worktree::generate_worktree_name(&existing)
            });

            match super::worktree_routes::create_worktree_shared(
                state,
                path.clone(),
                branch_name,
                base_ref,
            )
            .await
            {
                Ok(created) => {
                    let wt_path = created.path;
                    let branch_name = created.branch;
                    let mut response = serde_json::json!({
                        "worktree_path": &wt_path,
                        "branch": &branch_name,
                    });
                    // Optionally spawn a PTY session in the new worktree
                    if args["spawn_session"].as_bool().unwrap_or(false) {
                        match create_session_in_dir(state, &wt_path) {
                            Ok(sid) => {
                                response["session_id"] = serde_json::json!(sid);
                            }
                            Err(e) => {
                                response["session_error"] = serde_json::json!(e);
                            }
                        }
                    }
                    if let Some(setup_script) = created.setup_script {
                        response["setup_script"] = setup_script;
                    }
                    if let Some(setup_script_error) = created.setup_script_error {
                        response["setup_script_error"] = setup_script_error;
                    }
                    // Add structured hint for Claude Code clients to spawn a subagent in the worktree
                    if is_claude_code {
                        // Sanitize branch name to prevent prompt injection via backticks/newlines
                        let safe_branch = branch_name.replace('`', "'").replace('\n', " ");
                        response["cc_agent_hint"] = serde_json::json!({
                            "worktree_path": wt_path,
                            "suggested_prompt": format!(
                                "Work in the worktree at `{}`. Use absolute paths for ALL file operations \
                                (Read, Edit, Glob, Grep). For git commands, use `cd {} && git ...`. \
                                The branch is `{}`.",
                                wt_path, wt_path, safe_branch,
                            )
                        });
                    }
                    response
                }
                Err((_status, body)) => body.0,
            }
        }
        "remove" => {
            let path = match require_path(args, "remove") {
                Ok(p) => p,
                Err(e) => return e,
            };
            if let Err(e) = validate_mcp_repo_path(&path) {
                return e;
            }
            let branch = match args["branch"].as_str() {
                Some(b) => b.to_string(),
                None => {
                    return serde_json::json!({"error": "Action 'remove' requires 'branch' parameter"});
                }
            };
            let archive = crate::worktree::resolve_archive_script(&path);
            match crate::worktree::remove_worktree_by_branch(
                &path,
                &branch,
                true,
                archive.as_deref(),
                false,
            ) {
                Ok(outcome) => {
                    state.notify_worktree_removed(&path, &branch);
                    worktree_remove_success_response(outcome.branch_delete_warning)
                }
                Err(e) => serde_json::json!({"error": e}),
            }
        }
        other => serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'worktree'. Available: {}", other, LEGACY_WORKTREE_ACTIONS
        )}),
    }
}

/// Build the full prompt for a spawned agent.
/// Prepends multi-agent context when the caller is a registered peer so the child
/// knows its identity and how to communicate back. Returns the original prompt
/// unchanged when called outside a multi-agent context (`parent_tuic` is `None`).
fn build_spawn_prompt(
    prompt: &str,
    parent_tuic: Option<&str>,
    session_id: &str,
    peer_name: &str,
) -> String {
    let Some(parent) = parent_tuic else {
        return prompt.to_string();
    };
    format!(
        "## FastAF Multi-Agent Context\n\
         You are operating as a managed peer. There is no separate swarm action; use the agent and session primitives.\n\
         - You are pre-registered as peer `{peer_name}`.\n\
         - Your session ID (`$TUIC_SESSION`): `{session_id}`\n\
         - Your parent agent session: `{parent}`\n\n\
         FastAF already created your peer identity and inbox. If an MCP\n\
         reconnect reports that you are unregistered, repair the binding with:\n\
         `agent action=register tuic_session=\"{session_id}\" name=\"{peer_name}\"`\n\n\
         You can communicate with your parent at any time, and must report task\n\
         completion or a real blocker with:\n\
         `agent action=send to=\"{parent}\" message=\"<done summary>\"`\n\n\
         ## Your Task\n\n\
         {prompt}"
    )
}

fn resolve_effective_spawn_cwd(
    state: &AppState,
    explicit_cwd: Option<&str>,
    managed_parent_cwd: Option<&str>,
    caller_tuic: Option<&str>,
    mcp_session_id: Option<&str>,
) -> Option<String> {
    explicit_cwd
        .map(str::to_string)
        .or_else(|| {
            caller_tuic.and_then(|parent| {
                state
                    .sessions
                    .get(parent)
                    .and_then(|session| session.lock().cwd.clone())
            })
        })
        // The bridge header identifies the actual managed PTY when no verified
        // caller binding exists. A conflicting bound caller rejects this hint
        // before resolution reaches this function.
        .or_else(|| managed_parent_cwd.map(str::to_string))
        // Non-managed clients have no PTY header; initialize roots remain the
        // final repo-scoped fallback.
        .or_else(|| {
            mcp_session_id.and_then(|sid| {
                state
                    .mcp_sessions
                    .get(sid)
                    .and_then(|meta| meta.repo_path.clone())
            })
        })
}

#[cfg(test)]
fn handle_agent(
    state: &Arc<AppState>,
    addr: SocketAddr,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
) -> serde_json::Value {
    handle_agent_with_parent_cwd(state, addr, args, mcp_session_id, None)
}

fn handle_agent_with_parent_cwd(
    state: &Arc<AppState>,
    addr: SocketAddr,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
    managed_parent_cwd: Option<&str>,
) -> serde_json::Value {
    let action = match require_action(args, "agent", LEGACY_AGENT_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    match action {
        "detect" => {
            // Every agent TUIC can launch, not a hand-written subset — a new
            // agent must not be invisible to an orchestrator. Undetected ones
            // are dropped: `detect` answers "what can I spawn here", and a row
            // of nulls is noise an orchestrator cannot act on.
            let results: Vec<serde_json::Value> = crate::agent::KNOWN_AGENT_BINARIES
                .iter()
                .filter_map(|name| {
                    let det = crate::agent::detect_agent_binary(name.to_string());
                    det.path
                        .map(|path| serde_json::json!({"name": name, "path": path, "version": det.version}))
                })
                .collect();
            serde_json::json!(results)
        }
        "spawn" => {
            // Agent spawning is restricted to localhost — matches the HTTP route guard in agent_routes.rs
            if !addr.ip().is_loopback() {
                return serde_json::json!({"error": "Agent spawning is restricted to localhost connections"});
            }
            let prompt = match args["prompt"].as_str() {
                Some(p) => p.to_string(),
                None => return serde_json::json!({"error": "Action 'spawn' requires 'prompt'"}),
            };
            let pty_description = match parse_pty_description(args) {
                Ok(update) => resolve_spawn_pty_description(update, &prompt),
                Err(error) => return error,
            };
            if state.sessions.len() >= MAX_CONCURRENT_SESSIONS {
                return serde_json::json!({"error": "Max concurrent sessions reached"});
            }

            // Resolve agent binary — run config name takes priority, then literal agent type
            let agents_cfg = crate::config::load_agents_config();
            let (binary_path, resolved) = if let Some(path) = args["binary_path"].as_str() {
                let expanded = crate::cli::expand_tilde(path);
                let p = std::path::Path::new(&expanded);
                if !p.is_absolute() {
                    return serde_json::json!({"error": "binary_path must be an absolute path"});
                }
                if !p.is_file() {
                    return serde_json::json!({"error": "binary_path does not point to an existing file"});
                }
                (expanded, None)
            } else {
                let agent_type_raw = args["agent_type"].as_str().unwrap_or("claude");
                let rc = resolve_run_config(agent_type_raw, &agents_cfg);
                let bin_raw = rc.command.as_deref().unwrap_or(&rc.agent_type);
                let bin = crate::cli::expand_tilde(bin_raw);
                let detection = crate::agent::detect_agent_binary(bin.clone());
                match detection.path {
                    Some(p) => (p, Some(rc)),
                    None => {
                        return serde_json::json!({"error": format!("Agent binary '{}' not found", bin)});
                    }
                }
            };

            let rows = args["rows"].as_u64().unwrap_or(24) as u16;
            let cols = args["cols"].as_u64().unwrap_or(80) as u16;
            if let Err(msg) = super::validate_terminal_size(rows, cols) {
                return serde_json::json!({"error": msg});
            }

            // Canonical agent type for this spawn: a resolved direct Codex
            // executable wins over the configured bucket; otherwise use the run
            // config key or raw agent_type. Pre-set below so argv finalization,
            // parser gates, hooks, and session events share one CLI identity.
            let configured_agent_type: Option<String> = resolved
                .as_ref()
                .map(|rc| rc.agent_type.clone())
                .or_else(|| args["agent_type"].as_str().map(|s| s.to_string()));
            let effective_agent_type =
                resolve_spawn_agent_type(&binary_path, configured_agent_type.as_deref());
            let codex_wrapper_warning =
                codex_wrapper_launch_warning(effective_agent_type.as_deref(), &binary_path);

            let requested_name = match args.get("name") {
                Some(value) => match value.as_str().map(str::trim) {
                    Some("") | None => {
                        return serde_json::json!({"error": "Action 'spawn' requires 'name' to be a non-empty string when provided"});
                    }
                    Some(name) => Some(name.to_string()),
                },
                None => None,
            };
            let peer_name = requested_name
                .clone()
                .unwrap_or_else(|| "agent".to_string());

            let session_id = Uuid::new_v4().to_string();

            // Resolve caller's tuic_session from their MCP session via the O(1) reverse map.
            // Only set when caller is a registered peer — drives multi-agent context + TUIC_PARENT.
            let caller_tuic: Option<String> = mcp_session_id
                .and_then(|sid| state.mcp_to_session.get(sid).map(|e| e.value().clone()));

            // Effective prompt: context prepended for managed-peer spawns, unchanged otherwise.
            let effective_prompt =
                build_spawn_prompt(&prompt, caller_tuic.as_deref(), &session_id, &peer_name);

            // Effective cwd: an explicit `cwd` arg wins; otherwise inherit the SPAWNING
            // agent's working dir (its PTY session's cwd). Without this the child runs in
            // the TUIC process's own cwd AND its session carries no cwd, so the frontend
            // `session-created` handler can't match it to the parent's repo and drops the
            // tab into whatever repo the desktop user has focused (the active-repo
            // fallback). Inheriting the parent cwd lands both the process and the tab in
            // the parent agent's repo.
            let effective_cwd = resolve_effective_spawn_cwd(
                state,
                args["cwd"].as_str(),
                managed_parent_cwd,
                caller_tuic.as_deref(),
                mcp_session_id,
            );

            let mut cmd = CommandBuilder::new(&binary_path);
            crate::pty::sanitize_pty_parent_env(&mut cmd);

            // Inject peer env vars so spawned agents know their identity and parent.
            cmd.env("TUIC_SESSION", &session_id);
            if let Some(ref parent) = caller_tuic {
                cmd.env("TUIC_PARENT", parent);
            }

            // Inject run config env vars
            if let Some(ref rc) = resolved {
                for (k, v) in &rc.env {
                    cmd.env(k, v);
                }
            }

            // Initial prompt withheld from argv for prefill-only TUIs (codex):
            // queued into pending_injections after session registration below.
            let mut deferred_initial_prompt: Option<String> = None;

            if let Some(raw_args) = args.get("args").and_then(|a| a.as_array()) {
                // Explicit args remain authoritative when they contain
                // `{prompt}` (for example `codex exec {prompt}`). When they are
                // flags only, the required spawn prompt must still be delivered:
                // append it for normal CLIs, or defer it through PTY injection
                // for prefill-only TUIs such as interactive Codex.
                let explicit_args: Vec<String> = raw_args
                    .iter()
                    .filter_map(|arg| arg.as_str().map(ToOwned::to_owned))
                    .collect();
                let agent_type = effective_agent_type.as_deref().unwrap_or_default();
                let (final_args, deferred) = match compose_mcp_spawn_args(McpSpawnArgs {
                    agent_type,
                    binary_path: &binary_path,
                    args: &explicit_args,
                    prompt: &effective_prompt,
                    model: args["model"].as_str(),
                    print_mode: args["print_mode"].as_bool().unwrap_or(false),
                    output_format: args["output_format"].as_str(),
                    default_template: false,
                }) {
                    Ok(m) => m,
                    Err(e) => return serde_json::json!({"error": e}),
                };
                deferred_initial_prompt = deferred;
                for arg in &final_args {
                    cmd.arg(arg);
                }
            } else if let Some(ref rc) = resolved {
                if let Some(ref rc_args) = rc.args {
                    // Run config matched: user-authored argv remains authoritative.
                    // Merge structured MCP params, apply only executable-safe
                    // defaults, then preserve the established prompt substitution
                    // or positional append semantics. In particular, wrapper and
                    // subcommand configs must not be rewritten into PTY delivery.
                    let agent_type = effective_agent_type.as_deref().unwrap_or_default();
                    let final_args = match compose_mcp_run_config_args(
                        agent_type,
                        &binary_path,
                        rc_args,
                        &effective_prompt,
                        args["model"].as_str(),
                        args["print_mode"].as_bool().unwrap_or(false),
                        args["output_format"].as_str(),
                    ) {
                        Ok(m) => m,
                        Err(e) => return serde_json::json!({"error": e}),
                    };
                    for arg in &final_args {
                        cmd.arg(arg);
                    }
                } else {
                    // No run config args: use the built-in per-agent template
                    // (mirrors the shipped frontend spawnArgs) so cross-agent
                    // spawns work out of the box; only truly unknown agents fail,
                    // with a copy-pasteable example. Claude rides the same table
                    // (story 092) — merge's claude flags-first rule keeps its
                    // argv byte-identical to the retired dedicated branch.
                    let agent_type = effective_agent_type.as_deref().unwrap_or_default();
                    match crate::agent::default_prompt_args(agent_type) {
                        Some(template) => {
                            let (final_args, deferred) =
                                match compose_mcp_spawn_args(McpSpawnArgs {
                                    agent_type,
                                    binary_path: &binary_path,
                                    args: &template,
                                    prompt: &effective_prompt,
                                    model: args["model"].as_str(),
                                    print_mode: args["print_mode"].as_bool().unwrap_or(false),
                                    output_format: args["output_format"].as_str(),
                                    default_template: true,
                                }) {
                                    Ok(m) => m,
                                    Err(e) => return serde_json::json!({"error": e}),
                                };
                            deferred_initial_prompt = deferred;
                            for arg in &final_args {
                                cmd.arg(arg);
                            }
                        }
                        None => {
                            return serde_json::json!({"error": format!(
                                "Don't know how to spawn agent '{name}' with a prompt. Pass explicit args with a {{prompt}} placeholder, e.g. args=[\"--message\", \"{{prompt}}\"], or configure a run config named '{name}' in Settings -> Agents.",
                                name = rc.agent_type
                            )});
                        }
                    }
                }
            } else {
                // No run config, no explicit args — default MCP param logic
                if is_direct_codex_executable(&binary_path) {
                    let template = crate::agent::default_prompt_args("codex").unwrap_or_default();
                    let (final_args, deferred) = match compose_mcp_spawn_args(McpSpawnArgs {
                        agent_type: "codex",
                        binary_path: &binary_path,
                        args: &template,
                        prompt: &effective_prompt,
                        model: args["model"].as_str(),
                        print_mode: args["print_mode"].as_bool().unwrap_or(false),
                        output_format: args["output_format"].as_str(),
                        default_template: true,
                    }) {
                        Ok(m) => m,
                        Err(e) => return serde_json::json!({"error": e}),
                    };
                    deferred_initial_prompt = deferred;
                    for arg in &final_args {
                        cmd.arg(arg);
                    }
                } else {
                    if args["print_mode"].as_bool().unwrap_or(false) {
                        cmd.arg("--print");
                    }
                    if let Some(format) = args["output_format"].as_str() {
                        cmd.arg("--output-format");
                        cmd.arg(format);
                    }
                    if let Some(model) = args["model"].as_str() {
                        cmd.arg("--model");
                        cmd.arg(model);
                    }
                    cmd.arg(&effective_prompt);
                }
            }
            if let Some(ref cwd) = effective_cwd {
                cmd.cwd(crate::cli::expand_tilde(cwd));
            }

            // The argv assembly above can bail out with an error response, so it
            // cannot live inside the retry closure; the built command is cloned
            // per attempt instead (`spawn_command` consumes it).
            let (pair, child) = match crate::pty::spawn_pty_pair_with_retry(
                PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                || cmd.clone(),
            ) {
                Ok(pair_and_child) => pair_and_child,
                Err(e) => return serde_json::json!({"error": e}),
            };
            let writer = match pair.master.take_writer() {
                Ok(w) => w,
                Err(e) => {
                    return serde_json::json!({"error": format!("Failed to get PTY writer: {}", e)});
                }
            };
            let reader = match pair.master.try_clone_reader() {
                Ok(r) => r,
                Err(e) => {
                    return serde_json::json!({"error": format!("Failed to get PTY reader: {}", e)});
                }
            };

            let paused = Arc::new(AtomicBool::new(false));
            state.sessions.insert(
                session_id.clone(),
                Mutex::new(PtySession {
                    writer: Arc::new(Mutex::new(writer)),
                    master: pair.master,
                    _child: child,
                    paused: paused.clone(),
                    worktree: None,
                    cwd: effective_cwd.clone(),
                    display_name: requested_name.clone(),
                    display_name_is_custom: false,
                    is_remote: true,
                    shell: binary_path.clone(),
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
                Mutex::new(VtLogBuffer::new(24, 220, VT_LOG_BUFFER_CAPACITY)),
            );
            state
                .last_output_ms
                .insert(session_id.clone(), std::sync::atomic::AtomicU64::new(0));
            // Pre-set the session's agent type (mirrors session.rs spawn_pty_session)
            // so agent_active_for_parse is true from the first output chunk and
            // intent/suggest tokens are parsed without waiting on foreground polling.
            let mut session_state = crate::state::SessionState::default();
            if effective_agent_type.is_some() {
                session_state.hook_instrumented =
                    crate::pty::hook_instrumented_for(&agents_cfg, effective_agent_type.as_deref());
                session_state.agent_type = effective_agent_type.clone();
            }
            state
                .session_states
                .insert(session_id.clone(), session_state);
            // Prefill-only TUIs (codex): the task was withheld from argv — queue it
            // now so the BUSY→IDLE flush types it (text + CR) the moment the child's
            // TUI reaches its ready prompt. Queued AFTER session_states is inserted:
            // flush_pending_injections requires agent_type to treat this session as
            // an injectable agent. Same delivery path as peer messages (story 091).
            if let Some(initial_prompt) = deferred_initial_prompt {
                state
                    .pending_initial_prompts
                    .insert(session_id.clone(), initial_prompt.clone());
                state
                    .pending_injections
                    .entry(session_id.clone())
                    .or_default()
                    .push_back(crate::state::PendingInjection::peer_message(initial_prompt));
            }
            // Register grid_watch so format=grid WebSocket streams work for
            // MCP-spawned agent sessions (mirrors session.rs spawn_pty_session).
            let grid_watch_tx = crate::grid_gate::new_grid_watch();
            state.grid_watch.insert(session_id.clone(), grid_watch_tx);

            // Broadcast session-created to SSE/WebSocket consumers
            let cwd_str = effective_cwd.clone();
            let agent_type_str = effective_agent_type.clone();
            state.emit_pty_event(crate::state::AppEvent::SessionCreated {
                session_id: session_id.clone(),
                cwd: cwd_str.clone(),
                agent_type: agent_type_str,
                display_name: requested_name.clone(),
            });

            #[cfg(feature = "desktop")]
            {
                let print_mode = args["print_mode"].as_bool().unwrap_or(false);
                let app_handle = state.app_handle.read().clone();
                if !print_mode && let Some(ref app) = app_handle {
                    let agent_type_val = effective_agent_type.as_deref();
                    let _ = app.emit(
                        "session-created",
                        serde_json::json!({
                            "session_id": session_id,
                            "cwd": cwd_str,
                            "agent_type": agent_type_val,
                            "display_name": requested_name,
                        }),
                    );
                }
            }
            state.set_pty_description(&session_id, pty_description);
            spawn_reader_thread(reader, paused, session_id.clone(), state.clone(), None);

            // Every managed child is a peer immediately, independent of whether
            // its initial prompt runs or its own MCP bridge has connected yet.
            state.peer_agents.insert(
                session_id.clone(),
                crate::state::PeerAgent {
                    tuic_session: session_id.clone(),
                    mcp_session_id: String::new(), // filled when child connects via MCP
                    name: peer_name.clone(),
                    project: effective_cwd.clone(),
                    registered_at: now_unix_ms(),
                },
            );
            state.agent_inbox.entry(session_id.clone()).or_default();

            // Bidirectional communication additionally needs an identified
            // parent. The child receives TUIC_PARENT + the spawn preamble; the
            // parent receives the child target in the response below.
            if let Some(parent_id) = caller_tuic
                .clone()
                .or_else(|| mcp_session_id.map(pending_parent_id))
            {
                state.session_parent.insert(session_id.clone(), parent_id);
                if state.pending_initial_prompts.contains_key(&session_id) {
                    let watchdog_state = Arc::clone(state);
                    let watchdog_session = session_id.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(INITIAL_PROMPT_DELIVERY_TIMEOUT).await;
                        crate::pty::notify_initial_prompt_timeout_if_pending(
                            &watchdog_state,
                            &watchdog_session,
                        );
                    });
                }
            }

            let spawn_ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            // Keep the legacy `monitor_with` field for compatibility, but mark
            // raw session output as an anomaly fallback. The peer-only
            // `peer_monitor_with` is an additive hint included only when the
            // caller is a registered orchestrator — children auto-register as
            // peers and post {type:state_change} to the parent's inbox; the
            // result-via-send guidance lives in agent(register).workflow and the
            // compatibility output hint is explicitly marked anomaly-only.
            // Durable handle for this spawn. Created only after the PTY is live, so
            // every early return above (loopback guard, bad binary, spawn failure)
            // leaves no task behind. Purely additive in the response: classic MCP
            // clients that ignore `task_id` keep working exactly as before.
            let task_id = state.tasks.create(
                crate::tasks::TaskKind::AgentSpawn,
                &task_owner_identity(caller_tuic.as_deref(), mcp_session_id),
                Some(&session_id),
            );

            let mut response = serde_json::json!({
                "session_id": session_id,
                "task_id": task_id,
                "poll_interval_ms": TASK_POLL_INTERVAL_MS,
                "name": peer_name,
                "peer_registered": true,
                "communication_ready": caller_tuic.is_some(),
                "send_to": session_id,
                "server_ts": spawn_ts,
                "monitor_with": format!("session(action=output, session_id={session_id}) — anomaly fallback only if the child fails to send its result"),
                "status_with": format!("session(action=status, session_id={session_id})"),
                "wait_with": format!("session(action=wait, session_id={session_id}, until=idle) — blocks instead of polling"),
            });
            if let Some(warning) = codex_wrapper_warning
                && let Some(obj) = response.as_object_mut()
            {
                obj.insert("launch_warning".to_string(), serde_json::json!(warning));
            }
            if caller_tuic.is_some()
                && let Some(obj) = response.as_object_mut()
            {
                obj.insert(
                    "parent_session_id".to_string(),
                    serde_json::json!(caller_tuic),
                );
                obj.insert(
                    "peer_monitor_with".to_string(),
                    serde_json::json!(format!("agent(action=inbox, since={spawn_ts})")),
                );
                obj.insert(
                    "peer_wait_with".to_string(),
                    serde_json::json!(format!(
                        "agent(action=wait, since={spawn_ts}) — blocks until mail; lifecycle mail contains state only, and the child must send its task result"
                    )),
                );
            } else if let Some(obj) = response.as_object_mut() {
                obj.insert(
                    "communication_warning".to_string(),
                    serde_json::json!("Caller has no bound TUIC peer identity; child can receive messages, but child-to-parent messaging is unavailable until the parent calls agent action=register. A headerless caller may omit tuic_session."),
                );
            }
            response
        }
        "stats" => {
            let stats = state.orchestrator_stats();
            to_json_or_error(stats)
        }
        "metrics" => {
            let metrics = state.session_metrics_json();
            to_json_or_error(metrics)
        }
        other => serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'agent'. Available: {}", other, LEGACY_AGENT_ACTIONS
        )}),
    }
}

/// Poll or cancel a task handle. Non-blocking by design: this is what lifts the
/// 300s ceiling on `agent wait`, so it must never wait on anything itself.
fn handle_task(
    state: &Arc<AppState>,
    addr: SocketAddr,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
) -> serde_json::Value {
    let action = match require_action(args, "task", LEGACY_TASK_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    let task_id = match require_string(args, "task_id") {
        Ok(id) => id,
        Err(e) => return e,
    };
    if !matches!(action, "get" | "cancel") {
        return serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'task'. Available: {}", action, LEGACY_TASK_ACTIONS
        )});
    }

    let caller_tuic: Option<String> =
        mcp_session_id.and_then(|sid| state.mcp_to_session.get(sid).map(|e| e.value().clone()));
    let identities = caller_task_identities(caller_tuic.as_deref(), mcp_session_id);

    // A task handle is a capability over a spawned agent, so ownership is checked
    // before any state is returned or mutated — one agent must not be able to
    // inspect or cancel another's children.
    let rec = match state.tasks.get(task_id) {
        Some(rec) if identities.contains(&rec.owner) => rec,
        Some(_) => {
            return serde_json::json!({"error": "task_id is not owned by the calling identity"});
        }
        None => return serde_json::json!({"error": "unknown or expired task_id"}),
    };

    if action == "cancel" {
        // Same loopback restriction as `agent spawn`: cancelling mutates another
        // agent's orchestration state, so a remote MCP client must not reach it.
        if !addr.ip().is_loopback() {
            return serde_json::json!({
                "error": "Task cancellation is restricted to localhost connections"
            });
        }
        return match state.tasks.cancel(&rec.task_id) {
            Ok(()) => serde_json::json!({
                "task_id": rec.task_id,
                "status": crate::tasks::TaskStatus::Cancelled.as_str(),
                "cancelled": true,
                "note": "The agent process is untouched — use session(action=kill) to stop it.",
            }),
            // Already finished: report the state that stands rather than an error,
            // so a cancel racing the agent's exit is not a failure for the caller.
            Err(crate::tasks::TaskError::Terminal(status)) => serde_json::json!({
                "task_id": rec.task_id,
                "status": status.as_str(),
                "cancelled": false,
                "note": "Task already finished; terminal states are immutable.",
            }),
            Err(crate::tasks::TaskError::NotFound) => {
                serde_json::json!({"error": "unknown or expired task_id"})
            }
        };
    }

    // Absent optional fields are omitted, not null — same convention as session
    // and agent responses.
    let mut response = serde_json::json!({
        "task_id": rec.task_id,
        "status": rec.status.as_str(),
        "poll_interval_ms": TASK_POLL_INTERVAL_MS,
    });
    let obj = response
        .as_object_mut()
        .expect("literal above is an object");
    if let Some(message) = rec.status_message {
        obj.insert("status_message".to_string(), serde_json::json!(message));
    }
    if let Some(result) = rec.result {
        obj.insert("result".to_string(), result);
    }
    if let Some(error) = rec.error {
        obj.insert("error_detail".to_string(), serde_json::json!(error));
    }
    response
}

fn resolve_registration_identity(
    state: &AppState,
    args: &serde_json::Value,
    mcp_sid: &str,
) -> Result<(String, bool), serde_json::Value> {
    let current = state
        .mcp_to_session
        .get(mcp_sid)
        .map(|entry| entry.value().clone());
    if let Some(explicit) = args["tuic_session"]
        .as_str()
        .filter(|value| !value.is_empty())
    {
        if !is_valid_uuid(explicit) {
            return Err(serde_json::json!({
                "error": "tuic_session must be a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)"
            }));
        }
        // Authority, not mere difference. An identity that resolves to a live PTY
        // outranks one that does not: the caller announcing its real `$TUIC_SESSION`
        // after having registered an invented UUID is repairing itself, and refusing
        // that leaves an orchestrator permanently unreachable through its terminal.
        if let Some(bound) = current.as_deref().filter(|bound| *bound != explicit) {
            if state.live_pty_for_peer(bound).is_some() {
                return Err(serde_json::json!({
                    "error": format!(
                        "This MCP session is bound to '{bound}', which owns a live terminal. \
                         That is your $TUIC_SESSION — register it instead of '{explicit}', \
                         or omit tuic_session entirely. An identity with no PTY behind it \
                         can never be typed into or woken."
                    )
                }));
            }
            if state.live_pty_for_peer(explicit).is_none() {
                return Err(serde_json::json!({
                    "error": "This MCP session is already bound to a different peer identity"
                }));
            }
        }
        return Ok((explicit.to_string(), false));
    }
    if let Some(current) = current {
        return Ok((current, false));
    }
    Ok((Uuid::new_v4().to_string(), true))
}

fn managed_recipient_state(state: &AppState, tuic_session: &str) -> Option<serde_json::Value> {
    let _session = state.sessions.get(tuic_session)?;
    let snapshot = state.session_state_with_shell(tuic_session);
    let mut summary = serde_json::Map::new();
    if let Some(snapshot) = snapshot {
        insert_optional_value(
            &mut summary,
            "shell_state",
            snapshot.shell_state.map(serde_json::Value::String),
        );
        insert_optional_value(
            &mut summary,
            "agent_state",
            snapshot.agent_state.map(serde_json::Value::String),
        );
    }
    Some(serde_json::Value::Object(summary))
}

fn handle_messaging(
    state: &Arc<AppState>,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
) -> serde_json::Value {
    let action = match require_action(args, "messaging", LEGACY_MESSAGING_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    match action {
        "register" => {
            let mcp_sid = match mcp_session_id {
                Some(sid) => sid.to_string(),
                None => {
                    // Reached by a stateless caller now that tools/call no longer
                    // gates on the header (#0f44). Registration keys the identity on
                    // the protocol session, so it cannot mint one from nothing —
                    // say what to do instead of just stating the problem. Making
                    // identity itself stateless is Phase E, not this step.
                    return serde_json::json!({"error": "Registration needs an MCP protocol session, and this request carried no `mcp-session-id`. Run `initialize` first — managed PTYs auto-bind from $TUIC_SESSION. Tools that need no caller identity work without it."});
                }
            };
            let previously_bound = state
                .mcp_to_session
                .get(&mcp_sid)
                .map(|entry| entry.value().clone());
            let (tuic_session, generated_identity) =
                match resolve_registration_identity(state, args, &mcp_sid) {
                    Ok(identity) => identity,
                    Err(error) => return error,
                };
            let existing = state
                .peer_agents
                .get(&tuic_session)
                .map(|peer| (peer.name.clone(), peer.project.clone()));
            let orchestrator = args["orchestrator"].as_bool().unwrap_or_else(|| {
                state.orchestrator_peers.contains(&tuic_session)
                    || previously_bound
                        .as_ref()
                        .is_some_and(|prior| state.orchestrator_peers.contains(prior))
            });
            let name = args["name"]
                .as_str()
                .map(str::to_string)
                .or_else(|| existing.as_ref().map(|(name, _)| name.clone()))
                .unwrap_or_else(|| "agent".to_string());
            let project = args["project"]
                .as_str()
                .map(str::to_string)
                .or_else(|| existing.and_then(|(_, project)| project));
            let now_ms = now_unix_ms();

            // Presence in mcp_sessions is not proof of liveness: protocol sessions
            // have a one-hour TTL. Reconnect may reclaim a stale owner, but not an
            // actually subscribed/recently active one. The check and routing-map
            // replacement share one lock to prevent concurrent takeovers.
            let prior_mcp = match register_peer_identity(
                state,
                &mcp_sid,
                &tuic_session,
                name.clone(),
                project,
                now_ms,
            ) {
                Ok(prior) => prior,
                Err(error) => {
                    // A refused claimant retries; report the first sighting in
                    // full and keep the repeats out of the log.
                    match takeover_rejection_report(&tuic_session, &mcp_sid) {
                        Some(suppressed) => tracing::warn!(
                            source = "agent_msg",
                            event = "live_binding_takeover_rejected",
                            tuic_session = %tuic_session,
                            mcp_session = %mcp_sid,
                            suppressed_since_last_report = suppressed,
                            error = %error,
                            "Refused a register takeover of a live peer identity"
                        ),
                        None => tracing::debug!(
                            source = "agent_msg",
                            event = "live_binding_takeover_rejected",
                            tuic_session = %tuic_session,
                            mcp_session = %mcp_sid,
                            "Refused a register takeover (repeat)"
                        ),
                    }
                    return serde_json::json!({"error": error});
                }
            };
            if let Some(prior_mcp) = prior_mcp {
                tracing::warn!(
                    source = "agent_msg",
                    event = "stale_binding_takeover",
                    tuic_session = %tuic_session,
                    prior_mcp_session = %prior_mcp,
                    mcp_session = %mcp_sid,
                    "Reclaimed stale MCP peer binding after reconnect"
                );
            }
            // Which prior identity is this registration superseding? The implicit
            // answer only exists when the SAME protocol session rebinds. A caller
            // that reconnects and registers a new UUID arrives with no link at all,
            // so its old inbox used to be stranded with nobody told — it must say
            // which identity it replaces. Guessing (by name, by project) is not an
            // option: peer identity decides who may read whose mail.
            let superseded = previously_bound
                .filter(|prior| prior != &tuic_session)
                .or_else(|| {
                    args["replaces"]
                        .as_str()
                        .map(str::to_string)
                        .filter(|prior| prior != &tuic_session)
                        .filter(|prior| state.peer_agents.contains_key(prior))
                });
            let handoff = superseded
                .as_ref()
                .map(|phantom| retire_repaired_phantom_identity(state, phantom, &tuic_session));
            if orchestrator {
                state.orchestrator_peers.insert(tuic_session.clone());
            } else {
                state.orchestrator_peers.remove(&tuic_session);
                state.clear_orchestrator_delivery(&tuic_session);
            }
            let linked_children = link_pending_children_to_parent(state, &mcp_sid, &tuic_session);
            // Identity bindings are security-relevant; record them (no message content).
            tracing::info!(
                source = "agent_msg",
                event = "register",
                tuic_session = %tuic_session,
                mcp_session = %mcp_sid,
                name = %name,
                "Peer registered"
            );
            let _ = state
                .event_bus
                .send(crate::state::AppEvent::PeerRegistered {
                    tuic_session: tuic_session.to_string(),
                    name: name.clone(),
                });
            // Teach the full multi-agent workflow in the register response so the
            // static instructions can stay compact (AC1 token budget). Any agent
            // that registers immediately receives the operational details it needs
            // for spawn/monitor/cleanup.
            // Whether this identity has a terminal behind it. An identity that
            // resolves to no live PTY is a mailbox and nothing more: no `send` can be
            // typed into it and no wake can reach it, so it must say so instead of
            // implying the peer is addressable in the usual sense. That silence is
            // how a self-registered identity with no PTY (headerless bridge, agent
            // launched outside TUIC, invented UUID) ended up losing every reply.
            let has_terminal = state.live_pty_for_peer(&tuic_session).is_some();
            let has_managed_lifecycle = state
                .live_pty_for_peer(&tuic_session)
                .and_then(|session_id| {
                    state
                        .session_states
                        .get(&session_id)
                        .map(|session| session.agent_type.is_some())
                })
                .unwrap_or(false);
            let wake_capability = if orchestrator && has_managed_lifecycle {
                "managed_pty_lifecycle"
            } else {
                "none"
            };
            let mut response = serde_json::json!({
                "ok": true,
                "tuic_session": tuic_session,
                "name": name,
                "linked_children": linked_children,
                "identity_generated": generated_identity,
                "terminal": has_terminal,
                "orchestrator": orchestrator,
                "mail_wake": wake_capability,
                "identity": if !has_terminal {
                    "This identity has NO terminal behind it: nothing can be typed into it and no message can wake it. Incoming mail only lands in your inbox, so you MUST consume it yourself — `agent action=wait` (blocking) or `agent action=inbox`. To be reachable through a terminal, run inside a TUIC-managed PTY so the bridge asserts its $TUIC_SESSION, or let TUIC spawn you with agent action=spawn."
                } else if generated_identity {
                    "This headerless caller now has an MCP-scoped UUID. It is stable for this MCP connection. Supply an explicit UUID on a future connection when cross-reconnect identity stability is required."
                } else {
                    "This MCP session is bound to its managed or explicitly supplied stable UUID."
                },
                "workflow": {
                    "spawn_same_repo": "agent action=spawn prompt=<task> cwd=<repo_path> — returns {session_id, monitor_with, peer_monitor_with?, wait_with}. As orchestrator, prefer wait/inbox over raw session output to avoid token burn.",
                    "spawn_isolated": "repo action=worktree_create path=<repo> branch=<name> spawn_session=true — worktree + PTY in one call.",
                    "monitor": "Use blocking waits instead of polling: agent action=wait (wakes on new mail; the cursor is kept server-side) or session action=wait session_id=<id> until=idle|exited. Task results arrive through agent send/inbox. Use session output only as an anomaly fallback when a child failed to send.",
                    "auto_state_change": "Spawned peers auto-post state only: {type:state_change, state:idle|completed|exited|awaiting_input, session_id, exit_code?, prompt?}. This is not task output. awaiting_input means the child hit an interactive prompt and is parked with nobody at its keyboard — it will NOT progress until you answer it with session action=input (the `prompt` field carries the question). Every child must report its result or blocker with agent action=send; use session output only when a child anomalously failed to send.",
                    "send": "agent action=send to=<peer_tuic_session> message=<text, max 64KB>. The message is always buffered in the inbox. A peer explicitly registered with orchestrator=true keeps payloads out of its active turn and composer; managed idle/completed lifecycle may submit one coalesced, payload-free wake instructing `agent action=inbox`, while working, external, or unknown state stays inbox-only. An active agent wait owns delivery and suppresses that wake. Check `delivered` and `delivery_path` (the only route field); `accepted=true` only confirms buffering.",
                    "list_peers": "agent action=list_peers project=<optional filter> — see who else is connected.",
                    "conflict_control": "Use send/inbox to serialize shared-file edits: child sends 'claim <path>', orchestrator replies 'ack'/'deny'; child sends 'release <path>' on commit. Orchestrator is the arbiter — children never ack each other directly.",
                    "cleanup": "On MCP session close, peer routes and inbox are drained. Managed PTY lifecycle remains separate; an MCP-scoped external identity has no PTY to reap."
                }
            });
            // Say what happened to the superseded identity's mail. Both outcomes were
            // silent before: a migration looked like nothing happened, and a skip left
            // messages addressed to the old UUID unread with no wake and no notice.
            if let (Some(prior), Some(handoff)) = (superseded.as_deref(), handoff) {
                let object = response
                    .as_object_mut()
                    .expect("register response is an object");
                object.insert("superseded_identity".to_string(), serde_json::json!(prior));
                match handoff {
                    IdentityHandoff::Migrated { messages } => {
                        object.insert("mail_migrated".to_string(), serde_json::json!(messages));
                    }
                    IdentityHandoff::SkippedLivePty { pending } => {
                        object.insert("mail_migrated".to_string(), serde_json::json!(0));
                        object.insert("mail_stranded".to_string(), serde_json::json!(pending));
                        object.insert("identity_warning".to_string(), serde_json::json!(format!(
                            "'{prior}' still owns a live PTY, so it is a reachable peer and its mail was NOT moved: {pending} message(s) remain addressed to it. Taking them would strand a working agent. Read them as that identity, or have it hand over by registering from its own session."
                        )));
                    }
                }
            }
            response
        }
        "list_peers" => {
            let project_filter = args["project"].as_str();
            let peers: Vec<serde_json::Value> = state
                .peer_agents
                .iter()
                .filter(|entry| {
                    if let Some(filter) = project_filter {
                        entry.value().project.as_deref() == Some(filter)
                    } else {
                        true
                    }
                })
                .map(|entry| {
                    let p = entry.value();
                    let mut peer = serde_json::json!({
                        "tuic_session": p.tuic_session,
                        "name": p.name,
                        "registered_at": p.registered_at,
                        "orchestrator": state.orchestrator_peers.contains(&p.tuic_session),
                        "mail_wake": if state.orchestrator_peers.contains(&p.tuic_session)
                            && state
                                .live_pty_for_peer(&p.tuic_session)
                                .and_then(|session_id| {
                                    state
                                        .session_states
                                        .get(&session_id)
                                        .map(|session| session.agent_type.is_some())
                                })
                                .unwrap_or(false)
                        {
                            "managed_pty_lifecycle"
                        } else {
                            "none"
                        },
                    });
                    insert_optional_value(
                        peer.as_object_mut().expect("peer entry is an object"),
                        "project",
                        p.project.clone().map(serde_json::Value::String),
                    );
                    peer
                })
                .collect();
            serde_json::json!({"peers": peers, "count": peers.len()})
        }
        "send" => {
            let to = match args["to"].as_str() {
                Some(s) if !s.is_empty() => s,
                _ => {
                    return serde_json::json!({"error": "Action 'send' requires 'to' (recipient's tuic_session UUID)"});
                }
            };
            let message = match args["message"].as_str() {
                Some(s) if !s.is_empty() => s,
                _ => return serde_json::json!({"error": "Action 'send' requires 'message'"}),
            };
            if message.len() > crate::state::AGENT_MESSAGE_MAX_BYTES {
                return serde_json::json!({"error": format!(
                    "Message exceeds 64 KB limit ({} bytes)", message.len()
                )});
            }
            // Resolve sender via O(1) mcp_to_session reverse map (RUST-3/PERF-2).
            let sender = match mcp_session_id
                .and_then(|sid| state.mcp_to_session.get(sid).map(|e| e.value().clone()))
                .and_then(|tuic| {
                    state
                        .peer_agents
                        .get(&tuic)
                        .map(|p| (p.tuic_session.clone(), p.name.clone()))
                }) {
                Some(s) => s,
                None => {
                    return serde_json::json!({"error": "You are not registered. Register first with agent action=register"});
                }
            };
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let (sender_tuic, sender_name) = sender;
            let msg = crate::state::AgentMessage {
                id: uuid::Uuid::new_v4().to_string(),
                from_tuic_session: sender_tuic.clone(),
                from_name: sender_name.clone(),
                content: message.to_string(),
                timestamp: now_ms,
                delivered_via_channel: false,
            };
            let msg_id = msg.id.clone();

            // Buffer first, then assign exactly one wake-up owner. Assignment preserves
            // a claim made by a concurrent waiter between these two operations.
            // External peers without a live SSE subscriber remain inbox-only.
            //
            // The existence check and the buffering are one critical section under
            // the identity lock: `retire_repaired_phantom_identity` deletes the
            // recipient and drains its inbox under the same guard, so a message can
            // never be filed under an identity that is removed a moment later.
            let message_timestamp = {
                let _bind_guard = PEER_IDENTITY_BIND_LOCK.lock();
                if !state.peer_agents.contains_key(to) {
                    return serde_json::json!({"error": format!("Recipient '{}' is not registered. Use list_peers to find valid targets.", to)});
                }
                state.push_agent_inbox(to, msg)
            };
            // Resolve, do not compare. A self-registering agent announces its
            // `$TUIC_SESSION`, which is not the key its PTY was filed under, so the
            // old `sessions.contains_key(to)` answered "no terminal" for every peer
            // that had not been spawned by the server itself.
            let live_pty = state.live_pty_for_peer(to);
            let managed_recipient = live_pty.is_some();
            if let Some(assignment) = crate::pty::route_registered_orchestrator_mail(
                state,
                to,
                &msg_id,
                message_timestamp,
            ) {
                use crate::state::OrchestratorDeliveryAssignment;

                let (delivered, delivery_path) = match assignment {
                    OrchestratorDeliveryAssignment::Waiter => (true, "waiter_and_inbox"),
                    OrchestratorDeliveryAssignment::WakeSubmitted => {
                        (true, "wake_notification_and_inbox")
                    }
                    // Unreachable for a peer `send`: its own payload is in the
                    // covered window, which disqualifies the lifecycle summary.
                    // Mapped anyway so the two never drift.
                    OrchestratorDeliveryAssignment::WakeSummarySubmitted => {
                        (true, "lifecycle_summary_and_inbox")
                    }
                    OrchestratorDeliveryAssignment::WakeCoalesced => {
                        (true, "coalesced_wake_and_inbox")
                    }
                    OrchestratorDeliveryAssignment::InboxOnly => (false, "inbox_only"),
                };
                tracing::info!(
                    source = "agent_msg",
                    event = "send",
                    from = %sender_tuic,
                    from_name = %sender_name,
                    to = %to,
                    bytes = message.len(),
                    delivered_via_channel = false,
                    message_id = %msg_id,
                    "Peer message routed to orchestrator inbox"
                );
                let mut response = serde_json::json!({
                    "ok": true,
                    "accepted": true,
                    "message_id": msg_id,
                    "buffered_in_inbox": true,
                    "delivered": delivered,
                    // See the note on the other send response: `delivery_path` is the
                    // single source of truth for the route. This branch used to
                    // hardcode `delivered_via_channel: false` next to a `delivered:
                    // true` — factually correct, and unreadable.
                    "delivery_path": delivery_path,
                });
                if !delivered {
                    let object = response
                        .as_object_mut()
                        .expect("send response is an object");
                    object.insert(
                        "warning".to_string(),
                        serde_json::json!(if managed_recipient {
                            "The orchestrator is not authoritatively idle/completed and has no active wait. The message remains inbox-only until it reads the inbox."
                        } else {
                            "Recipient has NO terminal and no active wait: nothing will wake it. The message stays in its inbox until it calls agent action=wait/inbox. If you need an answer, do not block on it."
                        }),
                    );
                    object.insert(
                        "recipient_has_terminal".to_string(),
                        serde_json::json!(managed_recipient),
                    );
                }
                insert_optional_value(
                    response
                        .as_object_mut()
                        .expect("send response is an object"),
                    "recipient_state",
                    live_pty
                        .as_deref()
                        .and_then(|pty_session| managed_recipient_state(state, pty_session)),
                );
                return response;
            }
            // The channel-eligibility probe reads agent lifecycle state, which is
            // filed under the PTY key like everything else.
            let channel_pty = live_pty.clone();
            let recipient_mcp_sid = state.peer_agents.get(to).map(|p| p.mcp_session_id.clone());
            let notification = serde_json::json!({
                "jsonrpc": "2.0",
                "method": "notifications/claude/channel",
                "params": {
                    "content": format!("Message from {}: {}", sender_name, message),
                    "meta": {
                        "from_tuic_session": sender_tuic,
                        "from_name": sender_name,
                        "message_id": msg_id,
                    }
                }
            });
            let notification = serde_json::to_string(&notification).unwrap_or_default();
            let (delivery_assignment, pushed) = state.assign_agent_delivery_with_terminal_attempt(
                to,
                &msg_id,
                managed_recipient,
                || {
                    let Some(mcp_sid) = recipient_mcp_sid.as_ref() else {
                        return false;
                    };
                    if !recipient_supports_active_claude_channel(
                        state,
                        channel_pty.as_deref().unwrap_or(to),
                        mcp_sid,
                        managed_recipient,
                    ) {
                        return false;
                    }
                    let Some(channel) = state.messaging_channels.get(mcp_sid) else {
                        return false;
                    };
                    channel.send(notification).is_ok()
                },
            );
            let waiter_owned = matches!(
                delivery_assignment,
                crate::state::AgentDeliveryAssignment::Waiter
            );
            let terminal_owned = matches!(
                delivery_assignment,
                crate::state::AgentDeliveryAssignment::Terminal
            );
            let mut inbox_only = matches!(
                delivery_assignment,
                crate::state::AgentDeliveryAssignment::InboxOnly
            );
            if pushed
                && let Some(mut inbox) = state.agent_inbox.get_mut(to)
                && let Some(message) = inbox.iter_mut().find(|m| m.id == msg_id)
            {
                message.delivered_via_channel = true;
            }

            #[cfg(unix)]
            if let Some(pty_session) = live_pty.as_deref()
                && let Err(e) = crate::pty::wake_session(state, pty_session)
            {
                tracing::debug!(session = %pty_session, error = %e, "Wake on message delivery failed");
            }
            // Event-driven wake: type the message into an idle recipient's terminal
            // so it acts without polling. Skip when already pushed over the SSE
            // channel (Claude Code consumes that notification itself, so PTY
            // injection would double-deliver). The inbox always holds the
            // authoritative copy.
            let terminal_outcome =
                live_pty
                    .as_ref()
                    .filter(|_| terminal_owned && !pushed)
                    .map(|pty_session| {
                        let framed = frame_peer_message(&sender_name, message);
                        crate::pty::deliver_message_to_managed_pty(state, pty_session, &framed)
                    });
            if let Some(outcome) = terminal_outcome {
                crate::pty::settle_terminal_delivery(state, to, &msg_id, outcome);
                // Only a session that cannot take the message at all falls back to
                // the inbox. `Queued` is still a terminal delivery — it types on the
                // recipient's next idle transition — so reporting it as inbox_only
                // would understate what happens.
                inbox_only = outcome == crate::pty::PtyDelivery::Unavailable;
            }
            // Forensic trail: sender, recipient, size, and delivery path — but never the
            // content (it can be up to 64 KB and may carry sensitive coordination text).
            tracing::info!(
                source = "agent_msg",
                event = "send",
                from = %sender_tuic,
                from_name = %sender_name,
                to = %to,
                bytes = message.len(),
                delivered_via_channel = pushed,
                message_id = %msg_id,
                "Peer message delivered"
            );
            let mut response = serde_json::json!({
                "ok": true,
                "accepted": true,
                "message_id": msg_id,
                "buffered_in_inbox": true,
                // `delivered` answers the only question the sender actually has:
                // will anything surface this message? A waiter consumed it, the SSE
                // channel took it, or the terminal typed/queued it — those reach the
                // recipient. `inbox_only` does not: it means no waiter, no channel and
                // no live terminal, so the message sits unread until the recipient
                // polls. Reporting that as a bare `ok` is how an orchestrator's reply
                // vanished while both sides believed delivery had happened.
                "delivered": !inbox_only,
                // No `delivered_via_channel` here: it reported one sub-route (SSE)
                // but read as a delivery verdict, so `false` alongside a confirming
                // `delivery_path` was pure ambiguity. `delivery_path` names the SSE
                // case as `sse_channel_and_inbox` and subsumes it.
                "delivery_path": if waiter_owned {
                    "waiter_and_inbox"
                } else if pushed {
                    "sse_channel_and_inbox"
                } else if inbox_only {
                    "inbox_only"
                } else {
                    "terminal_or_queued_and_inbox"
                },
            });
            if inbox_only {
                let object = response
                    .as_object_mut()
                    .expect("send response is an object");
                object.insert(
                    "warning".to_string(),
                    serde_json::json!(if managed_recipient {
                        "Recipient has a terminal but could not take the message and has no active wait — it stays in the inbox until the recipient reads it."
                    } else {
                        "Recipient has NO terminal and no active wait: nothing will wake it. The message stays in its inbox until it calls agent action=wait/inbox. If you need an answer, do not block on it."
                    }),
                );
                object.insert(
                    "recipient_has_terminal".to_string(),
                    serde_json::json!(managed_recipient),
                );
            }
            insert_optional_value(
                response
                    .as_object_mut()
                    .expect("send response is an object"),
                "recipient_state",
                live_pty
                    .as_deref()
                    .and_then(|pty_session| managed_recipient_state(state, pty_session)),
            );
            response
        }
        "inbox" => {
            // Resolve caller's tuic_session via O(1) mcp_to_session reverse map (RUST-3/PERF-2).
            let tuic_session = match mcp_session_id
                .and_then(|sid| state.mcp_to_session.get(sid).map(|e| e.value().clone()))
                .filter(|tuic| state.peer_agents.contains_key(tuic))
            {
                Some(ts) => ts,
                None => {
                    return serde_json::json!({"error": "You are not registered. Register first with agent action=register"});
                }
            };
            let limit = args["limit"].as_u64().unwrap_or(50) as usize;
            let since = resolve_agent_since(state, &tuic_session, args);
            let messages = state.observe_agent_inbox(&tuic_session, since, limit);
            // Same contract as wait: always hand back a usable cursor, falling back
            // to the position we read from when the batch is empty.
            let next_since = messages
                .iter()
                .map(|message| message.timestamp)
                .max()
                .unwrap_or(since);
            advance_agent_cursor(state, &tuic_session, next_since);
            // Consume and reset eviction counter (so caller knows since last read)
            let missed_count = state
                .agent_inbox_evictions
                .remove(&tuic_session)
                .map(|(_, n)| n)
                .unwrap_or(0);
            let mut resp = serde_json::json!({
                "messages": messages,
                "count": messages.len(),
                "next_since": next_since,
            });
            if missed_count > 0 {
                resp["missed_count"] = serde_json::json!(missed_count);
            }
            resp
        }
        other => serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'messaging'. Available: {}", other, LEGACY_MESSAGING_ACTIONS
        )}),
    }
}

fn handle_config(
    state: &Arc<AppState>,
    addr: SocketAddr,
    args: &serde_json::Value,
) -> serde_json::Value {
    let action = match require_action(args, "config", CONFIG_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    match action {
        "get" => {
            let config = state.config.read().clone();
            let mut json = to_json_or_error(config);
            if let Some(services) = json.pointer_mut("/services") {
                if let Some(auth) = services.pointer_mut("/auth")
                    && let Some(o) = auth.as_object_mut()
                {
                    o.remove("password_hash");
                    o.remove("session_token");
                }
                if let Some(push) = services.pointer_mut("/push")
                    && let Some(o) = push.as_object_mut()
                {
                    o.remove("vapid_private_key");
                }
                if let Some(relay) = services.pointer_mut("/relay")
                    && let Some(o) = relay.as_object_mut()
                {
                    o.remove("token");
                }
            }
            json
        }
        "save" => {
            if !addr.ip().is_loopback() {
                return serde_json::json!({"error": "Config save is restricted to localhost connections"});
            }
            let config_val = match args.get("config") {
                Some(c) => c,
                None => {
                    return serde_json::json!({"error": "Action 'save' requires 'config' object"});
                }
            };
            // The schema advertises "config fields to save", so callers legitimately
            // send a subset. Merge it onto the live config — deserializing the
            // payload on its own would default every omitted field away.
            // The merge runs inside the config write lock so it applies to the config as
            // it is at write time — this handler already runs on the blocking pool.
            match crate::config::commit_config_change(state, |current| {
                crate::config::merge_partial_app_config(current, config_val.clone())
            }) {
                Ok(effects) => {
                    if effects.tools_changed {
                        let _ = state.mcp_tools_changed.send(());
                    }
                    if effects.server_changed {
                        super::restart_after_server_settings_change(
                            state,
                            "remote-access configuration changed over MCP",
                        );
                    }
                    serde_json::json!({"ok": true})
                }
                Err(e) => serde_json::json!({"error": e}),
            }
        }
        "list_ai_prompts" => {
            let config = crate::config::load_ai_prompts();
            serde_json::json!({
                "services": [{
                    "name": "diff_triage",
                    "description": "System prompt for diff triage LLM classification",
                    "is_custom": config.diff_triage_system_prompt.is_some(),
                }]
            })
        }
        "load_ai_prompt" => {
            let service = match require_string(args, "service") {
                Ok(s) => s,
                Err(e) => return e,
            };
            let config = crate::config::load_ai_prompts();
            match service {
                "diff_triage" => {
                    let default_prompt = crate::diff_triage::default_system_prompt();
                    serde_json::json!({
                        "service": "diff_triage",
                        "prompt": config.diff_triage_system_prompt.as_deref().unwrap_or(default_prompt),
                        "default_prompt": default_prompt,
                        "is_custom": config.diff_triage_system_prompt.is_some(),
                    })
                }
                _ => serde_json::json!({"error": format!("Unknown AI service: {service}")}),
            }
        }
        "save_ai_prompt" => {
            if !addr.ip().is_loopback() {
                return serde_json::json!({"error": "AI prompt save is restricted to localhost connections"});
            }
            let service = match require_string(args, "service") {
                Ok(s) => s,
                Err(e) => return e,
            };
            match service {
                "diff_triage" => {
                    let prompt = args
                        .get("prompt")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.trim().is_empty())
                        .map(|s| s.to_string());
                    let mut config = crate::config::load_ai_prompts();
                    config.diff_triage_system_prompt = prompt;
                    match crate::config::save_ai_prompts(config) {
                        Ok(()) => serde_json::json!({"ok": true}),
                        Err(e) => serde_json::json!({"error": e}),
                    }
                }
                _ => serde_json::json!({"error": format!("Unknown AI service: {service}")}),
            }
        }
        "list_prompts" => {
            let lib = crate::config::load_prompt_library();
            serde_json::json!({
                "prompts": lib.prompts.iter().map(|p| serde_json::json!({
                    "id": p.id, "label": p.label, "pinned": p.pinned,
                })).collect::<Vec<_>>()
            })
        }
        "load_prompt" => {
            let id = match require_string(args, "id") {
                Ok(s) => s,
                Err(e) => return e,
            };
            let lib = crate::config::load_prompt_library();
            match lib.prompts.iter().find(|p| p.id == id) {
                Some(p) => to_json_or_error(p.clone()),
                None => serde_json::json!({"error": format!("Prompt not found: {id}")}),
            }
        }
        "save_prompt" => {
            if !addr.ip().is_loopback() {
                return serde_json::json!({"error": "Prompt save is restricted to localhost connections"});
            }
            let id = match require_string(args, "id") {
                Ok(s) => s.to_string(),
                Err(e) => return e,
            };
            let label = match require_string(args, "label") {
                Ok(s) => s.to_string(),
                Err(e) => return e,
            };
            let text = match require_string(args, "text") {
                Ok(s) => s.to_string(),
                Err(e) => return e,
            };
            let pinned = args
                .get("pinned")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let mut lib = crate::config::load_prompt_library();
            if let Some(existing) = lib.prompts.iter_mut().find(|p| p.id == id) {
                existing.label = label;
                existing.text = text;
                existing.pinned = pinned;
            } else {
                lib.prompts.push(crate::config::PromptEntry {
                    id,
                    label,
                    text,
                    pinned,
                });
            }
            match crate::config::save_prompt_library(lib) {
                Ok(()) => serde_json::json!({"ok": true}),
                Err(e) => serde_json::json!({"error": e}),
            }
        }
        other => serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'config'. Available: {}", other, CONFIG_ACTIONS
        )}),
    }
}

fn handle_debug(state: &Arc<AppState>, args: &serde_json::Value) -> serde_json::Value {
    let action = match require_action(args, "debug", LEGACY_DEBUG_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    match action {
        "agent_detection" => {
            let session_ids: Vec<String> = if let Some(sid) = args["session_id"].as_str() {
                vec![sid.to_string()]
            } else {
                state.sessions.iter().map(|e| e.key().clone()).collect()
            };
            let results: Vec<serde_json::Value> = session_ids.iter().map(|sid| {
                let entry = match state.sessions.get(sid) {
                    Some(e) => e,
                    None => return serde_json::json!({ "error": "session not found", "session_id": sid }),
                };
                let session = entry.value().lock();
                #[cfg(not(windows))]
                {
                    let raw_fd = session.master.as_raw_fd();
                    let pgid = session.master.process_group_leader();
                    let name = pgid.and_then(|p| crate::pty::process_name_from_pid(p as u32));
                    let classified = name.as_deref().and_then(crate::pty::classify_agent);
                    serde_json::json!({
                        "session_id": sid,
                        "master_raw_fd": raw_fd,
                        "process_group_leader": pgid,
                        "process_name": name,
                        "classified_agent": classified,
                        "child_pid": session._child.process_id(),
                    })
                }
                #[cfg(windows)]
                {
                    let child_pid = session._child.process_id();
                    let leaf = child_pid.and_then(crate::pty::deepest_descendant_pid);
                    let name = leaf.and_then(crate::pty::process_name_from_pid);
                    let classified = name.as_deref().and_then(crate::pty::classify_agent);
                    serde_json::json!({
                        "session_id": sid,
                        "child_pid": child_pid,
                        "leaf_pid": leaf,
                        "process_name": name,
                        "classified_agent": classified,
                    })
                }
            }).collect();
            serde_json::json!(results)
        }
        "logs" => {
            let level_filter = args["level"].as_str();
            let source_filter = args["source"].as_str();
            let limit = args["limit"].as_u64().unwrap_or(50) as usize;
            let buf = state.log_buffer.lock();
            let all = buf.get_entries(0);
            let filtered: Vec<_> = all
                .into_iter()
                .filter(|e| level_filter.is_none_or(|l| e.level == l))
                .filter(|e| source_filter.is_none_or(|s| e.source == s))
                .collect();
            let start = filtered.len().saturating_sub(limit);
            serde_json::json!(filtered[start..])
        }
        "sessions" => {
            let sessions: Vec<serde_json::Value> = state
                .sessions
                .iter()
                .map(|entry| {
                    let sid = entry.key().clone();
                    let session = entry.value().lock();
                    #[cfg(not(windows))]
                    let pgid = session.master.process_group_leader();
                    #[cfg(windows)]
                    let pgid = session._child.process_id();
                    #[cfg(not(windows))]
                    let process_name =
                        pgid.and_then(|p| crate::pty::process_name_from_pid(p as u32));
                    #[cfg(windows)]
                    let process_name = pgid.and_then(crate::pty::process_name_from_pid);
                    serde_json::json!({
                        "session_id": sid,
                        "cwd": session.cwd,
                        "child_pid": session._child.process_id(),
                        "foreground_pgid": pgid,
                        "foreground_process": process_name,
                    })
                })
                .collect();
            serde_json::json!(sessions)
        }
        "invoke_js" => {
            // invoke_js executes arbitrary JS in the WebView — must be routed through
            // handle_debug_unified which enforces the loopback guard.
            serde_json::json!({"error": "invoke_js must be called via the debug tool (loopback-only)"})
        }
        other => serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'debug'. Available: {}", other, LEGACY_DEBUG_ACTIONS
        )}),
    }
}

fn handle_workspace(state: &Arc<AppState>, args: &serde_json::Value) -> serde_json::Value {
    let action = match require_action(args, "workspace", LEGACY_WORKSPACE_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    match action {
        "list" => {
            let repo_data = crate::config::load_repositories();
            let repos = repo_data
                .get("repos")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            let repo_order = repo_data
                .get("repoOrder")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let groups = repo_data
                .get("groups")
                .cloned()
                .unwrap_or(serde_json::json!({}));

            // Build group membership lookup: repo_path → group name
            let mut repo_group: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            if let Some(groups_obj) = groups.as_object() {
                for (_gid, group) in groups_obj {
                    let group_name = group["name"].as_str().unwrap_or("").to_string();
                    if let Some(order) = group["repoOrder"].as_array() {
                        for path_val in order {
                            if let Some(path) = path_val.as_str() {
                                repo_group.insert(path.to_string(), group_name.clone());
                            }
                        }
                    }
                }
            }

            let mut results: Vec<serde_json::Value> = Vec::new();
            for path_val in &repo_order {
                let path = match path_val.as_str() {
                    Some(p) => p,
                    None => continue,
                };
                let repo_entry = repos.get(path);
                let display_name = repo_entry
                    .and_then(|r| r["displayName"].as_str())
                    .unwrap_or("")
                    .to_string();

                let info = crate::git::get_repo_info_cached(state, path);
                let worktrees = crate::worktree::get_worktree_paths_cached(state, path);

                let mut entry = serde_json::json!({
                    "path": path,
                    "name": if display_name.is_empty() { &info.name } else { &display_name },
                    "branch": info.branch,
                    "status": info.status,
                    "is_git_repo": info.is_git_repo,
                });
                // Include ahead/behind for git repos with remotes
                if info.is_git_repo {
                    let gh = crate::github::get_github_status_cached(state, path);
                    if gh.has_remote {
                        entry["ahead"] = serde_json::json!(gh.ahead);
                        entry["behind"] = serde_json::json!(gh.behind);
                    }
                }
                if let Some(group_name) = repo_group.get(path) {
                    entry["group"] = serde_json::json!(group_name);
                }
                if !worktrees.is_empty() {
                    entry["worktrees"] = to_json_or_error(&worktrees);
                }
                results.push(entry);
            }
            serde_json::json!(results)
        }
        "active" => {
            let repo_data = crate::config::load_repositories();
            let active_path = match repo_data.get("activeRepoPath").and_then(|v| v.as_str()) {
                Some(p) => p.to_string(),
                None => return serde_json::json!({"active": null}),
            };

            let info = crate::git::get_repo_info_cached(state, &active_path);

            // Find group membership
            let groups = repo_data
                .get("groups")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            let mut group_name: Option<String> = None;
            if let Some(groups_obj) = groups.as_object() {
                for (_gid, group) in groups_obj {
                    if let Some(order) = group["repoOrder"].as_array()
                        && order.iter().any(|p| p.as_str() == Some(&active_path))
                    {
                        group_name = group["name"].as_str().map(|s| s.to_string());
                        break;
                    }
                }
            }

            let mut result = serde_json::json!({
                "path": active_path,
                "name": info.name,
                "branch": info.branch,
                "status": info.status,
            });
            if let Some(gn) = group_name {
                result["group"] = serde_json::json!(gn);
            }
            result
        }
        other => serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'workspace'. Available: {}", other, LEGACY_WORKSPACE_ACTIONS
        )}),
    }
}

/// The TUIC session behind an MCP call, when the caller is bound to a PTY.
/// `None` for an unbound caller — never guess one, a wrong id would send a
/// toast click to somebody else's terminal.
fn resolve_mcp_origin_session(
    state: &Arc<AppState>,
    mcp_session_id: Option<&str>,
) -> Option<String> {
    mcp_session_id.and_then(|mcp_sid| state.mcp_to_session.get(mcp_sid).map(|s| s.value().clone()))
}

fn resolve_mcp_origin_repo_path(
    state: &Arc<AppState>,
    mcp_session_id: Option<&str>,
) -> Option<String> {
    let caller_tuic = resolve_mcp_origin_session(state, mcp_session_id);
    caller_tuic
        .as_ref()
        .and_then(|tuic| {
            state
                .peer_agents
                .get(tuic)
                .and_then(|p| p.project.clone())
                .or_else(|| state.sessions.get(tuic).and_then(|s| s.lock().cwd.clone()))
        })
        .or_else(|| {
            mcp_session_id.and_then(|sid| {
                state
                    .mcp_sessions
                    .get(sid)
                    .and_then(|m| m.repo_path.clone())
            })
        })
}

fn handle_ui(
    state: &Arc<AppState>,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
) -> serde_json::Value {
    let action = match require_action(args, "ui", LEGACY_UI_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    match action {
        "tab" => {
            let id = match args["id"].as_str() {
                Some(v) => v.to_string(),
                None => return serde_json::json!({"error": "Action 'tab' requires 'id'"}),
            };
            let title = match args["title"].as_str() {
                Some(v) => v.to_string(),
                None => return serde_json::json!({"error": "Action 'tab' requires 'title'"}),
            };
            let html_arg = args["html"].as_str().map(|s| s.to_string());
            let url_arg = args["url"].as_str().map(|s| s.to_string());
            let html = match (&html_arg, &url_arg) {
                (Some(h), None) => h.clone(),
                (None, Some(_)) => String::new(), // URL mode — html is empty, frontend uses url
                (Some(_), Some(_)) => {
                    return serde_json::json!({"error": "Provide either 'html' or 'url', not both"});
                }
                (None, None) => {
                    return serde_json::json!({"error": "Action 'tab' requires 'html' or 'url'"});
                }
            };
            // Guard: if a tuic session_id is provided and it already has a terminal,
            // decline to create an HTML tab (agent should use the terminal instead).
            if let Some(sid) = args["session_id"].as_str()
                && (state.vt_log_buffers.contains_key(sid) || state.sessions.contains_key(sid))
            {
                return serde_json::json!({
                    "ok": false,
                    "warning": format!("Session '{}' already has an active terminal. Use the terminal tab instead of creating an HTML tab.", sid)
                });
            }
            let pinned = args["pinned"].as_bool().unwrap_or(false);
            let focus = args["focus"].as_bool().unwrap_or(true);
            // Resolve origin repo for the calling MCP session so the tab lands
            // in the repo where the agent is actually working, not whichever
            // repo happens to have focus in the frontend.
            let caller_tuic = mcp_session_id
                .and_then(|mcp_sid| state.mcp_to_session.get(mcp_sid).map(|s| s.value().clone()));
            let origin_repo_path = resolve_mcp_origin_repo_path(state, mcp_session_id);
            let mut payload = serde_json::json!({
                "id": id,
                "title": title,
                "html": html,
                "pinned": pinned,
                "focus": focus,
            });
            if let Some(ref u) = url_arg {
                payload["url"] = serde_json::Value::String(u.clone());
            }
            if let Some(ref p) = origin_repo_path {
                payload["origin_repo_path"] = serde_json::Value::String(p.clone());
            }
            // Register this tab under the creator's tuic session so it can be
            // closed automatically when that session exits.
            if let Some(ref tuic_session) = caller_tuic {
                state
                    .session_html_tabs
                    .entry(tuic_session.clone())
                    .or_default()
                    .push(id.clone());
            }
            // Emit to Tauri webview (native mode)
            #[cfg(feature = "desktop")]
            if let Some(app) = state.app_handle.read().as_ref() {
                let _ = app.emit("ui-tab", &payload);
            }
            // Emit to SSE clients (browser/mobile)
            let _ = state.event_bus.send(crate::state::AppEvent::UiTab {
                id: id.clone(),
                title,
                html,
                url: url_arg,
                pinned,
                focus,
                origin_repo_path,
            });
            serde_json::json!({"ok": true, "id": id})
        }
        other => serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'ui'. Available: {}", other, LEGACY_UI_ACTIONS
        )}),
    }
}

/// Sounds an MCP caller may request by name. `attention` is the callback added for
/// autonomous agents that need the user back at the keyboard; the rest are the
/// tones already wired into the app's own notifications, exposed so a caller can
/// borrow the meaning the user has already learned.
const TOAST_SOUNDS: [&str; 6] = [
    "question",
    "completion",
    "error",
    "warning",
    "info",
    "attention",
];

/// Resolve the `sound` argument of `ui action=toast` into a notification sound
/// name, or `None` for a silent toast.
///
/// `true` keeps meaning "the sound that matches this level" — but it now
/// resolves to a real `NotificationSound` rather than a toast-local tone, so a
/// muted sound or a chosen output device is honoured either way. A name lets the
/// caller override that, which is the whole point of `attention`: the level says
/// how bad it is, the sound says how hard to pull on the user's sleeve.
fn resolve_toast_sound(
    sound: &serde_json::Value,
    level: &str,
) -> Result<Option<String>, serde_json::Value> {
    match sound {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::Bool(false) => Ok(None),
        serde_json::Value::Bool(true) => Ok(Some(
            match level {
                "warn" => "warning",
                "error" => "error",
                _ => "info",
            }
            .to_string(),
        )),
        serde_json::Value::String(name) if TOAST_SOUNDS.contains(&name.as_str()) => {
            Ok(Some(name.clone()))
        }
        other => Err(serde_json::json!({"error": format!(
            "Invalid sound {}. Use true/false or one of: {}",
            other,
            TOAST_SOUNDS.join(", ")
        )})),
    }
}

fn handle_notify(
    state: &Arc<AppState>,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
) -> serde_json::Value {
    let action = match require_action(args, "notify", LEGACY_NOTIFY_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    match action {
        "toast" => {
            let title = match args["title"].as_str() {
                Some(t) => t.to_string(),
                None => return serde_json::json!({"error": "Action 'toast' requires 'title'"}),
            };
            let message = args["message"].as_str().map(|s| s.to_string());
            let level = args["level"].as_str().unwrap_or("info");
            let level = match level {
                "info" | "warn" | "error" => level.to_string(),
                other => {
                    return serde_json::json!({"error": format!(
                        "Invalid level '{}'. Must be: info, warn, error", other
                    )});
                }
            };
            let sound = match resolve_toast_sound(&args["sound"], &level) {
                Ok(sound) => sound,
                Err(e) => return e,
            };
            let origin_repo_path = resolve_mcp_origin_repo_path(state, mcp_session_id);
            let origin_session_id = resolve_mcp_origin_session(state, mcp_session_id);
            // Dual-emit. The bus only reaches SSE clients (browser/PWA); the
            // desktop WebView listens on the Tauri bridge and there is no
            // bus→window forwarder, so a bus-only send made this tool a no-op on
            // the very client the user is usually sitting in front of.
            #[cfg(feature = "desktop")]
            if let Some(ref app) = *state.app_handle.read() {
                use tauri::Emitter;
                let _ = app.emit(
                    "mcp-toast",
                    serde_json::json!({
                        "title": title,
                        "message": message,
                        "level": level,
                        "sound": sound,
                        "origin_repo_path": origin_repo_path,
                        "origin_session_id": origin_session_id,
                    }),
                );
            }
            let _ = state.event_bus.send(crate::state::AppEvent::McpToast {
                title,
                message,
                level,
                sound,
                origin_repo_path,
                origin_session_id,
            });
            serde_json::json!({"ok": true})
        }
        other => serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'notify'. Available: {}", other, LEGACY_NOTIFY_ACTIONS
        )}),
    }
}

/// How long a confirmation waits for a human before it gives up.
///
/// Matches the MCP wait ceiling used elsewhere. A native dialog waited forever,
/// which is only tolerable when the human is guaranteed to be at the machine —
/// the whole point of routing this through the clients is that they may not be.
const CONFIRM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Ask the human a yes/no question and wait for the answer.
///
/// The request goes to **every** client — desktop WebView, browser, mobile PWA —
/// plus a mobile push, and the first answer wins. It used to be a native OS
/// dialog, which meant an agent asking to confirm a destructive operation blocked
/// until someone walked back to the machine: unanswerable, and therefore blocking,
/// for a human working remotely.
///
/// A request nobody answers within [`CONFIRM_TIMEOUT`] resolves as *not* confirmed
/// and says so, so the caller can tell silence apart from a deliberate refusal.
async fn handle_confirm(
    state: &Arc<AppState>,
    addr: SocketAddr,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
) -> serde_json::Value {
    if !addr.ip().is_loopback() {
        return serde_json::json!({"error": "Action 'confirm' is restricted to localhost connections"});
    }
    let title = match args["title"].as_str() {
        Some(t) => t.to_string(),
        None => return serde_json::json!({"error": "Action 'confirm' requires 'title'"}),
    };
    let message = args["message"].as_str().unwrap_or("").to_string();
    let origin_repo_path = resolve_mcp_origin_repo_path(state, mcp_session_id);
    let origin_session_id = resolve_mcp_origin_session(state, mcp_session_id);

    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.confirm_responses.insert(request_id.clone(), tx);

    // Dual-emit, same reason as the toast above: the bus only reaches SSE
    // clients, and there is no bus→window forwarder for the desktop WebView.
    #[cfg(feature = "desktop")]
    if let Some(ref app) = *state.app_handle.read() {
        use tauri::Emitter;
        let _ = app.emit(
            "mcp-confirm",
            serde_json::json!({
                "request_id": request_id,
                "title": title,
                "message": message,
                "origin_repo_path": origin_repo_path,
                "origin_session_id": origin_session_id,
            }),
        );
    }
    let _ = state.event_bus.send(crate::state::AppEvent::McpConfirm {
        request_id: request_id.clone(),
        title: title.clone(),
        message: message.clone(),
        origin_repo_path,
        origin_session_id: origin_session_id.clone(),
    });

    // A PWA that is not open receives nothing over SSE, so push is the only way
    // a remote human learns an agent is waiting on them.
    let url = match origin_session_id {
        Some(ref sid) => format!("/mobile/session/{sid}"),
        None => "/mobile".to_string(),
    };
    let body = if message.is_empty() {
        title.clone()
    } else {
        format!("{title} — {message}")
    };
    crate::state::AppState::send_mobile_push_url(state, url, &body);

    let confirmed = match tokio::time::timeout(CONFIRM_TIMEOUT, rx).await {
        Ok(Ok(answer)) => answer,
        // Sender dropped without answering, or nobody answered in time. Both are
        // "no human said yes", which is the safe reading for a destructive op.
        _ => {
            state.confirm_responses.remove(&request_id);
            let _ = state
                .event_bus
                .send(crate::state::AppEvent::McpConfirmResolved {
                    request_id: request_id.clone(),
                    confirmed: false,
                });
            #[cfg(feature = "desktop")]
            if let Some(ref app) = *state.app_handle.read() {
                use tauri::Emitter;
                let _ = app.emit(
                    "mcp-confirm-resolved",
                    serde_json::json!({ "request_id": request_id, "confirmed": false }),
                );
            }
            return serde_json::json!({
                "confirmed": false,
                "reason": format!("no answer within {}s", CONFIRM_TIMEOUT.as_secs()),
            });
        }
    };
    serde_json::json!({"confirmed": confirmed})
}

// ---------------------------------------------------------------------------
// Knowledge (cross-repo mdkb fan-out)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Streamable HTTP transport (legacy MCP spec 2025-11-25)
// Single /mcp endpoint — POST for JSON-RPC, GET for SSE notifications, DELETE ends session
// ---------------------------------------------------------------------------

const MCP_SESSION_HEADER: &str = "mcp-session-id";
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 3] = ["2026-07-28", "2025-11-25", "2025-03-26"];
const LEGACY_PROTOCOL_VERSION: &str = SUPPORTED_PROTOCOL_VERSIONS[1];

/// Resolve a filesystem path to one of the known repo roots, picking the longest
/// matching prefix that respects path-component boundaries (so `/foo/bar` does
/// not match `/foo/bar-other`). Falls back to the original path when no repo
/// matches. (#1373-6e2f)
fn resolve_repo_for_path(path: &str, known: &[String]) -> String {
    known
        .iter()
        .filter(|repo| path == repo.as_str() || path.starts_with(&format!("{repo}/")))
        .max_by_key(|repo| repo.len())
        .cloned()
        .unwrap_or_else(|| path.to_string())
}

/// POST /mcp — Handle all MCP JSON-RPC requests via Streamable HTTP
pub(super) async fn mcp_post(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let method = body["method"].as_str().unwrap_or("");
    let id = body.get("id").cloned().unwrap_or(serde_json::Value::Null);

    match method {
        "initialize" => {
            let (session_id, init_kind) = initialize_session_id(&state, &headers);
            let client_name = body["params"]["clientInfo"]["name"].as_str();
            let is_claude_code = detect_claude_code_client(client_name);
            let requires_meta_tools = client_requires_meta_tools(client_name);

            // Extract repo_path from MCP initialize roots[0].uri (file:// URI)
            let repo_path = body["params"]["roots"]
                .as_array()
                .and_then(|roots| roots.first())
                .and_then(|root| root["uri"].as_str())
                .and_then(|uri| uri.strip_prefix("file://"))
                .map(|path| {
                    let known: Vec<String> = state
                        .repo_watchers
                        .iter()
                        .map(|entry| entry.key().clone())
                        .collect();
                    resolve_repo_for_path(path, &known)
                });

            let now = std::time::Instant::now();
            if let Some(mut meta) = state.mcp_sessions.get_mut(&session_id) {
                meta.last_activity = now;
                meta.is_claude_code = is_claude_code;
                meta.requires_meta_tools = requires_meta_tools;
                if repo_path.is_some() {
                    meta.repo_path = repo_path;
                }
            } else {
                state.mcp_sessions.insert(
                    session_id.clone(),
                    crate::state::McpSessionMeta {
                        last_activity: now,
                        is_claude_code,
                        requires_meta_tools,
                        has_sse_stream: false,
                        sse_generation: 0,
                        repo_path,
                    },
                );
            }

            // Auto-bind managed-peer identity from the `x-tuic-session` header the bridge
            // asserts (it inherits `TUIC_SESSION` from the agent PTY). This makes
            // `agent register` optional — the caller already has a working peer
            // identity for spawn/send, which is what clients that ignore initialize
            // `instructions` (e.g. Codex) otherwise never obtain.
            let tuic_session_header = headers
                .get(TUIC_SESSION_HEADER)
                .and_then(|v| v.to_str().ok());
            apply_initialize_identity(&state, &session_id, tuic_session_header);

            // One record per handshake. `initialize` happens once per client
            // connection, so this is not a hot path, and it is the only evidence
            // that an agent's MCP connection actually dropped and came back.
            tracing::info!(
                source = "mcp_initialize",
                event = init_kind.as_str(),
                client = client_name.unwrap_or("unknown"),
                mcp_session = %session_id,
                tuic_session = tuic_session_header.unwrap_or(""),
                presented_session = match &init_kind {
                    InitializeKind::Reconnected { presented } => presented.as_str(),
                    _ => "",
                },
                "MCP initialize"
            );

            let effective_collapse = state.config.read().collapse_tools || requires_meta_tools;
            let instructions =
                build_mcp_instructions_for_mode(&state, client_name, effective_collapse);

            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": LEGACY_PROTOCOL_VERSION,
                    "capabilities": {
                        "tools": {},
                        "experimental": { "claude/channel": {} }
                    },
                    "serverInfo": {
                        "name": "tuicommander",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "instructions": instructions
                }
            });

            (
                StatusCode::OK,
                [(MCP_SESSION_HEADER, session_id)],
                Json(response),
            )
                .into_response()
        }

        "notifications/initialized" => StatusCode::ACCEPTED.into_response(),

        // Standard MCP liveness request. The bridge uses this instead of
        // rebuilding and serializing the complete tools/list payload every
        // three seconds per terminal.
        "ping" => {
            if let Some(sid) = headers
                .get(MCP_SESSION_HEADER)
                .and_then(|v| v.to_str().ok())
            {
                refresh_mcp_session(
                    &state,
                    sid,
                    detect_claude_code_from_headers(&headers),
                    headers
                        .get(TUIC_SESSION_HEADER)
                        .and_then(|v| v.to_str().ok()),
                );
            }
            Json(serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {}
            }))
            .into_response()
        }

        "tools/list" => {
            let list_session_id = headers
                .get(MCP_SESSION_HEADER)
                .and_then(|v| v.to_str().ok());
            if let Some(sid) = list_session_id {
                refresh_mcp_session(
                    &state,
                    sid,
                    detect_claude_code_from_headers(&headers),
                    headers
                        .get(TUIC_SESSION_HEADER)
                        .and_then(|v| v.to_str().ok()),
                );
            }
            // On the first list after boot, wait (bounded) for upstream MCP
            // servers to finish connecting so their proxied tools are included.
            // CC fetches tools/list during the handshake — before async upstream
            // init completes — and never refetches on tools/list_changed
            // (anthropics/claude-code#4118), so a stale list would otherwise stick.
            state
                .mcp_upstream_registry
                .await_initial_settle(std::time::Duration::from_secs(3))
                .await;
            let tools = merged_tool_definitions(&state, list_session_id);
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "tools": tools }
            });
            let mut resp = Json(response).into_response();
            if let Some(sid) = headers
                .get(MCP_SESSION_HEADER)
                .and_then(|v| v.to_str().ok())
                && let Ok(val) = sid.parse()
            {
                resp.headers_mut().insert(MCP_SESSION_HEADER, val);
            }
            resp
        }

        "tools/call" => {
            // Identity is resolved per call, not demanded up front. A caller that
            // sends the header gets its session refreshed — stale ids (app restart,
            // or a long-lived client like Claude Code that lost its session)
            // auto-recover rather than erroring. A caller that sends none is served
            // anyway: most tools need no identity, and the ones that do already
            // refuse with guidance the caller can act on, which a blanket -32600
            // never gave them.
            let is_cc_ua = detect_claude_code_from_headers(&headers);
            if let Some(sid) = headers
                .get(MCP_SESSION_HEADER)
                .and_then(|v| v.to_str().ok())
            {
                refresh_mcp_session(
                    &state,
                    sid,
                    is_cc_ua,
                    headers
                        .get(TUIC_SESSION_HEADER)
                        .and_then(|v| v.to_str().ok()),
                );
            }

            let params = body
                .get("params")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let tool_name = params["name"].as_str().unwrap_or("").to_string();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            let session_id_str = headers
                .get(MCP_SESSION_HEADER)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let managed_parent_cwd = managed_parent_cwd_from_header(
                &state,
                session_id_str.as_deref(),
                headers
                    .get(TUIC_SESSION_HEADER)
                    .and_then(|value| value.to_str().ok()),
            );

            // Route upstream-prefixed tools ({upstream}__{tool}) via the proxy registry.
            // Native tools (no "__") dispatch through handle_mcp_tool_call_with_context,
            // which puts each blocking sync handler on the blocking pool itself
            // (see run_blocking_handler) — this call site does not wrap anything.
            let (result, is_error) = if tool_name.contains("__") {
                // Resolving the allowlist reads and parses repo-settings.json from
                // disk. Only a proxied call consults it, so a native call must not
                // pay for it.
                let allowed = resolve_allowed_upstreams(&state, session_id_str.as_deref());
                match state
                    .mcp_upstream_registry
                    .proxy_tool_call_for_repo(&tool_name, args.clone(), allowed.as_deref())
                    .await
                {
                    Ok(v) => (mark_upstream_tool_result(v), false),
                    Err(e) => (serde_json::json!({"error": e}), true),
                }
            } else {
                let result = handle_mcp_tool_call_with_context(
                    &state,
                    addr,
                    &tool_name,
                    &args,
                    session_id_str.as_deref(),
                    managed_parent_cwd.as_deref(),
                )
                .await;
                let is_error = result.get("error").is_some();
                (result, is_error)
            };
            let tool_result = format_tool_call_result(&result, is_error);
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": tool_result
            });
            let mut resp = Json(response).into_response();
            if let Some(sid) = headers
                .get(MCP_SESSION_HEADER)
                .and_then(|v| v.to_str().ok())
                && let Ok(val) = sid.parse()
            {
                resp.headers_mut().insert(MCP_SESSION_HEADER, val);
            }
            resp
        }

        other => {
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {}", other) }
            });
            Json(response).into_response()
        }
    }
}

/// Streams are numbered from one counter for the whole process, never from the
/// session. A session id can be removed and auto-recovered while an older stream
/// for the previous incarnation is still draining; a per-session counter would
/// restart at zero and hand that stale stream a number the new one also holds,
/// and its teardown would then close the replacement.
fn next_sse_generation() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Releases the per-session SSE resources whenever the stream goes away —
/// normal end, client disconnect, or server shutdown alike. Owned by the stream
/// generator so it runs on drop; the only path a disconnect actually takes.
///
/// A half-open stream can still be alive when its own reconnect is accepted, so
/// the release is conditional: the guard only clears the session it still owns.
/// Unconditional cleanup let the older stream's drop remove the sender the new
/// stream had just subscribed to, which closed the replacement immediately.
///
/// Lock order is `mcp_sessions` → `messaging_channels`, here and in `mcp_get`.
/// Nothing may hold a `messaging_channels` reference while taking `mcp_sessions`.
struct SseStreamTeardown {
    state: Arc<AppState>,
    mcp_sid: String,
    generation: u64,
}

impl Drop for SseStreamTeardown {
    fn drop(&mut self) {
        use dashmap::mapref::entry::Entry;

        // The session entry is held across the channel removal: releasing it
        // first would let a reconnect take ownership and subscribe in between,
        // and this drop would then remove the sender out from under it.
        //
        // `entry` rather than `get_mut` because the absent case needs the hold
        // just as much: DELETE or the reaper can remove the session while this
        // stream is still draining, and `get_mut` returning `None` releases the
        // shard before the removal below. A reconnect landing in that window
        // recreates the session, subscribes to a fresh sender, and then loses it
        // to this drop. Only `entry` keeps the shard locked over an absent key.
        match self.state.mcp_sessions.entry(self.mcp_sid.clone()) {
            // Superseded: a newer stream owns the session and its channel.
            Entry::Occupied(meta) if meta.get().sse_generation != self.generation => {}
            Entry::Occupied(mut meta) => {
                meta.get_mut().has_sse_stream = false;
                self.state.messaging_channels.remove(&self.mcp_sid);
            }
            // The session itself is gone; nobody is left to own the channel.
            Entry::Vacant(_) => {
                self.state.messaging_channels.remove(&self.mcp_sid);
            }
        }
    }
}

/// GET /mcp — SSE stream for MCP server→client notifications (tools/list_changed, channel messages).
/// Requires a valid `mcp-session-id` header (established via POST /mcp initialize).
pub(super) async fn mcp_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    // Validate MCP session (auto-recover stale sessions, same as tools/call)
    let session_id = headers
        .get(MCP_SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let is_cc_ua = detect_claude_code_from_headers(&headers);
    let Some(sid) = session_id else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    if !state.mcp_sessions.contains_key(&sid) {
        tracing::warn!(
            "MCP SSE session auto-recovered (stale session_id: {sid}); \
             is_claude_code={is_cc_ua} (from User-Agent)"
        );
        state.mcp_sessions.insert(
            sid.clone(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code: is_cc_ua,
                requires_meta_tools: false,
                has_sse_stream: false,
                sse_generation: 0,
                repo_path: None,
            },
        );
    }

    // Take ownership of the session and subscribe to its channel under one hold
    // of the session entry — the same one the teardown takes. Split apart, a
    // superseded stream's teardown could pass its generation check, then remove
    // the sender *after* this stream had already subscribed to it, and the
    // replacement would open onto a closed channel.
    let (generation, msg_rx) = {
        let Some(mut meta) = state.mcp_sessions.get_mut(&sid) else {
            // Removed between the insert above and here (DELETE /mcp, reaper).
            return StatusCode::UNAUTHORIZED.into_response();
        };
        meta.has_sse_stream = true;
        meta.sse_generation = next_sse_generation();
        let tx = state
            .messaging_channels
            .entry(sid.clone())
            .or_insert_with(|| tokio::sync::broadcast::channel(64).0);
        (meta.sse_generation, tx.subscribe())
    };

    let mut tools_rx = state.mcp_tools_changed.subscribe();
    let mut msg_rx = msg_rx;
    // Teardown hangs off a drop guard, not off code after the loop. A client that
    // walks away has axum drop the response body mid-`select!`, so anything
    // trailing the loop never runs and every reconnect would leak a sender.
    let cleanup = SseStreamTeardown {
        state: state.clone(),
        mcp_sid: sid.clone(),
        generation,
    };

    let stream = async_stream::stream! {
        let _cleanup = cleanup;
        loop {
            tokio::select! {
                result = tools_rx.recv() => {
                    match result {
                        Ok(()) => {
                            let notification = serde_json::json!({
                                "jsonrpc": "2.0",
                                "method": "notifications/tools/list_changed"
                            });
                            yield Ok::<_, std::convert::Infallible>(
                                axum::response::sse::Event::default()
                                    .data(serde_json::to_string(&notification).unwrap_or_default())
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
                result = msg_rx.recv() => {
                    match result {
                        Ok(json_str) => {
                            yield Ok::<_, std::convert::Infallible>(
                                axum::response::sse::Event::default().data(json_str)
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    };

    axum::response::sse::Sse::new(stream)
        .keep_alive(
            axum::response::sse::KeepAlive::new()
                .interval(std::time::Duration::from_secs(15))
                .text("ping"),
        )
        .into_response()
}

/// GET /mcp/instructions — Returns dynamic server instructions for the bridge binary
pub(super) async fn mcp_instructions_http(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(serde_json::json!({"instructions": build_mcp_instructions(&state, None)}))
}

/// DELETE /mcp — End an MCP session
pub(super) async fn mcp_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Some(sid) = headers
        .get(MCP_SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
    {
        state.mcp_sessions.remove(sid);
        // Now that an identity can have co-owners, teardown has to read the
        // survivor list and act on it as one step: a bridge joining in the middle
        // would otherwise re-create the routes this loop is about to delete and be
        // left pointing at an identity that no longer exists. Same lock as the
        // binds, so a join lands entirely before or entirely after the teardown.
        // No `.await` inside — the guard never crosses a suspension point.
        let _bind_guard = PEER_IDENTITY_BIND_LOCK.lock();
        // Routes belong to the protocol session, so a sibling bridge that never
        // became delivery owner still drops its own — otherwise its mapping
        // outlives it and keeps resolving to an identity it no longer serves.
        state.mcp_to_session.remove(sid);
        let routed: Vec<String> = state
            .session_to_mcp
            .iter()
            .filter(|entry| entry.value().iter().any(|mapped| mapped == sid))
            .map(|entry| entry.key().clone())
            .collect();
        for tuic in &routed {
            let survivors = match state.session_to_mcp.get_mut(tuic) {
                Some(mut reverse) => {
                    reverse.retain(|mapped_sid| mapped_sid != sid);
                    reverse.clone()
                }
                None => Vec::new(),
            };
            match survivors.first() {
                // Another bridge in this PTY is still reading the identity, so
                // hand it the delivery ownership rather than tearing down a
                // mailbox and a role that are still in use.
                Some(next_owner) => {
                    if let Some(mut peer) = state.peer_agents.get_mut(tuic)
                        && peer.mcp_session_id == sid
                    {
                        peer.mcp_session_id = next_owner.clone();
                    }
                }
                None => {
                    state.session_to_mcp.remove(tuic);
                }
            }
        }
        // Clean up peer agents and inboxes left with no protocol session at all.
        let removed_tuic: Vec<String> = state
            .peer_agents
            .iter()
            .filter(|e| e.value().mcp_session_id == sid)
            .map(|e| e.key().clone())
            .collect();
        for tuic in &removed_tuic {
            state.peer_agents.remove(tuic);
            state.orchestrator_peers.remove(tuic);
            state.agent_inbox.remove(tuic);
            drop_identity_buffers(&state, tuic);
            let _ = state
                .event_bus
                .send(crate::state::AppEvent::PeerUnregistered {
                    tuic_session: tuic.clone(),
                });
        }
    }
    StatusCode::OK
}

// ── Unified handlers (merged tools) ──────────────────────────────────────

/// Merged repo tool: dispatches to workspace, github, or worktree handlers.
async fn handle_repo(
    state: &Arc<AppState>,
    args: &serde_json::Value,
    is_claude_code: bool,
) -> serde_json::Value {
    let action = match require_action(args, "repo", REPO_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    match action {
        "list" => handle_workspace(state, &serde_json::json!({"action": "list"})),
        "active" => handle_workspace(state, &serde_json::json!({"action": "active"})),
        "prs" => handle_github(state, &remap_action(args, "prs")).await,
        "status" => handle_github(state, &remap_action(args, "status")).await,
        "worktree_list" => {
            handle_worktree(state, &remap_action(args, "list"), is_claude_code).await
        }
        "worktree_create" => {
            handle_worktree(state, &remap_action(args, "create"), is_claude_code).await
        }
        "worktree_remove" => {
            handle_worktree(state, &remap_action(args, "remove"), is_claude_code).await
        }
        other => serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'repo'. Available: {}", other, REPO_ACTIONS
        )}),
    }
}

/// Merged agent tool: original agent actions + messaging actions.
#[cfg(test)]
fn handle_agent_unified(
    state: &Arc<AppState>,
    addr: SocketAddr,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
) -> serde_json::Value {
    handle_agent_unified_with_parent_cwd(state, addr, args, mcp_session_id, None)
}

fn handle_agent_unified_with_parent_cwd(
    state: &Arc<AppState>,
    addr: SocketAddr,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
    managed_parent_cwd: Option<&str>,
) -> serde_json::Value {
    let action = match require_action(args, "agent", AGENT_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    match action {
        "spawn" | "detect" | "stats" | "metrics" => handle_agent_with_parent_cwd(
            state,
            addr,
            &remap_action(args, action),
            mcp_session_id,
            managed_parent_cwd,
        ),
        "register" | "list_peers" | "send" | "inbox" => {
            // Inter-agent messaging is same-machine coordination only, so it carries
            // the same loopback restriction as `spawn`. Without this, a non-loopback
            // MCP client — whether Basic-Auth'd remotely or admitted via lan_auth_bypass —
            // could register a peer identity, enumerate peers, or inject a message that
            // lands verbatim in another agent's context. Loopback (incl. the local
            // Unix socket, injected as 127.0.0.1 upstream) is the trust boundary here.
            if !addr.ip().is_loopback() {
                return serde_json::json!({
                    "error": "Inter-agent messaging is restricted to localhost connections"
                });
            }
            handle_messaging(state, &remap_action(args, action), mcp_session_id)
        }
        other => serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'agent'. Available: {}", other, AGENT_ACTIONS
        )}),
    }
}

/// Merged ui tool: original tab action + notify toast/confirm + screenshot.
async fn handle_ui_unified(
    state: &Arc<AppState>,
    addr: SocketAddr,
    args: &serde_json::Value,
    mcp_session_id: Option<&str>,
) -> serde_json::Value {
    let action = match require_action(args, "ui", UI_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    match action {
        "tab" => handle_ui(state, args, mcp_session_id),
        "toast" => handle_notify(state, &remap_action(args, action), mcp_session_id),
        // Waits for the human, but only on a oneshot — no blocking-pool worker is
        // held, so a confirmation left unanswered costs a pending task and nothing
        // else.
        "confirm" => handle_confirm(state, addr, args, mcp_session_id).await,
        "screenshot" => handle_screenshot(state, addr, args).await,
        other => serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'ui'. Available: {}", other, UI_ACTIONS
        )}),
    }
}

/// Capture a screenshot of a plugin panel tab and return it as an MCP image content block.
/// Desktop-only, loopback-only. Sends a Tauri event to the frontend which captures the
/// iframe content and responds via the `screenshot_response` command.
async fn handle_screenshot(
    state: &Arc<AppState>,
    addr: SocketAddr,
    args: &serde_json::Value,
) -> serde_json::Value {
    #[cfg(not(feature = "desktop"))]
    {
        let _ = (state, addr, args);
        serde_json::json!({"error": "Action 'screenshot' requires desktop feature"})
    }
    #[cfg(feature = "desktop")]
    {
        if !addr.ip().is_loopback() {
            return serde_json::json!({"error": "Action 'screenshot' is restricted to localhost connections"});
        }
        let panel_id = match args["id"].as_str() {
            Some(id) => id.to_string(),
            None => {
                return serde_json::json!({"error": "Action 'screenshot' requires 'id' (the plugin panel ID)"});
            }
        };
        let app_handle = state.app_handle.read().clone();
        let Some(handle) = app_handle else {
            return serde_json::json!({"error": "AppHandle not available (headless mode)"});
        };

        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        state.screenshot_responses.insert(request_id.clone(), tx);

        use tauri::Emitter;
        if let Err(e) = handle.emit(
            "screenshot-request",
            serde_json::json!({
                "id": panel_id,
                "request_id": request_id,
            }),
        ) {
            state.screenshot_responses.remove(&request_id);
            return serde_json::json!({"error": format!("Failed to emit screenshot request: {e}")});
        }

        match tokio::time::timeout(std::time::Duration::from_secs(15), rx).await {
            Ok(Ok(Some(base64_data))) => {
                use base64::Engine;
                let bytes = match base64::engine::general_purpose::STANDARD.decode(&base64_data) {
                    Ok(b) => b,
                    Err(e) => {
                        return serde_json::json!({"error": format!("Invalid base64 from frontend: {e}")});
                    }
                };
                let dir = state.data_dir.join("screenshots");
                let _ = std::fs::create_dir_all(&dir);
                let filename = format!("{}.webp", request_id);
                let path = dir.join(&filename);
                if let Err(e) = std::fs::write(&path, &bytes) {
                    return serde_json::json!({"error": format!("Failed to write screenshot: {e}")});
                }
                serde_json::json!({
                    "ok": true,
                    "path": path.to_string_lossy(),
                    "size_bytes": bytes.len()
                })
            }
            Ok(Ok(None)) => {
                serde_json::json!({"error": format!(
                    "Screenshot failed: panel '{}' not found or iframe content not accessible", panel_id
                )})
            }
            Ok(Err(_)) => {
                serde_json::json!({"error": "Screenshot response channel dropped"})
            }
            Err(_) => {
                state.screenshot_responses.remove(&request_id);
                serde_json::json!({"error": "Screenshot timed out (15s)"})
            }
        }
    }
}

/// Extended debug tool: original actions + plugin_guide.
fn handle_debug_unified(
    state: &Arc<AppState>,
    addr: SocketAddr,
    args: &serde_json::Value,
) -> serde_json::Value {
    let action = match require_action(args, "debug", DEBUG_ACTIONS) {
        Ok(a) => a,
        Err(e) => return e,
    };
    match action {
        "invoke_js" => {
            if !addr.ip().is_loopback() {
                return serde_json::json!({"error": "invoke_js is restricted to localhost connections"});
            }
            let script = match args["script"].as_str() {
                Some(s) => s,
                None => return serde_json::json!({"error": "script required (string)"}),
            };
            // Shared with the HTTP /debug/invoke_js route (see log_routes::eval_debug_script).
            super::log_routes::eval_debug_script(state, script)
        }
        "agent_detection" | "logs" | "sessions" => handle_debug(state, args),
        "help" => serde_json::json!({
            "actions": {
                "help": "This guide.",
                "agent_detection": "Agent detection pipeline diagnostics. Optional session_id (omit for all sessions).",
                "logs": "App log entries (info/warn/error mirrored from JS). Params: level, source, limit (default 50).",
                "sessions": "All PTY sessions with pid, cwd, foreground process info.",
                "invoke_js": "Execute JS in the main WebView (localhost only). Use `return expr` for output. Result + captured console output logged as source='eval_js'. Read via logs(source='eval_js', limit=1)."
            },
            "invoke_js_guide": {
                "console_capture": "console.log/warn/error/info are captured and included in the result.",
                "globals": {
                    "window.__TUIC__.stores()": "List all registered store snapshot names",
                    "window.__TUIC__.store(name)": "Get a store snapshot by name (repositories, paneLayout, settings, ui, keybindings, ...)",
                    "window.__TUIC__.plugins()": "All plugin states: id, loaded, enabled, error, builtIn",
                    "window.__TUIC__.plugin(id)": "Single plugin state with manifest",
                    "window.__TUIC__.pluginLogs(id, limit?)": "Plugin's internal PluginLogger entries (default 20)",
                    "window.__TUIC__.terminals()": "All terminals: id, name, sessionId, shellState, agentType, cwd",
                    "window.__TUIC__.terminal(id)": "Single terminal with awaitingInput, usageLimit",
                    "window.__TUIC__.agentTypeForSession(sid)": "Agent type lookup by PTY session ID",
                    "window.__TUIC__.activity()": "Activity center sections and active items",
                    "window.__TUIC__.logs(limit?)": "JS-side appLogger entries, all levels (default 50)"
                },
                "examples": [
                    "return window.__TUIC__.stores()",
                    "return window.__TUIC__.store('repositories')",
                    "return window.__TUIC__.store('paneLayout')",
                    "return window.__TUIC__.plugins()",
                    "return window.__TUIC__.terminals()"
                ]
            }
        }),
        other => serde_json::json!({"error": format!(
            "Unknown action '{}' for tool 'debug'. Available: {}", other, DEBUG_ACTIONS
        )}),
    }
}

/// Remap an action value in args — preserves all other fields.
fn remap_action(args: &serde_json::Value, new_action: &str) -> serde_json::Value {
    let mut remapped = args.clone();
    remapped["action"] = serde_json::Value::String(new_action.to_string());
    remapped
}

// ---------------------------------------------------------------------------
// Run config resolution
// ---------------------------------------------------------------------------

/// Result of resolving an `agent_type` string against the agents config.
/// When a run config matches, command/args/env override the agent binary defaults.
#[derive(Debug, Clone)]
struct ResolvedRunConfig {
    /// The canonical agent type key (e.g. "claude", "codex").
    agent_type: String,
    /// Override command from the matched run config, if any.
    command: Option<String>,
    /// Override args from the matched run config, if any.
    args: Option<Vec<String>>,
    /// Env vars from the matched run config, if any.
    env: std::collections::HashMap<String, String>,
}

/// Resolve an `agent_type` parameter as either:
/// 1. A run config name (case-insensitive match across all enabled agents), or
/// 2. A literal agent type / binary name.
///
/// Returns `ResolvedRunConfig` with overrides when a run config matches,
/// or just the agent_type passthrough when it doesn't.
fn resolve_run_config(
    agent_type: &str,
    agents_cfg: &crate::config::AgentsConfig,
) -> ResolvedRunConfig {
    let needle = agent_type.to_ascii_lowercase();

    // Pass 1: try to match as a run config name across all agents
    for (agent_key, settings) in &agents_cfg.agents {
        for cfg in &settings.run_configs {
            if cfg.name.to_ascii_lowercase() == needle {
                return ResolvedRunConfig {
                    agent_type: agent_key.clone(),
                    command: Some(cfg.command.clone()),
                    args: Some(cfg.args.clone()),
                    env: cfg.env.clone(),
                };
            }
        }
    }

    // Pass 2: treat as a literal agent type (no run config overrides)
    ResolvedRunConfig {
        agent_type: agent_type.to_string(),
        command: None,
        args: None,
        env: Default::default(),
    }
}

/// Substitute `{prompt}` placeholders in args, or append prompt as last arg.
fn substitute_prompt_in_args(args: &[String], prompt: &str) -> Vec<String> {
    let has_placeholder = args.iter().any(|a| a.contains("{prompt}"));
    if has_placeholder {
        args.iter().map(|a| a.replace("{prompt}", prompt)).collect()
    } else {
        let mut result: Vec<String> = args.to_vec();
        result.push(prompt.to_string());
        result
    }
}

/// Finalize caller-supplied argv without silently dropping the required task.
/// A `{prompt}` placeholder is an explicit delivery decision and is preserved
/// verbatim after substitution. Flags-only argv inherits the built-in behavior:
/// prefill-only agents receive the task through deferred PTY injection; other
/// agents receive it as the final positional argument.
fn finalize_explicit_spawn_args(
    agent_type: &str,
    explicit: &[String],
    prompt: &str,
) -> (Vec<String>, Option<String>) {
    if explicit.iter().any(|arg| arg.contains("{prompt}")) {
        return (substitute_prompt_in_args(explicit, prompt), None);
    }
    if crate::agent::prompt_prefill_only(agent_type) {
        return (explicit.to_vec(), Some(prompt.to_string()));
    }
    (substitute_prompt_in_args(explicit, prompt), None)
}

/// Final argv + optional deferred initial prompt for an orchestrated agent spawn.
///
/// For prefill-only TUIs (`crate::agent::prompt_prefill_only`, e.g. codex) the
/// task must NOT ride in argv — it prefills the interactive input without
/// submitting, parking the child forever (story 091). Every argv element
/// carrying `{prompt}` is dropped and the prompt is returned separately for the
/// caller to queue as a pending injection, delivered (text + CR) on the child's
/// first idle. All other agents keep the normal placeholder substitution.
///
/// Applied ONLY to the built-in `default_prompt_args` template path — a
/// user-authored run config (e.g. codex `["exec", "{prompt}"]`) is authoritative
/// and must never be rewritten behind the user's back.
fn finalize_spawn_args(
    agent_type: &str,
    merged: &[String],
    prompt: &str,
) -> (Vec<String>, Option<String>) {
    if crate::agent::prompt_prefill_only(agent_type) {
        let argv = merged
            .iter()
            .filter(|a| !a.contains("{prompt}"))
            .cloned()
            .collect();
        (argv, Some(prompt.to_string()))
    } else {
        (substitute_prompt_in_args(merged, prompt), None)
    }
}

/// Merge MCP params (model, print_mode, output_format) into run config args.
/// Returns Ok(merged args) or Err(conflict description).
///
/// `agent_type` gates the Claude-only flags: `--print` and `--output-format` are
/// understood only by the `claude` CLI. For any other agent (codex, gemini,
/// goose, …) they are DROPPED with a `warn` — injecting them makes the child
/// clap-exit 2 and the spawn silently fails (todo.md O5). `--model` is generic
/// and passed through for every agent.
///
/// Placement: when `default_template` is true (args came from
/// `default_prompt_args`, not a user run config) claude's flags go FIRST, in
/// `--print`, `--output-format`, `--model` order — byte-identical to the retired
/// dedicated claude spawn branch, whose argv put every flag before the
/// positional prompt (story 092). Everything else — every other agent AND every
/// user-authored run config (whose args may start with a wrapper subcommand
/// flags must not precede) — keeps flags appended, as before.
const CODEX_BYPASS_ARG: &str = "--dangerously-bypass-approvals-and-sandbox";

fn is_direct_codex_executable(binary_path: &str) -> bool {
    let file_name = binary_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(binary_path);
    std::path::Path::new(file_name)
        .file_stem()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("codex"))
}

fn apply_direct_codex_defaults(binary_path: &str, mut args: Vec<String>) -> Vec<String> {
    let has_active_bypass = args
        .iter()
        .take_while(|arg| arg.as_str() != "--")
        .any(|arg| arg == CODEX_BYPASS_ARG);
    if is_direct_codex_executable(binary_path) && !has_active_bypass {
        args.insert(0, CODEX_BYPASS_ARG.to_string());
    }
    args
}

fn resolve_spawn_agent_type(binary_path: &str, configured: Option<&str>) -> Option<String> {
    if is_direct_codex_executable(binary_path) {
        Some("codex".to_string())
    } else {
        configured.map(str::to_string)
    }
}

fn codex_wrapper_launch_warning(
    effective_agent_type: Option<&str>,
    binary_path: &str,
) -> Option<String> {
    (effective_agent_type == Some("codex") && !is_direct_codex_executable(binary_path)).then(|| {
        format!(
            "Codex run config command '{}' is a wrapper; TUIC did not inject {CODEX_BYPASS_ARG} and cannot validate whether the wrapper enables it internally.",
            binary_path
        )
    })
}

struct McpSpawnArgs<'a> {
    agent_type: &'a str,
    binary_path: &'a str,
    args: &'a [String],
    prompt: &'a str,
    model: Option<&'a str>,
    print_mode: bool,
    output_format: Option<&'a str>,
    default_template: bool,
}

fn compose_mcp_spawn_args(
    spawn: McpSpawnArgs<'_>,
) -> Result<(Vec<String>, Option<String>), String> {
    let merged = merge_mcp_params_into_args(
        spawn.agent_type,
        spawn.args,
        spawn.model,
        spawn.print_mode,
        spawn.output_format,
        spawn.default_template,
    )?;
    let merged = apply_direct_codex_defaults(spawn.binary_path, merged);
    if spawn.default_template {
        Ok(finalize_spawn_args(spawn.agent_type, &merged, spawn.prompt))
    } else {
        Ok(finalize_explicit_spawn_args(
            spawn.agent_type,
            &merged,
            spawn.prompt,
        ))
    }
}

fn compose_mcp_run_config_args(
    agent_type: &str,
    binary_path: &str,
    args: &[String],
    prompt: &str,
    model: Option<&str>,
    print_mode: bool,
    output_format: Option<&str>,
) -> Result<Vec<String>, String> {
    let merged =
        merge_mcp_params_into_args(agent_type, args, model, print_mode, output_format, false)?;
    let merged = apply_direct_codex_defaults(binary_path, merged);
    Ok(substitute_prompt_in_args(&merged, prompt))
}

fn merge_mcp_params_into_args(
    agent_type: &str,
    args: &[String],
    model: Option<&str>,
    print_mode: bool,
    output_format: Option<&str>,
    default_template: bool,
) -> Result<Vec<String>, String> {
    let is_claude = agent_type == "claude";
    let base_args = args.to_vec();
    let mut flags: Vec<String> = Vec::new();

    if print_mode {
        if !is_claude {
            tracing::warn!(
                agent_type,
                "Dropping Claude-only MCP param print_mode (--print) for non-claude agent"
            );
        } else if !base_args.iter().any(|a| a.starts_with("--print")) {
            flags.push("--print".to_string());
        }
    }

    if let Some(fmt) = output_format {
        if !is_claude {
            tracing::warn!(
                agent_type,
                output_format = fmt,
                "Dropping Claude-only MCP param output_format (--output-format) for non-claude agent"
            );
        } else if base_args.iter().any(|a| a.starts_with("--output-format")) {
            return Err(format!(
                "Conflict: run config already contains --output-format but MCP param output_format=\"{}\" was also passed",
                fmt
            ));
        } else {
            flags.push("--output-format".to_string());
            flags.push(fmt.to_string());
        }
    }

    if let Some(model_val) = model {
        if base_args.iter().any(|a| a.starts_with("--model")) {
            return Err(format!(
                "Conflict: run config already contains --model but MCP param model=\"{}\" was also passed",
                model_val
            ));
        }
        flags.push("--model".to_string());
        flags.push(model_val.to_string());
    }

    let merged = if is_claude && default_template {
        let mut m = flags;
        m.extend(base_args);
        m
    } else {
        let mut m = base_args;
        m.extend(flags);
        m
    };
    Ok(merged)
}

// Re-export for tests — these need to be public enough for sibling test module
#[cfg(test)]
pub(crate) fn test_mcp_tool_definitions() -> serde_json::Value {
    native_tool_definitions()
}
#[cfg(test)]
pub(crate) fn test_translate_special_key(key: &str) -> Option<&'static str> {
    translate_special_key(key)
}
#[cfg(test)]
pub(crate) fn test_validate_mcp_repo_path(path: &str) -> Result<(), serde_json::Value> {
    validate_mcp_repo_path(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn upstream_passthrough_result() -> serde_json::Value {
        serde_json::json!({
            "content": [
                {"type": "text", "text": "upstream text"},
                {"type": "resource", "resource": {"uri": "file:///tmp/result", "text": "body"}}
            ],
            "isError": true,
            "structuredContent": {"answer": 42},
            "_meta": {"trace": "opaque"}
        })
    }

    async fn upstream_passthrough_mock(
        Json(body): Json<serde_json::Value>,
    ) -> Json<serde_json::Value> {
        Json(serde_json::json!({
            "jsonrpc": "2.0",
            "id": body.get("id").cloned().unwrap_or(serde_json::Value::Null),
            "result": upstream_passthrough_result()
        }))
    }

    async fn spawn_upstream_passthrough_mock() -> String {
        let app = axum::Router::new().route("/mcp", axum::routing::post(upstream_passthrough_mock));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://127.0.0.1:{port}/mcp")
    }

    #[test]
    fn pty_description_field_is_optional_replacement_or_clear() {
        assert!(matches!(
            parse_pty_description(&serde_json::json!({})),
            Ok(PtyDescriptionUpdate::Unchanged)
        ));
        assert_eq!(
            parse_pty_description(&serde_json::json!({"pty_description": "  Run checks  "})),
            Ok(PtyDescriptionUpdate::Set(Some("Run checks".to_string())))
        );
        assert_eq!(
            parse_pty_description(&serde_json::json!({"pty_description": ""})),
            Ok(PtyDescriptionUpdate::Set(None))
        );
        assert_eq!(
            parse_pty_description(&serde_json::json!({"pty_description": null})),
            Ok(PtyDescriptionUpdate::Set(None))
        );
        assert!(parse_pty_description(&serde_json::json!({"pty_description": 7})).is_err());
    }

    #[test]
    fn spawn_description_preserves_explicit_value_or_clear() {
        assert_eq!(
            resolve_spawn_pty_description(
                PtyDescriptionUpdate::Set(Some("Focused task".to_string())),
                "Longer prompt that must not replace the explicit description",
            ),
            Some("Focused task".to_string())
        );
        assert_eq!(
            resolve_spawn_pty_description(
                PtyDescriptionUpdate::Set(None),
                "Prompt must not override an explicit clear",
            ),
            None
        );
    }

    #[test]
    fn spawn_description_falls_back_to_compact_prompt_metadata() {
        assert_eq!(
            resolve_spawn_pty_description(
                PtyDescriptionUpdate::Unchanged,
                "  Audit all Cargo manifests\n\twithout changing files.  ",
            ),
            Some("Audit all Cargo manifests without changing files.".to_string())
        );

        let long_prompt = "è".repeat(INFERRED_PTY_DESCRIPTION_MAX_CHARS + 20);
        let inferred = resolve_spawn_pty_description(PtyDescriptionUpdate::Unchanged, &long_prompt)
            .expect("non-empty prompt produces a description");
        assert_eq!(inferred.chars().count(), INFERRED_PTY_DESCRIPTION_MAX_CHARS);
        assert!(inferred.ends_with('…'));
        assert_eq!(
            resolve_spawn_pty_description(PtyDescriptionUpdate::Unchanged, " \n\t "),
            None
        );
    }

    #[test]
    fn mcp_instructions_request_current_intent_at_task_start_and_phase_changes() {
        let state = test_state();
        let instructions = build_mcp_instructions_for_mode(&state, None, true);

        assert!(instructions.contains("at the start of every user task"));
        assert!(instructions.contains("on each material work-phase change"));
        assert!(instructions.contains("currently in progress in present tense"));

        state.config.write().intent_tab_title = false;
        let disabled = build_mcp_instructions_for_mode(&state, None, true);
        assert!(!disabled.contains("`intent: <desc> (<title>)`"));
    }

    async fn post_test_tool_call(
        state: Arc<AppState>,
        session_id: &str,
        name: &str,
        arguments: serde_json::Value,
    ) -> serde_json::Value {
        let mut headers = HeaderMap::new();
        headers.insert(MCP_SESSION_HEADER, session_id.parse().unwrap());
        let response = mcp_post(
            State(state),
            ConnectInfo(loopback_addr()),
            headers,
            Json(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 92,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments}
            })),
        )
        .await
        .into_response();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    // --- stateless tools/call (#0f44) ---

    async fn post_tool_call_with_headers(
        state: Arc<AppState>,
        headers: HeaderMap,
        name: &str,
        arguments: serde_json::Value,
    ) -> (HeaderMap, serde_json::Value) {
        let response = mcp_post(
            State(state),
            ConnectInfo(loopback_addr()),
            headers,
            Json(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments}
            })),
        )
        .await
        .into_response();
        let resp_headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (resp_headers, serde_json::from_slice(&bytes).unwrap())
    }

    /// The blanket `mcp-session-id` rejection was the single blocker to stateless
    /// operation — it refused calls that need no identity at all, including our own
    /// curl probes against :9877.
    #[tokio::test]
    async fn a_tool_that_needs_no_identity_works_without_a_session_header() {
        let state = test_state();
        let (_, body) = post_tool_call_with_headers(
            state,
            HeaderMap::new(),
            "plugin_dev_guide",
            serde_json::json!({}),
        )
        .await;

        assert!(
            body.get("error").is_none(),
            "a session-independent tool must not be gated on identity: {body}"
        );
        assert!(
            body["result"]["content"][0]["text"].is_string(),
            "the tool must actually have run: {body}"
        );
    }

    /// Identity-scoped actions must still refuse — but with the guidance the caller
    /// needs, not a bare protocol code it cannot act on.
    #[tokio::test]
    async fn an_identity_scoped_action_without_identity_explains_how_to_get_one() {
        let state = test_state();
        let (_, body) = post_tool_call_with_headers(
            state,
            HeaderMap::new(),
            "agent",
            serde_json::json!({"action": "register"}),
        )
        .await;

        assert!(
            body.get("error").is_none(),
            "the refusal belongs in the tool result, not as a JSON-RPC protocol error: {body}"
        );
        let text = body["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        assert!(
            text.contains("initialize") && text.contains("mcp-session-id"),
            "the error must name what is missing AND how to get it: {text}"
        );
        assert!(
            !text.contains("-32600"),
            "a bare protocol code is not actionable: {text}"
        );
    }

    /// Legacy clients must be untouched: the header they send is still refreshed
    /// into `mcp_sessions` and echoed back on the response.
    #[tokio::test]
    async fn a_legacy_client_still_gets_its_session_refreshed_and_echoed() {
        let state = test_state();
        let mut headers = HeaderMap::new();
        headers.insert(MCP_SESSION_HEADER, "mcp-legacy-c1".parse().unwrap());

        let (resp_headers, body) = post_tool_call_with_headers(
            Arc::clone(&state),
            headers,
            "plugin_dev_guide",
            serde_json::json!({}),
        )
        .await;

        assert!(body.get("error").is_none(), "{body}");
        assert_eq!(
            resp_headers
                .get(MCP_SESSION_HEADER)
                .and_then(|v| v.to_str().ok()),
            Some("mcp-legacy-c1"),
            "the session header must still be echoed"
        );
        assert!(
            state.mcp_sessions.contains_key("mcp-legacy-c1"),
            "a stale or first-seen session must still be (re-)registered on tools/call"
        );
    }

    #[test]
    fn tool_result_text_is_compact_and_semantically_lossless() {
        let examples = [
            serde_json::json!({
                "sessions": [{"session_id": "one", "shell_state": "idle"}],
                "count": 1,
            }),
            serde_json::json!({
                "upstream_result": {"content": [{"type": "text", "text": "ok"}]},
                "meta": null,
            }),
        ];

        for value in examples {
            let encoded = serialize_tool_result(&value);
            assert!(!encoded.contains('\n'), "tool result must be one line");
            assert!(
                !encoded.contains(": "),
                "tool result must omit pretty whitespace"
            );
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&encoded).unwrap(),
                value
            );
        }
    }

    #[test]
    fn valid_upstream_call_tool_result_passes_through_unchanged() {
        let upstream = upstream_passthrough_result();
        let marked = mark_upstream_tool_result(upstream.clone());

        assert_eq!(format_tool_call_result(&marked, false), upstream);
        assert_eq!(unmark_upstream_tool_result(marked), upstream);
    }

    #[test]
    fn malformed_upstream_result_uses_compact_text_fallback() {
        let upstream = serde_json::json!({
            "content": {"type": "text", "text": "not an array"},
            "isError": true,
            "structuredContent": {"kept": true}
        });
        let formatted =
            format_tool_call_result(&mark_upstream_tool_result(upstream.clone()), false);

        assert_eq!(formatted["isError"], false);
        let text = formatted["content"][0]["text"].as_str().unwrap();
        assert!(!text.contains('\n'));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(text).unwrap(),
            upstream
        );
    }

    #[test]
    fn native_tool_result_always_uses_compact_text_envelope() {
        let native = serde_json::json!({
            "content": [{"type": "text", "text": "native-shaped value"}],
            "isError": true,
            "structuredContent": {"must": "remain nested"}
        });
        let formatted = format_tool_call_result(&native, false);

        assert_eq!(formatted["isError"], false);
        assert_eq!(formatted["content"][0]["type"], "text");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                formatted["content"][0]["text"].as_str().unwrap()
            )
            .unwrap(),
            native
        );
    }

    /// `#[tokio::test]` gives a current-thread runtime: exactly one worker. A sync tool
    /// handler invoked inline owns that worker for its whole duration, so no other task
    /// can run — which is what made `session close`/`kill` (200ms of `std::thread::sleep`)
    /// and agent injection (`INJECT_ENTER_GAP`) stall the whole MCP server.
    ///
    /// Here the blocking closure waits for a flag that only a spawned async task can set.
    /// Routed through `spawn_blocking` the task gets its turn and the flag flips; called
    /// inline the closure spins to its deadline and reports no progress.
    #[tokio::test]
    async fn run_blocking_handler_lets_other_tasks_progress() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let signal = Arc::new(AtomicBool::new(false));

        let setter = signal.clone();
        tokio::spawn(async move {
            setter.store(true, Ordering::SeqCst);
        });

        let observed = signal.clone();
        let result = run_blocking_handler(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while !observed.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            serde_json::json!({"saw_progress": observed.load(Ordering::SeqCst)})
        })
        .await;

        assert_eq!(
            result["saw_progress"], true,
            "sync tool handlers must run on the blocking pool — running them inline parks the runtime worker"
        );
    }

    /// A panicking sync handler must surface as a tool error, not abort the request task.
    #[tokio::test]
    async fn run_blocking_handler_reports_a_panicking_handler_as_an_error() {
        let result = run_blocking_handler(|| panic!("handler exploded")).await;
        assert!(
            result["error"]
                .as_str()
                .unwrap_or_default()
                .contains("failed to complete"),
            "expected an error envelope, got {result}"
        );
    }

    #[test]
    fn only_genuinely_blocking_session_and_agent_actions_are_offloaded() {
        for action in [
            "list", "submit", "output", "status", "pause", "resume", "unknown",
        ] {
            assert!(!session_action_requires_blocking_pool(action), "{action}");
        }
        for action in ["create", "input", "kill", "close", "process_stats"] {
            assert!(session_action_requires_blocking_pool(action), "{action}");
        }
        for action in [
            "register",
            "list_peers",
            "inbox",
            "stats",
            "metrics",
            "unknown",
        ] {
            assert!(!agent_action_requires_blocking_pool(action), "{action}");
        }
        for action in ["spawn", "detect", "send"] {
            assert!(agent_action_requires_blocking_pool(action), "{action}");
        }
    }

    #[tokio::test]
    async fn mcp_post_collapsed_native_call_keeps_compact_text_envelope() {
        let state = test_state();
        let mut headers = HeaderMap::new();
        headers.insert(MCP_SESSION_HEADER, "mcp-native-envelope".parse().unwrap());

        let response = mcp_post(
            State(state),
            ConnectInfo(loopback_addr()),
            headers,
            Json(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 91,
                "method": "tools/call",
                "params": {
                    "name": "call_tool",
                    "arguments": {
                        "tool_name": "session",
                        "arguments": {}
                    }
                }
            })),
        )
        .await
        .into_response();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(body["result"]["isError"], true);
        let text = body["result"]["content"][0]["text"].as_str().unwrap();
        assert!(!text.contains('\n'));
        assert!(
            serde_json::from_str::<serde_json::Value>(text).unwrap()["error"]
                .as_str()
                .unwrap()
                .contains("action")
        );
    }

    #[tokio::test]
    async fn successful_upstream_result_passes_through_direct_and_collapsed_http_paths() {
        let state = test_state();
        let upstream_url = spawn_upstream_passthrough_mock().await;
        state.mcp_upstream_registry.inject_ready_http_upstream(
            "passthrough",
            &upstream_url,
            &["inspect"],
        );
        let expected = upstream_passthrough_result();

        let direct = post_test_tool_call(
            Arc::clone(&state),
            "mcp-upstream-direct",
            "passthrough__inspect",
            serde_json::json!({"mode": "direct"}),
        )
        .await;
        assert_eq!(direct["result"], expected);
        assert!(
            !serde_json::to_string(&direct)
                .unwrap()
                .contains(UPSTREAM_TOOL_RESULT_MARKER),
            "the private marker must not leak through the direct path"
        );

        let collapsed = post_test_tool_call(
            state,
            "mcp-upstream-collapsed",
            "call_tool",
            serde_json::json!({
                "tool_name": "passthrough__inspect",
                "arguments": {"mode": "collapsed"}
            }),
        )
        .await;
        assert_eq!(collapsed["result"], expected);
        assert!(
            !serde_json::to_string(&collapsed)
                .unwrap()
                .contains(UPSTREAM_TOOL_RESULT_MARKER),
            "the private marker must not leak through the collapsed path"
        );
    }

    #[test]
    fn worktree_remove_success_omits_absent_warning() {
        let clean = worktree_remove_success_response(None);
        assert_eq!(clean["ok"], true);
        assert!(clean.get("branch_delete_warning").is_none());

        let warned = worktree_remove_success_response(Some("branch retained".to_string()));
        assert_eq!(warned["branch_delete_warning"], "branch retained");
    }

    #[tokio::test]
    async fn github_dispatch_reports_missing_and_unknown_actions() {
        let state = test_state();

        let missing = handle_github(&state, &serde_json::json!({})).await;
        assert!(missing["error"].as_str().unwrap().contains("action"));

        let unknown = handle_github(&state, &serde_json::json!({"action": "explode"})).await;
        let error = unknown["error"].as_str().unwrap();
        assert!(error.contains("Unknown action 'explode'"));
        for action in ["prs", "status", "issues", "close_issue", "reopen_issue"] {
            assert!(
                error.contains(action),
                "available actions omitted {action}: {error}"
            );
        }
    }

    #[tokio::test]
    async fn github_dispatch_validates_required_paths_before_io() {
        let state = test_state();

        for action in ["prs", "issues", "close_issue", "reopen_issue"] {
            let response = handle_github(&state, &serde_json::json!({"action": action})).await;
            assert!(
                response["error"].as_str().unwrap().contains("path"),
                "{action} must reject a missing path: {response}"
            );
        }
    }

    #[tokio::test]
    async fn github_issue_mutations_require_a_nonzero_issue_number() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy();

        for action in ["close_issue", "reopen_issue"] {
            let response =
                handle_github(&state, &serde_json::json!({"action": action, "path": path})).await;
            assert_eq!(
                response["error"], "Missing required parameter: issue_number",
                "{action} must validate issue_number before network access"
            );
        }
    }

    fn test_state() -> Arc<AppState> {
        let state = Arc::new(AppState {
            sessions: dashmap::DashMap::new(),
            live_pty_by_tuic_session: dashmap::DashMap::new(),
            data_dir: std::env::temp_dir().join("test-tuic-data"),
            worktrees_dir: std::env::temp_dir().join("test-worktrees"),
            metrics: crate::SessionMetrics::new(),
            output_buffers: dashmap::DashMap::new(),
            mcp_sessions: dashmap::DashMap::new(),
            ws_clients: dashmap::DashMap::new(),
            config: parking_lot::RwLock::new(crate::config::AppConfig::default()),
            git_cache: crate::state::GitCacheState::new(),
            repo_watchers: dashmap::DashMap::new(),
            repo_git_fingerprints: dashmap::DashMap::new(),
            repo_head_targets: dashmap::DashMap::new(),
            repo_head_emits_suppressed: std::sync::atomic::AtomicU64::new(0),
            dir_watchers: dashmap::DashMap::new(),
            theme_watcher: parking_lot::Mutex::new(None),
            mdkb_daemon: crate::mdkb_daemon::create_shared_daemon(),
            http_client: reqwest::Client::new(),
            github_token: parking_lot::RwLock::new(None),
            github_token_source: parking_lot::RwLock::new(Default::default()),
            github_circuit_breaker: crate::github::GitHubCircuitBreaker::new(),
            github_poller: parking_lot::Mutex::new(None),
            github_viewer_login: parking_lot::RwLock::new(None),
            github_rate_limit_remaining: std::sync::atomic::AtomicU32::new(u32::MAX),
            ghe_state: dashmap::DashMap::new(),
            server_shutdown: parking_lot::Mutex::new(None),
            ipc_started: std::sync::atomic::AtomicBool::new(false),
            session_token: parking_lot::RwLock::new(uuid::Uuid::new_v4().to_string()),
            auth_rate_limits: dashmap::DashMap::new(),
            #[cfg(feature = "desktop")]
            app_handle: parking_lot::RwLock::new(None),
            plugin_watchers: dashmap::DashMap::new(),
            ansi_colors: parking_lot::RwLock::new(None),
            vt_log_buffers: dashmap::DashMap::new(),
            pty_raw_rings: dashmap::DashMap::new(),
            #[cfg(feature = "desktop")]
            grid_channels: dashmap::DashMap::new(),
            grid_watch: dashmap::DashMap::new(),
            grid_gates: dashmap::DashMap::new(),
            pending_scroll: dashmap::DashMap::new(),
            kitty_states: dashmap::DashMap::new(),
            input_buffers: dashmap::DashMap::new(),
            last_prompts: dashmap::DashMap::new(),
            pty_descriptions: dashmap::DashMap::new(),
            silence_states: dashmap::DashMap::new(),
            claude_usage_cache: parking_lot::Mutex::new(std::collections::HashMap::new()),
            log_buffer: std::sync::Arc::new(parking_lot::Mutex::new(
                crate::app_logger::LogRingBuffer::new(crate::app_logger::LOG_RING_CAPACITY),
            )),
            event_bus: tokio::sync::broadcast::channel(256).0,
            event_counter: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            sse_filters: Default::default(),
            session_states: dashmap::DashMap::new(),
            session_state_events: crate::state::SessionStateEventQueue::new(),
            mcp_upstream_registry: std::sync::Arc::new(
                crate::mcp_proxy::registry::UpstreamRegistry::new(),
            ),
            oauth_flow_manager: std::sync::Arc::new(crate::mcp_oauth::flow::OAuthFlowManager::new(
                std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
            )),
            mcp_tools_changed: tokio::sync::broadcast::channel(16).0,
            tool_search_index: std::sync::Arc::new(parking_lot::RwLock::new(
                crate::tool_search::ToolSearchIndex::build(&[]),
            )),
            content_indices: dashmap::DashMap::new(),
            index_in_flight: std::sync::Arc::new(dashmap::DashSet::new()),
            worktree_recreate_in_flight: std::sync::Arc::new(dashmap::DashSet::new()),
            index_build_sem: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
            monitoring_git_sem: std::sync::Arc::new(tokio::sync::Semaphore::new(
                crate::state::MONITORING_GIT_CONCURRENCY,
            )),
            indexer_throttle: std::sync::Arc::new(crate::content_index::IndexerThrottle::default()),
            slash_mode: dashmap::DashMap::new(),
            last_output_ms: dashmap::DashMap::new(),
            last_input_ms: dashmap::DashMap::new(),
            shell_states: dashmap::DashMap::new(),
            terminal_rows: dashmap::DashMap::new(),
            resize_locks: dashmap::DashMap::new(),
            exit_codes: dashmap::DashMap::new(),
            shell_state_since_ms: dashmap::DashMap::new(),
            loaded_plugins: dashmap::DashMap::new(),
            plugin_output_watchers: parking_lot::RwLock::new(Default::default()),
            relay: crate::state::RelayState::new(),
            peer_agents: dashmap::DashMap::new(),
            agent_inbox: dashmap::DashMap::new(),
            agent_inbox_evictions: dashmap::DashMap::new(),
            agent_read_cursor: dashmap::DashMap::new(),
            marker_stats: dashmap::DashMap::new(),
            pending_injections: dashmap::DashMap::new(),
            pending_initial_prompts: dashmap::DashMap::new(),
            active_agent_waiters: dashmap::DashMap::new(),
            orchestrator_peers: dashmap::DashSet::new(),
            session_html_tabs: dashmap::DashMap::new(),
            mcp_to_session: dashmap::DashMap::new(),
            session_to_mcp: dashmap::DashMap::new(),
            session_parent: dashmap::DashMap::new(),
            messaging_channels: dashmap::DashMap::new(),
            pty_event_channels: dashmap::DashMap::new(),
            session_knowledge: dashmap::DashMap::new(),
            knowledge_dirty: dashmap::DashMap::new(),
            has_osc133_integration: dashmap::DashMap::new(),
            file_sandboxes: dashmap::DashMap::new(),
            unrestricted_sessions: dashmap::DashMap::new(),
            #[cfg(unix)]
            bound_socket_path: parking_lot::RwLock::new(std::path::PathBuf::new()),
            tailscale_state: parking_lot::RwLock::new(
                crate::tailscale::TailscaleState::NotInstalled,
            ),
            push_store: crate::push::PushStore::load(&std::env::temp_dir()),
            desktop_window_focused: std::sync::atomic::AtomicBool::new(true),
            server_start_time: std::time::Instant::now(),
            term_aliases: dashmap::DashMap::new(),
            term_alias_counters: dashmap::DashMap::new(),
            session_visibility: dashmap::DashMap::new(),
            watcher_engine: std::sync::OnceLock::new(),
            trigger_classifier: crate::ai_agent::triggers::TriggerClassifier::new(),
            ai_suggestions_enabled: dashmap::DashMap::new(),
            grid_frame_dirty: dashmap::DashMap::new(),
            sync_update_active: dashmap::DashMap::new(),
            tunnel_manager: {
                let audit = std::sync::Arc::new(parking_lot::Mutex::new(
                    crate::tunnels::audit::AuditLog::open(
                        &std::env::temp_dir().join("test-tunnel-audit.db"),
                    )
                    .unwrap(),
                ));
                std::sync::Arc::new(crate::tunnels::manager::TunnelManager::new(audit))
            },
            tunnel_audit: std::sync::Arc::new(parking_lot::Mutex::new(
                crate::tunnels::audit::AuditLog::open(
                    &std::env::temp_dir().join("test-tunnel-audit2.db"),
                )
                .unwrap(),
            )),
            tasks: std::sync::Arc::new(crate::tasks::TaskRegistry::new()),
            connections_lock: tokio::sync::Mutex::new(()),
            screenshot_responses: dashmap::DashMap::new(),
            confirm_responses: dashmap::DashMap::new(),
            standby_sessions: dashmap::DashMap::new(),
            process_snapshot_cache: crate::pty::ProcessSnapshotCache::default(),
            hot_repo_paths: parking_lot::RwLock::new(std::collections::HashSet::new()),
        });
        // Tests start with all native tools enabled (override production default
        // which disables config, knowledge, debug).
        state.config.write().disabled_native_tools = Vec::new();
        // Populate the cached tool search index so handlers that read from
        // it (search_tools, get_tool_schema) work in tests without requiring
        // the background updater task.
        rebuild_tool_search_index(&state);
        state
    }

    #[tokio::test]
    async fn session_create_emits_event_bus_session_created() {
        let state = test_state();
        let mut rx = state.event_bus.subscribe();

        let args = serde_json::json!({"action": "create"});
        let result = handle_session(&state, &args, None);

        // Skip if PTY cannot be opened (sandbox/CI without /dev/ptmx access)
        if result.get("error").is_some() {
            eprintln!("Skipping: PTY not available in this environment");
            return;
        }

        // Session should have been created successfully
        assert!(
            result.get("session_id").is_some(),
            "Expected session_id in result: {result}"
        );

        // event_bus should have received SessionCreated
        let event = rx
            .try_recv()
            .expect("Expected SessionCreated event on event_bus");
        match event {
            crate::state::AppEvent::SessionCreated { session_id, .. } => {
                assert_eq!(session_id, result["session_id"].as_str().unwrap());
            }
            other => panic!("Expected SessionCreated, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn session_list_omits_absent_optional_fields() {
        let state = test_state();
        let created = handle_session(&state, &serde_json::json!({"action": "create"}), None);
        if created.get("error").is_some() {
            eprintln!("Skipping: PTY not available in this environment");
            return;
        }
        let session_id = created["session_id"].as_str().unwrap();
        let listed = handle_session(&state, &serde_json::json!({"action": "list"}), None);
        let entry = listed
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["session_id"] == session_id)
            .unwrap()
            .as_object()
            .unwrap();

        for absent in [
            "display_name",
            "cwd",
            "worktree_path",
            "worktree_branch",
            "agent_state",
        ] {
            assert!(!entry.contains_key(absent), "{absent} must be omitted");
        }
        assert!(entry.contains_key("background_work"));
        assert!(entry.contains_key("standby"));
        assert!(entry.contains_key("is_caller"));

        let _ = handle_session(
            &state,
            &serde_json::json!({"action": "kill", "session_id": session_id}),
            None,
        );
    }

    #[tokio::test]
    async fn session_create_registers_vt_log_and_last_output() {
        let state = test_state();
        let args = serde_json::json!({"action": "create"});
        let result = handle_session(&state, &args, None);

        // Skip if PTY cannot be opened (sandbox/CI without /dev/ptmx access)
        if result.get("error").is_some() {
            eprintln!("Skipping: PTY not available in this environment");
            return;
        }

        let sid = result["session_id"].as_str().unwrap();

        assert!(
            state.vt_log_buffers.contains_key(sid),
            "vt_log_buffers should contain session"
        );
        assert!(
            state.last_output_ms.contains_key(sid),
            "last_output_ms should contain session"
        );
        assert!(
            state.output_buffers.contains_key(sid),
            "output_buffers should contain session"
        );
    }

    #[tokio::test]
    async fn session_input_updates_same_input_state_as_http_write() {
        let state = test_state();
        let result = handle_session(&state, &serde_json::json!({"action": "create"}), None);
        if result.get("error").is_some() {
            eprintln!("Skipping: PTY not available in this environment");
            return;
        }
        let sid = result["session_id"].as_str().unwrap();

        let input = handle_session(
            &state,
            &serde_json::json!({"action": "input", "session_id": sid, "input": "/"}),
            None,
        );

        assert!(input.get("error").is_none(), "unexpected error: {input}");
        assert!(
            state
                .last_input_ms
                .get(sid)
                .is_some_and(|stamp| stamp.load(std::sync::atomic::Ordering::Relaxed) > 0),
            "MCP session(input) must stamp last_input_ms"
        );
        assert!(
            state
                .slash_mode
                .get(sid)
                .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed)),
            "MCP session(input) must feed InputLineBuffer and enter slash mode for '/'"
        );
    }

    #[tokio::test]
    async fn create_worktree_http_rejects_invalid_repo_path_before_git() {
        use axum::response::IntoResponse;

        let state = test_state();
        let response = crate::mcp_http::worktree_routes::create_worktree_http(
            axum::extract::State(state),
            axum::Json(crate::mcp_http::types::CreateWorktreeRequest {
                base_repo: "relative/path".to_string(),
                branch_name: "feature/test".to_string(),
                base_ref: None,
            }),
        )
        .await
        .into_response();

        assert_eq!(
            response.status(),
            axum::http::StatusCode::BAD_REQUEST,
            "invalid repo paths must be rejected before git worktree creation"
        );
    }

    // ── initialize auto-identity tests (Step 1) ─────────────────────

    /// Spawn binary for tests that read state belonging to the child *after* the
    /// spawn returns — its inbox, its peer entry, its parent link, its task
    /// status. `/usr/bin/true` exits before the first read and the exit cleanup
    /// deletes the very state under test, so those tests only passed by winning a
    /// race. `/bin/cat` blocks on stdin; every test using it kills the session at
    /// the end. Tests that only read the spawn response keep `/usr/bin/true`.
    const LONG_LIVED_TEST_BINARY: &str = "/bin/cat";

    const TEST_UUID_A: &str = "550e8400-e29b-41d4-a716-446655440a01";
    const TEST_UUID_B: &str = "550e8400-e29b-41d4-a716-446655440a02";

    #[cfg(unix)]
    fn insert_managed_test_session(state: &Arc<AppState>, session_id: &str, cwd: &str) {
        use crate::state::PtySession;
        use portable_pty::{CommandBuilder, PtySize, native_pty_system};

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open test PTY");
        let child = pair
            .slave
            .spawn_command(CommandBuilder::new("true"))
            .expect("spawn test PTY child");
        let writer = pair.master.take_writer().expect("open test PTY writer");
        state.sessions.insert(
            session_id.to_string(),
            parking_lot::Mutex::new(PtySession {
                writer: Arc::new(parking_lot::Mutex::new(writer)),
                master: pair.master,
                _child: child,
                paused: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                worktree: None,
                cwd: Some(cwd.to_string()),
                display_name: None,
                display_name_is_custom: false,
                is_remote: false,
                shell: "true".to_string(),
            }),
        );
    }

    #[cfg(unix)]
    struct SubmissionRecordingWriter {
        bytes: Arc<std::sync::Mutex<Vec<u8>>>,
    }

    #[cfg(unix)]
    impl std::io::Write for SubmissionRecordingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.bytes.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Install the smallest raw-mode adapter around the production submission
    /// state machine: a recording PTY writer plus the real composer, lifecycle,
    /// turn-epoch, queue, and child-output ring owned by AppState.
    #[cfg(unix)]
    fn install_atomic_submit_test_session(
        state: &Arc<AppState>,
        session_id: &str,
    ) -> Arc<std::sync::Mutex<Vec<u8>>> {
        insert_managed_test_session(state, session_id, "/tmp");
        let bytes = Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer: Box<dyn std::io::Write + Send> = Box::new(SubmissionRecordingWriter {
            bytes: Arc::clone(&bytes),
        });
        state.sessions.get(session_id).unwrap().lock().writer =
            Arc::new(parking_lot::Mutex::new(writer));
        state.session_states.insert(
            session_id.to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                ..Default::default()
            },
        );
        state.shell_states.insert(
            session_id.to_string(),
            std::sync::atomic::AtomicU8::new(crate::pty::SHELL_IDLE),
        );
        let mut silence = crate::pty::SilenceState::new();
        silence.confirm_idle();
        state.silence_states.insert(
            session_id.to_string(),
            Arc::new(parking_lot::Mutex::new(silence)),
        );
        state.output_buffers.insert(
            session_id.to_string(),
            parking_lot::Mutex::new(OutputRingBuffer::new(4096)),
        );
        bytes
    }

    #[cfg(unix)]
    async fn submit_with_child_movement(
        state: &Arc<AppState>,
        session_id: &str,
        input: &str,
        bytes: &Arc<std::sync::Mutex<Vec<u8>>>,
    ) -> serde_json::Value {
        let call_state = Arc::clone(state);
        let args = serde_json::json!({
            "action": "submit",
            "session_id": session_id,
            "input": input,
            "timeout_ms": 1_000,
        });
        let call = tokio::spawn(async move {
            handle_mcp_tool_call(&call_state, loopback_addr(), "session", &args, None).await
        });
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            if bytes.lock().unwrap().last() == Some(&b'\r') {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "submit did not finish its framed PTY write"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        state
            .output_buffers
            .get(session_id)
            .unwrap()
            .lock()
            .write(b"child moved");
        call.await.unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn session_submit_returns_acknowledged_receipt_in_the_same_call() {
        let state = test_state();
        let session_id = "submit-ack";
        let bytes = install_atomic_submit_test_session(&state, session_id);

        let response =
            submit_with_child_movement(&state, session_id, "inspect the repository", &bytes).await;

        assert_eq!(response["status"], "acknowledged");
        assert_eq!(response["submitted"], true);
        assert_eq!(response["write_state"], "complete");
        assert_eq!(response["acknowledged"], true);
        assert_eq!(response["retry_safe"], false);
        assert_eq!(response["turn_epoch"], 1);
        assert_eq!(response["composer_state"], "cleared");
        assert_eq!(response["acknowledgement"]["kind"], "terminal_movement");
        assert_eq!(
            response["acknowledgement"]["screen_state"],
            "terminal_output"
        );
        assert_eq!(response["acknowledgement"]["output_offset"], 11);
        Uuid::parse_str(response["submission_id"].as_str().unwrap()).unwrap();
        let keys: std::collections::BTreeSet<_> = response
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            std::collections::BTreeSet::from([
                "acknowledged",
                "acknowledgement",
                "composer_state",
                "retry_safe",
                "status",
                "submission_id",
                "submitted",
                "turn_epoch",
                "write_state",
            ])
        );
        assert_eq!(
            bytes.lock().unwrap().as_slice(),
            b"\x15inspect the repository\r"
        );
        assert_eq!(
            state
                .input_buffers
                .get(session_id)
                .unwrap()
                .lock()
                .content(),
            ""
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn session_submit_write_only_cannot_false_positive_and_times_out() {
        let state = test_state();
        let session_id = "submit-timeout";
        let bytes = install_atomic_submit_test_session(&state, session_id);

        let response = handle_mcp_tool_call(
            &state,
            loopback_addr(),
            "session",
            &serde_json::json!({
                "action": "submit",
                "session_id": session_id,
                "input": "no child output",
                "timeout_ms": 1,
            }),
            None,
        )
        .await;

        assert_eq!(bytes.lock().unwrap().as_slice(), b"\x15no child output\r");
        assert_eq!(
            state
                .output_buffers
                .get(session_id)
                .unwrap()
                .lock()
                .total_written,
            0,
            "FastAF's own write must not move the child-output receipt boundary"
        );
        assert_eq!(response["status"], "ack_timeout");
        assert_eq!(response["submitted"], true);
        assert_eq!(response["acknowledged"], false);
        assert_eq!(response["retry_safe"], false);
        assert_eq!(response["reason"], "no_terminal_movement_after_enter");
        assert_eq!(response["timeout_ms"], SUBMIT_ACK_MIN_MS);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn session_submit_rejects_a_preexisting_partial_composer() {
        let state = test_state();
        let session_id = "submit-partial";
        let bytes = install_atomic_submit_test_session(&state, session_id);
        let mut composer = crate::input_line_buffer::InputLineBuffer::new();
        composer.feed("Boss draft");
        state
            .input_buffers
            .insert(session_id.to_string(), parking_lot::Mutex::new(composer));

        let response = handle_mcp_tool_call(
            &state,
            loopback_addr(),
            "session",
            &serde_json::json!({
                "action": "submit",
                "session_id": session_id,
                "input": "replacement",
            }),
            None,
        )
        .await;

        assert_eq!(response["status"], "rejected");
        assert_eq!(response["submitted"], false);
        assert_eq!(response["write_state"], "not_started");
        assert_eq!(response["retry_safe"], true);
        assert_eq!(response["reason"], "partial_composer");
        assert_eq!(response["composer_state"], "partial");
        assert!(bytes.lock().unwrap().is_empty());
        assert_eq!(
            state
                .input_buffers
                .get(session_id)
                .unwrap()
                .lock()
                .content(),
            "Boss draft"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn session_submit_slash_clear_uses_the_same_receipt_and_fsm() {
        let state = test_state();
        let session_id = "submit-clear";
        let bytes = install_atomic_submit_test_session(&state, session_id);

        let response = submit_with_child_movement(&state, session_id, "/clear", &bytes).await;

        assert_eq!(response["status"], "acknowledged");
        assert_eq!(response["turn_epoch"], 1);
        assert_eq!(bytes.lock().unwrap().as_slice(), b"\x15/clear\r");
        assert!(
            !state
                .slash_mode
                .get(session_id)
                .unwrap()
                .load(std::sync::atomic::Ordering::Relaxed)
        );
        assert_eq!(
            state
                .input_buffers
                .get(session_id)
                .unwrap()
                .lock()
                .content(),
            ""
        );
    }

    #[cfg(unix)]
    #[test]
    fn session_input_remains_a_raw_write_only_compatibility_surface() {
        let state = test_state();
        let session_id = "input-compat";
        let bytes = install_atomic_submit_test_session(&state, session_id);

        let response = handle_session(
            &state,
            &serde_json::json!({
                "action": "input",
                "session_id": session_id,
                "input": "literal draft",
            }),
            None,
        );

        assert_eq!(response, serde_json::json!({"ok": true}));
        assert_eq!(bytes.lock().unwrap().as_slice(), b"literal draft");
        assert_eq!(state.session_states.get(session_id).unwrap().turn_epoch, 0);
        assert_eq!(
            state
                .input_buffers
                .get(session_id)
                .unwrap()
                .lock()
                .content(),
            "literal draft"
        );
    }

    #[tokio::test]
    async fn session_submit_is_rejected_before_io_for_non_loopback_callers() {
        let state = test_state();

        let response = handle_mcp_tool_call(
            &state,
            non_loopback_addr(),
            "session",
            &serde_json::json!({
                "action": "submit",
                "session_id": "remote-target",
                "input": "must not run",
            }),
            None,
        )
        .await;

        assert!(
            response["error"]
                .as_str()
                .is_some_and(|error| error.contains("restricted to localhost"))
        );
        assert!(state.sessions.is_empty());
    }

    #[test]
    fn initialize_identity_auto_binds_from_header() {
        let state = test_state();
        let bound = apply_initialize_identity(&state, "mcp-init-1", Some(TEST_UUID_A));
        assert!(bound, "valid header must auto-bind");
        assert_eq!(
            state
                .mcp_to_session
                .get("mcp-init-1")
                .map(|v| v.value().clone()),
            Some(TEST_UUID_A.to_string()),
            "forward map mcp→tuic must be populated"
        );
        assert!(
            state.peer_agents.contains_key(TEST_UUID_A),
            "peer must be auto-registered so spawn gets multi-agent context"
        );
        assert!(
            state
                .session_to_mcp
                .get(TEST_UUID_A)
                .map(|v| v.contains(&"mcp-init-1".to_string()))
                .unwrap_or(false),
            "reverse map must contain the mcp session for O(1) cleanup"
        );
    }

    /// A client that comes back holding a reaped session id used to be
    /// indistinguishable from a first-time client: both silently received a fresh
    /// UUID. That is precisely the moment an agent announces "FastAF is
    /// back", so the three arrivals must be told apart or the claim stays
    /// unfalsifiable — the peer-binding takeover warn only fires when a prior
    /// binding happened to exist, which a reaped session no longer has.
    #[test]
    fn initialize_tells_a_reconnect_apart_from_a_first_contact() {
        let state = test_state();
        let live = "11111111-1111-4111-8111-111111111111";
        state.mcp_sessions.insert(
            live.to_string(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code: false,
                requires_meta_tools: false,
                has_sse_stream: false,
                sse_generation: 0,
                repo_path: None,
            },
        );

        let with_session = |sid: Option<&str>| {
            let mut headers = HeaderMap::new();
            if let Some(sid) = sid {
                headers.insert(MCP_SESSION_HEADER, sid.parse().unwrap());
            }
            initialize_session_id(&state, &headers)
        };

        let (id, kind) = with_session(None);
        assert_eq!(kind, InitializeKind::Fresh);
        assert!(is_valid_uuid(&id), "a first contact still gets an id");

        let (id, kind) = with_session(Some(live));
        assert_eq!(kind, InitializeKind::Resumed, "same connection continuing");
        assert_eq!(id, live, "a live session id must be kept, not re-minted");

        let reaped = "22222222-2222-4222-8222-222222222222";
        let (id, kind) = with_session(Some(reaped));
        assert_eq!(
            kind,
            InitializeKind::Reconnected {
                presented: reaped.to_string()
            },
            "a session id we no longer hold is a reconnect, and the log must name it"
        );
        assert_ne!(id, reaped, "the stale id is replaced");
        assert_eq!(kind.as_str(), "reconnected");
    }

    #[test]
    fn initialize_identity_ignores_invalid_or_missing_header() {
        let state = test_state();
        assert!(!apply_initialize_identity(&state, "mcp-x", None));
        assert!(!apply_initialize_identity(&state, "mcp-x", Some("")));
        assert!(!apply_initialize_identity(
            &state,
            "mcp-x",
            Some("not-a-uuid")
        ));
        assert!(state.mcp_to_session.is_empty(), "no binding on bad header");
        assert!(state.peer_agents.is_empty());
    }

    #[test]
    fn takeover_rejection_reports_first_then_suppresses_repeats() {
        // A duplicated MCP registration retries every 3s forever. The first
        // rejection must be visible; the rest must not bury the log.
        let pair = ("takeover-tuic-a", "takeover-mcp-a");

        assert_eq!(
            takeover_rejection_report(pair.0, pair.1),
            Some(0),
            "first sighting of a claimant pair must be reported in full"
        );

        for _ in 0..2000 {
            assert!(
                takeover_rejection_report(pair.0, pair.1).is_none(),
                "repeats inside the summary window must not reach WARN"
            );
        }
    }

    #[test]
    fn takeover_rejection_reports_each_distinct_pair() {
        // Suppression is per claimant: a genuinely new offender must never be
        // hidden by an unrelated pair already in its silent window.
        assert_eq!(takeover_rejection_report("tuic-x", "mcp-1"), Some(0));
        assert!(takeover_rejection_report("tuic-x", "mcp-1").is_none());

        assert_eq!(
            takeover_rejection_report("tuic-x", "mcp-2"),
            Some(0),
            "a different claiming MCP session is a distinct event"
        );
        assert_eq!(
            takeover_rejection_report("tuic-y", "mcp-1"),
            Some(0),
            "a different TUIC identity is a distinct event"
        );
    }

    #[test]
    fn takeover_rejection_summary_carries_suppressed_count() {
        let pair = ("takeover-tuic-b", "takeover-mcp-b");
        assert_eq!(takeover_rejection_report(pair.0, pair.1), Some(0));

        for _ in 0..7 {
            assert!(takeover_rejection_report(pair.0, pair.1).is_none());
        }

        // Force the summary window open without sleeping 5 minutes.
        {
            let mut log = TAKEOVER_REJECT_LOG.lock();
            let entry = log
                .get_mut(&(pair.0.to_string(), pair.1.to_string()))
                .expect("entry recorded on first sighting");
            entry.last_reported -= TAKEOVER_REJECT_SUMMARY_INTERVAL;
        }

        assert_eq!(
            takeover_rejection_report(pair.0, pair.1),
            Some(7),
            "the summary must state how many occurrences were swallowed"
        );
        assert!(
            takeover_rejection_report(pair.0, pair.1).is_none(),
            "counter resets after a summary — the next window starts silent"
        );
    }

    #[test]
    fn takeover_rejection_forgets_idle_claimants() {
        // Without eviction a long-lived app leaks one entry per short-lived
        // MCP session.
        let pair = ("takeover-tuic-c", "takeover-mcp-c");
        assert_eq!(takeover_rejection_report(pair.0, pair.1), Some(0));

        {
            let mut log = TAKEOVER_REJECT_LOG.lock();
            let entry = log
                .get_mut(&(pair.0.to_string(), pair.1.to_string()))
                .expect("entry recorded on first sighting");
            entry.last_reported -= TAKEOVER_REJECT_ENTRY_TTL;
        }

        assert_eq!(
            takeover_rejection_report(pair.0, pair.1),
            Some(0),
            "an evicted pair is reported as new, not as a suppressed repeat"
        );
        assert!(
            !TAKEOVER_REJECT_LOG.lock().contains_key(&(
                "takeover-tuic-c".to_string(),
                "stale-never-seen".to_string()
            )),
            "eviction must not resurrect unrelated keys"
        );
    }

    /// Codex opens two bridge processes inside one PTY. Both inherit the same
    /// `$TUIC_SESSION`, so both assert the same header — they are one agent, not
    /// competing claimants. The second must become routable instead of being
    /// locked out, or every tool call it makes reports "not registered".
    #[test]
    fn initialize_identity_joins_live_sibling_bridge_in_same_pty() {
        let state = test_state();
        assert!(apply_initialize_identity(
            &state,
            "mcp-live",
            Some(TEST_UUID_A)
        ));
        live_mcp_session(&state, "mcp-live");

        assert!(
            apply_initialize_identity(&state, "mcp-sibling", Some(TEST_UUID_A)),
            "a second bridge asserting the same $TUIC_SESSION must join the identity"
        );
        assert_eq!(
            state
                .mcp_to_session
                .get("mcp-sibling")
                .map(|entry| entry.value().clone()),
            Some(TEST_UUID_A.to_string()),
            "the sibling needs a forward route or inbox/send stay unreachable"
        );
        assert_eq!(
            state
                .mcp_to_session
                .get("mcp-live")
                .map(|entry| entry.value().clone()),
            Some(TEST_UUID_A.to_string()),
            "joining must not evict the bridge that was already routed"
        );
        assert_eq!(
            state.peer_agents.get(TEST_UUID_A).unwrap().mcp_session_id,
            "mcp-live",
            "delivery ownership stays put: two live siblings must not trade it \
             back and forth on every request"
        );
        assert_eq!(
            state
                .session_to_mcp
                .get(TEST_UUID_A)
                .map(|entry| entry.clone()),
            Some(vec!["mcp-live".to_string(), "mcp-sibling".to_string()])
        );
    }

    /// The joined sibling is the bridge the agent actually talks through, so the
    /// rename it performs must land instead of being refused as a takeover.
    #[test]
    fn register_from_joined_sibling_bridge_renames_shared_identity() {
        let state = test_state();
        apply_initialize_identity(&state, "mcp-live", Some(TEST_UUID_A));
        live_mcp_session(&state, "mcp-live");
        apply_initialize_identity(&state, "mcp-sibling", Some(TEST_UUID_A));

        let registered = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": TEST_UUID_A, "name": "rose-root-orchestrator"
            }),
            Some("mcp-sibling"),
        );

        assert_eq!(
            registered["ok"], true,
            "a co-owner of the identity must not be refused: {registered}"
        );
        assert_eq!(
            state.peer_agents.get(TEST_UUID_A).unwrap().name,
            "rose-root-orchestrator"
        );
        assert_eq!(
            state.peer_agents.get(TEST_UUID_A).unwrap().mcp_session_id,
            "mcp-live",
            "a rename must not move delivery ownership"
        );
    }

    /// The guard still has a job: a session with no route to the identity and no
    /// header behind it is a stranger, not a sibling.
    #[test]
    fn register_rejects_takeover_from_unrouted_session_while_owner_is_live() {
        let state = test_state();
        apply_initialize_identity(&state, "mcp-live", Some(TEST_UUID_A));
        live_mcp_session(&state, "mcp-live");

        let rejected = handle_messaging(
            &state,
            &serde_json::json!({"action": "register", "tuic_session": TEST_UUID_A}),
            Some("mcp-stranger"),
        );

        assert!(
            rejected["error"]
                .as_str()
                .unwrap_or_default()
                .contains("already registered to another active MCP session"),
            "an unrouted claimant must still be refused: {rejected}"
        );
        assert_eq!(
            state.peer_agents.get(TEST_UUID_A).unwrap().mcp_session_id,
            "mcp-live"
        );
        assert!(
            !state.mcp_to_session.contains_key("mcp-stranger"),
            "a rejected claimant must gain no forward route"
        );
    }

    #[test]
    fn initialize_identity_reclaims_stale_owner_and_retires_old_routing() {
        let state = test_state();
        assert!(apply_initialize_identity(
            &state,
            "mcp-old",
            Some(TEST_UUID_A)
        ));
        state.mcp_sessions.insert(
            "mcp-old".to_string(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now()
                    - MCP_OWNER_ACTIVITY_GRACE
                    - std::time::Duration::from_secs(1),
                is_claude_code: false,
                requires_meta_tools: false,
                has_sse_stream: true,
                sse_generation: 0,
                repo_path: None,
            },
        );

        assert!(apply_initialize_identity(
            &state,
            "mcp-new",
            Some(TEST_UUID_A)
        ));
        assert_eq!(
            state.peer_agents.get(TEST_UUID_A).unwrap().mcp_session_id,
            "mcp-new"
        );
        assert!(
            state.mcp_to_session.get("mcp-old").is_none(),
            "stale owner must lose its forward route"
        );
        assert_eq!(
            state
                .session_to_mcp
                .get(TEST_UUID_A)
                .map(|entry| entry.clone()),
            Some(vec!["mcp-new".to_string()])
        );
    }

    #[test]
    fn initialize_identity_refreshes_same_live_session_without_duplicate_route() {
        let state = test_state();
        apply_initialize_identity(&state, "mcp-dup", Some(TEST_UUID_A));
        live_mcp_session(&state, "mcp-dup");
        apply_initialize_identity(&state, "mcp-dup", Some(TEST_UUID_A));
        let reverse = state.session_to_mcp.get(TEST_UUID_A).unwrap();
        assert_eq!(
            reverse.iter().filter(|s| *s == "mcp-dup").count(),
            1,
            "same mcp session must not be pushed twice"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn proxied_initialize_reuses_eager_live_session_and_keeps_spawn_ready() {
        let state = test_state();
        let eager_mcp_session = TEST_UUID_B;
        state.mcp_sessions.insert(
            eager_mcp_session.to_string(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code: true,
                requires_meta_tools: false,
                has_sse_stream: true,
                sse_generation: 0,
                repo_path: None,
            },
        );
        assert!(apply_initialize_identity(
            &state,
            eager_mcp_session,
            Some(TEST_UUID_A)
        ));
        let (sender, _live_sse) = tokio::sync::broadcast::channel(4);
        state
            .messaging_channels
            .insert(eager_mcp_session.to_string(), sender);

        let mut headers = HeaderMap::new();
        headers.insert(MCP_SESSION_HEADER, eager_mcp_session.parse().unwrap());
        headers.insert(TUIC_SESSION_HEADER, TEST_UUID_A.parse().unwrap());
        let response = mcp_post(
            State(Arc::clone(&state)),
            ConnectInfo("127.0.0.1:1".parse().unwrap()),
            headers,
            Json(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": { "name": "tuic-bridge", "version": "test" }
                }
            })),
        )
        .await
        .into_response();

        assert_eq!(
            response
                .headers()
                .get(MCP_SESSION_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some(eager_mcp_session),
            "the downstream initialize must reuse the bridge's eager session"
        );
        assert_eq!(
            state
                .mcp_to_session
                .get(eager_mcp_session)
                .map(|entry| entry.value().clone()),
            Some(TEST_UUID_A.to_string()),
            "the live SSE owner must retain its peer binding"
        );

        // The `/usr/bin/true` spawns still in this module were audited: each one
        // reads only the spawn response, or asserts that a *refused* spawn left
        // nothing behind. Anything that reads state owned by a living child uses
        // `LONG_LIVED_TEST_BINARY` instead — see its comment for why.
        let spawned = handle_agent(
            &state,
            "127.0.0.1:1".parse().unwrap(),
            &serde_json::json!({
                "action": "spawn",
                "prompt": "verify inherited parent binding",
                "binary_path": "/usr/bin/true",
                "cwd": "/tmp",
            }),
            Some(eager_mcp_session),
        );
        if spawned
            .get("error")
            .and_then(|error| error.as_str())
            .is_some_and(|error| error.contains("Failed to open PTY"))
        {
            eprintln!("Skipping spawn readiness assertion: PTY unavailable");
            return;
        }
        assert!(spawned.get("error").is_none(), "spawn failed: {spawned}");
        assert_eq!(spawned["communication_ready"], true);
        assert_eq!(spawned["parent_session_id"], TEST_UUID_A);
    }

    /// Compatibility bar for the task handle: a classic MCP client parses the
    /// spawn response by field name, so `task_id`/`poll_interval_ms` may only be
    /// *added* — no pre-existing field may disappear or change type.
    // Needs a runtime: the spawn path arms the initial-prompt watchdog and the
    // reader thread through tokio.
    #[tokio::test]
    async fn spawn_response_adds_the_task_handle_without_touching_existing_fields() {
        let state = test_state();
        let spawned = handle_agent(
            &state,
            "127.0.0.1:1".parse().unwrap(),
            &serde_json::json!({
                "action": "spawn",
                "prompt": "task handle additivity",
                "binary_path": LONG_LIVED_TEST_BINARY,
                "cwd": "/tmp",
            }),
            Some("mcp-classic"),
        );
        if spawned["error"]
            .as_str()
            .is_some_and(|e| e.contains("Failed to open PTY"))
        {
            eprintln!("Skipping: PTY unavailable");
            return;
        }
        assert!(spawned.get("error").is_none(), "spawn failed: {spawned}");

        // Every field a pre-task client already read, with its original type.
        for key in [
            "session_id",
            "name",
            "send_to",
            "monitor_with",
            "status_with",
            "wait_with",
        ] {
            assert!(
                spawned[key].is_string(),
                "{key} must still be a string: {spawned}"
            );
        }
        for key in ["peer_registered", "communication_ready"] {
            assert!(
                spawned[key].is_boolean(),
                "{key} must still be a boolean: {spawned}"
            );
        }
        assert!(spawned["server_ts"].is_u64(), "server_ts must stay numeric");

        // The additions.
        let task_id = spawned["task_id"]
            .as_str()
            .expect("task_id must be a string");
        assert_eq!(spawned["poll_interval_ms"], TASK_POLL_INTERVAL_MS);
        const {
            assert!(
                TASK_POLL_INTERVAL_MS >= 1000,
                "a lower floor lets a stuck orchestrator hot-loop the server"
            )
        };

        // The handle must actually resolve, be owned by this caller, and track the
        // session that was spawned.
        let rec = state.tasks.get(task_id).expect("task must exist");
        assert_eq!(rec.status, crate::tasks::TaskStatus::Working);
        assert_eq!(rec.kind, crate::tasks::TaskKind::AgentSpawn);
        assert_eq!(rec.owner, pending_parent_id("mcp-classic"));
        assert_eq!(
            rec.session_id.as_deref(),
            spawned["session_id"].as_str(),
            "the task must point at the spawned session"
        );
        drop(rec);

        handle_session(
            &state,
            &serde_json::json!({
                "action": "kill", "session_id": spawned["session_id"].as_str().unwrap()
            }),
            None,
        );
    }

    /// The loopback guard runs before anything is allocated — a rejected caller
    /// must not leave a task behind for someone else to poll.
    #[test]
    fn a_rejected_remote_spawn_creates_no_task() {
        let state = test_state();
        let rejected = handle_agent(
            &state,
            "8.8.8.8:1234".parse().unwrap(),
            &serde_json::json!({
                "action": "spawn",
                "prompt": "remote caller",
                "binary_path": "/usr/bin/true",
            }),
            Some("mcp-remote"),
        );

        assert!(
            rejected["error"]
                .as_str()
                .is_some_and(|e| e.contains("restricted to localhost")),
            "a remote spawn must be refused: {rejected}"
        );
        assert!(rejected.get("task_id").is_none());
        assert_eq!(state.tasks.len(), 0, "no task may outlive a refused spawn");
    }

    /// A spawn that never reaches the PTY (bad binary) must also leave no task.
    #[test]
    fn a_failed_spawn_creates_no_task() {
        let state = test_state();
        let failed = handle_agent(
            &state,
            "127.0.0.1:1".parse().unwrap(),
            &serde_json::json!({
                "action": "spawn",
                "prompt": "bad binary",
                "binary_path": "/nonexistent/definitely-not-a-binary",
            }),
            Some("mcp-classic"),
        );

        assert!(failed["error"].is_string(), "spawn must fail: {failed}");
        assert_eq!(state.tasks.len(), 0, "no task may outlive a failed spawn");
    }

    /// The point of the handle: the outcome is recorded when the agent exits, even
    /// though nobody was waiting. A clean exit completes; a non-zero exit fails.
    #[test]
    fn a_session_exit_drives_its_task_to_a_terminal_state() {
        use crate::tasks::{TaskKind, TaskStatus};

        let state = test_state();

        let clean = state
            .tasks
            .create(TaskKind::AgentSpawn, "owner", Some("sess-clean"));
        state.exit_codes.insert("sess-clean".to_string(), 0);
        crate::pty::mark_session_exited("sess-clean", &state);
        let rec = state.tasks.get(&clean).expect("task must survive");
        assert_eq!(rec.status, TaskStatus::Completed);
        assert_eq!(rec.result.as_ref().unwrap()["exit_code"], 0);

        let broken = state
            .tasks
            .create(TaskKind::AgentSpawn, "owner", Some("sess-broken"));
        state.exit_codes.insert("sess-broken".to_string(), 137);
        crate::pty::mark_session_exited("sess-broken", &state);
        let rec = state.tasks.get(&broken).expect("task must survive");
        assert_eq!(rec.status, TaskStatus::Failed);
        assert!(
            rec.error.as_deref().is_some_and(|e| e.contains("137")),
            "the exit code must reach the caller: {:?}",
            rec.error
        );
    }

    // --- task tool ---

    fn task_call(
        state: &Arc<AppState>,
        addr: &str,
        args: serde_json::Value,
        mcp_sid: Option<&str>,
    ) -> serde_json::Value {
        handle_task(state, addr.parse().unwrap(), &args, mcp_sid)
    }

    /// The whole point of the handle: poll the outcome without holding a wait
    /// open. `get` must answer immediately at every stage of the task's life.
    #[test]
    fn task_get_reports_each_stage_without_blocking() {
        use crate::tasks::{TaskKind, TaskStatus, TaskUpdate};

        let state = test_state();
        let id = state
            .tasks
            .create(TaskKind::AgentSpawn, "peer-a", Some("sess-1"));
        state
            .mcp_to_session
            .insert("mcp-a".to_string(), "peer-a".to_string());

        let working = task_call(
            &state,
            "127.0.0.1:1",
            serde_json::json!({"action": "get", "task_id": id}),
            Some("mcp-a"),
        );
        assert_eq!(working["status"], "working");
        assert_eq!(working["poll_interval_ms"], TASK_POLL_INTERVAL_MS);
        assert!(
            working.get("result").is_none() && working.get("status_message").is_none(),
            "absent optional fields are omitted, not null: {working}"
        );

        state
            .tasks
            .set_status(
                &id,
                TaskStatus::Completed,
                TaskUpdate {
                    result: Some(serde_json::json!({"exit_code": 0})),
                    status_message: Some("done".to_string()),
                    ..Default::default()
                },
            )
            .expect("transition");

        let done = task_call(
            &state,
            "127.0.0.1:1",
            serde_json::json!({"action": "get", "task_id": id}),
            Some("mcp-a"),
        );
        assert_eq!(done["status"], "completed");
        assert_eq!(done["result"]["exit_code"], 0);
        assert_eq!(done["status_message"], "done");
    }

    /// A failed task must not report its reason under `error`: every handler in
    /// this transport uses a top-level `error` to mean "the call failed", so a
    /// client would read a successful poll as a broken call.
    #[test]
    fn task_get_reports_a_failure_under_error_detail_not_error() {
        use crate::tasks::{TaskKind, TaskStatus, TaskUpdate};

        let state = test_state();
        let id = state.tasks.create(TaskKind::AgentSpawn, "peer-a", None);
        state
            .mcp_to_session
            .insert("mcp-a".to_string(), "peer-a".to_string());
        state
            .tasks
            .set_status(
                &id,
                TaskStatus::Failed,
                TaskUpdate {
                    error: Some("agent session exited with code 137".to_string()),
                    ..Default::default()
                },
            )
            .expect("transition");

        let failed = task_call(
            &state,
            "127.0.0.1:1",
            serde_json::json!({"action": "get", "task_id": id}),
            Some("mcp-a"),
        );
        assert_eq!(failed["status"], "failed");
        assert!(
            failed.get("error").is_none(),
            "a successful poll must not carry a top-level error: {failed}"
        );
        assert_eq!(failed["error_detail"], "agent session exited with code 137");
    }

    /// A task handle is a capability over a spawned agent — one agent must not be
    /// able to inspect or cancel another's children.
    #[test]
    fn a_task_owned_by_another_identity_is_refused() {
        use crate::tasks::TaskKind;

        let state = test_state();
        let id = state.tasks.create(TaskKind::AgentSpawn, "peer-a", None);
        state
            .mcp_to_session
            .insert("mcp-b".to_string(), "peer-b".to_string());

        for action in ["get", "cancel"] {
            let refused = task_call(
                &state,
                "127.0.0.1:1",
                serde_json::json!({"action": action, "task_id": id}),
                Some("mcp-b"),
            );
            assert!(
                refused["error"]
                    .as_str()
                    .is_some_and(|e| e.contains("not owned")),
                "{action} must be refused: {refused}"
            );
        }
        assert_eq!(
            state.tasks.get(&id).unwrap().status,
            crate::tasks::TaskStatus::Working,
            "a refused cancel must not have mutated the task"
        );
    }

    /// An orchestrator that spawns before it registers is stamped with its pending
    /// id; auto-binding afterwards changes its specific identity, and it must not
    /// lose the handle it was already handed.
    #[test]
    fn a_handle_survives_the_caller_binding_a_tuic_identity_later() {
        use crate::tasks::TaskKind;

        let state = test_state();
        // Spawned while unbound: owner is the pending alias.
        let id = state.tasks.create(
            TaskKind::AgentSpawn,
            &task_owner_identity(None, Some("mcp-late")),
            None,
        );
        assert_eq!(
            state.tasks.get(&id).unwrap().owner,
            pending_parent_id("mcp-late")
        );

        // Now it binds a real TUIC identity on the same MCP session.
        state
            .mcp_to_session
            .insert("mcp-late".to_string(), TEST_UUID_A.to_string());

        let got = task_call(
            &state,
            "127.0.0.1:1",
            serde_json::json!({"action": "get", "task_id": id}),
            Some("mcp-late"),
        );
        assert_eq!(
            got["status"], "working",
            "own handle must stay reachable: {got}"
        );
    }

    #[test]
    fn task_cancel_is_final_and_leaves_the_agent_running() {
        use crate::tasks::{TaskKind, TaskStatus};

        let state = test_state();
        let id = state
            .tasks
            .create(TaskKind::AgentSpawn, "peer-a", Some("sess-1"));
        state
            .mcp_to_session
            .insert("mcp-a".to_string(), "peer-a".to_string());

        let cancelled = task_call(
            &state,
            "127.0.0.1:1",
            serde_json::json!({"action": "cancel", "task_id": id}),
            Some("mcp-a"),
        );
        assert_eq!(cancelled["cancelled"], true);
        assert_eq!(cancelled["status"], "cancelled");
        assert!(
            cancelled["note"]
                .as_str()
                .is_some_and(|n| n.contains("session(action=kill)")),
            "the caller must be told the process is still alive: {cancelled}"
        );

        // A second cancel is not an error — it reports the state that stands, so a
        // cancel racing the agent's exit never looks like a failure.
        let again = task_call(
            &state,
            "127.0.0.1:1",
            serde_json::json!({"action": "cancel", "task_id": id}),
            Some("mcp-a"),
        );
        assert_eq!(again["cancelled"], false);
        assert_eq!(again["status"], "cancelled");
        assert!(again.get("error").is_none());
        assert_eq!(state.tasks.get(&id).unwrap().status, TaskStatus::Cancelled);
    }

    /// `agent spawn` is loopback-only, so cancelling one must be too — otherwise a
    /// remote client could halt another agent's orchestration.
    #[test]
    fn a_remote_caller_cannot_cancel_but_may_still_poll() {
        use crate::tasks::{TaskKind, TaskStatus};

        let state = test_state();
        let id = state.tasks.create(TaskKind::AgentSpawn, "peer-a", None);
        state
            .mcp_to_session
            .insert("mcp-a".to_string(), "peer-a".to_string());

        let refused = task_call(
            &state,
            "8.8.8.8:1234",
            serde_json::json!({"action": "cancel", "task_id": id}),
            Some("mcp-a"),
        );
        assert!(
            refused["error"]
                .as_str()
                .is_some_and(|e| e.contains("restricted to localhost")),
            "{refused}"
        );
        assert_eq!(state.tasks.get(&id).unwrap().status, TaskStatus::Working);

        // Reading is monitoring, not control — it stays open, like session status.
        let polled = task_call(
            &state,
            "8.8.8.8:1234",
            serde_json::json!({"action": "get", "task_id": id}),
            Some("mcp-a"),
        );
        assert_eq!(polled["status"], "working");
    }

    #[test]
    fn task_rejects_an_unknown_id_and_a_bad_action() {
        let state = test_state();

        let unknown = task_call(
            &state,
            "127.0.0.1:1",
            serde_json::json!({"action": "get", "task_id": "no-such-task"}),
            Some("mcp-a"),
        );
        assert!(
            unknown["error"]
                .as_str()
                .is_some_and(|e| e.contains("unknown or expired")),
            "{unknown}"
        );

        let no_id = task_call(
            &state,
            "127.0.0.1:1",
            serde_json::json!({"action": "get"}),
            Some("mcp-a"),
        );
        assert!(
            no_id["error"]
                .as_str()
                .is_some_and(|e| e.contains("task_id"))
        );

        let bad = task_call(
            &state,
            "127.0.0.1:1",
            serde_json::json!({"action": "explode", "task_id": "x"}),
            Some("mcp-a"),
        );
        assert!(
            bad["error"]
                .as_str()
                .is_some_and(|e| e.contains("get, cancel")),
            "the error must list the available actions: {bad}"
        );
    }

    /// Per docs/sync-matrix.md a tool-surface change must land in the listing AND
    /// the search corpus — a tool missing from the latter is invisible under
    /// `collapse_tools` and to lazy discovery.
    #[test]
    fn the_task_tool_is_listed_and_searchable() {
        let state = test_state();

        let listed = merged_tool_definitions(&state, None);
        assert!(
            listed
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == "task"),
            "task must appear in tools/list"
        );
        assert!(
            searchable_tool_definitions(&state)
                .iter()
                .any(|t| t["name"] == "task"),
            "task must appear in the search corpus"
        );
    }

    /// A cancel that races the agent's exit must stick — terminal immutability
    /// means the exit path cannot rewrite it as completed.
    #[test]
    fn a_cancelled_task_is_not_resurrected_by_the_session_exit() {
        use crate::tasks::{TaskKind, TaskStatus};

        let state = test_state();
        let id = state
            .tasks
            .create(TaskKind::AgentSpawn, "owner", Some("sess-cancel"));
        state.tasks.cancel(&id).expect("cancel");

        state.exit_codes.insert("sess-cancel".to_string(), 0);
        crate::pty::mark_session_exited("sess-cancel", &state);

        assert_eq!(
            state.tasks.get(&id).unwrap().status,
            TaskStatus::Cancelled,
            "the exit must not overwrite an orchestrator's cancel"
        );
    }

    #[test]
    fn initialize_identity_preserves_registered_name_across_reconnect() {
        let state = test_state();
        // Agent explicitly registers with a friendly name.
        handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": TEST_UUID_B, "name": "worker-1"
            }),
            Some("mcp-reg"),
        );
        // Bridge reconnects → auto-bind with a fresh mcp session id.
        apply_initialize_identity(&state, "mcp-reconnect", Some(TEST_UUID_B));
        assert_eq!(
            state.peer_agents.get(TEST_UUID_B).unwrap().name,
            "worker-1",
            "auto-bind must not clobber a registered display name"
        );
    }

    #[test]
    fn refresh_mcp_session_repairs_lost_peer_binding() {
        let state = test_state();
        state.mcp_sessions.insert(
            "mcp-stale".to_string(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code: false,
                requires_meta_tools: false,
                has_sse_stream: false,
                sse_generation: 0,
                repo_path: None,
            },
        );

        refresh_mcp_session(&state, "mcp-stale", false, Some(TEST_UUID_A));

        assert_eq!(
            state
                .mcp_to_session
                .get("mcp-stale")
                .map(|entry| entry.value().clone()),
            Some(TEST_UUID_A.to_string())
        );
        assert!(state.peer_agents.contains_key(TEST_UUID_A));
    }

    #[test]
    fn register_still_binds_after_refactor() {
        // Guards explicit register on the shared locked live-owner policy.
        let state = test_state();
        let r = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": TEST_UUID_A, "name": "w"
            }),
            Some("mcp-reg-1"),
        );
        assert_eq!(r["ok"], true);
        assert_eq!(
            state
                .mcp_to_session
                .get("mcp-reg-1")
                .map(|v| v.value().clone()),
            Some(TEST_UUID_A.to_string())
        );
        assert_eq!(state.peer_agents.get(TEST_UUID_A).unwrap().name, "w");
    }

    #[test]
    fn headerless_register_generates_stable_mcp_scoped_identity_without_pty() {
        let state = test_state();
        let first = handle_messaging(
            &state,
            &serde_json::json!({"action": "register", "name": "external"}),
            Some("mcp-external"),
        );
        assert_eq!(first["ok"], true);
        assert_eq!(first["identity_generated"], true);
        let generated = first["tuic_session"].as_str().unwrap();
        assert!(is_valid_uuid(generated));
        assert!(
            state.sessions.is_empty(),
            "registration must not create a PTY"
        );
        assert_eq!(
            state
                .mcp_to_session
                .get("mcp-external")
                .map(|entry| entry.value().clone()),
            Some(generated.to_string())
        );

        let second = handle_messaging(
            &state,
            &serde_json::json!({"action": "register", "project": "/repo"}),
            Some("mcp-external"),
        );
        assert_eq!(second["tuic_session"], generated);
        assert_eq!(second["identity_generated"], false);
        assert_eq!(
            second["name"], "external",
            "omission must preserve the name"
        );
        assert_eq!(
            state.peer_agents.get(generated).unwrap().project.as_deref(),
            Some("/repo")
        );
    }

    #[tokio::test]
    async fn deleting_headerless_mcp_scope_removes_generated_identity_routes() {
        let state = test_state();
        let registered = handle_messaging(
            &state,
            &serde_json::json!({"action": "register"}),
            Some("mcp-external-delete"),
        );
        let generated = registered["tuic_session"].as_str().unwrap().to_string();
        let mut headers = HeaderMap::new();
        headers.insert(MCP_SESSION_HEADER, "mcp-external-delete".parse().unwrap());

        let _ = mcp_delete(State(Arc::clone(&state)), headers).await;

        assert!(!state.peer_agents.contains_key(&generated));
        assert!(!state.agent_inbox.contains_key(&generated));
        assert!(!state.mcp_to_session.contains_key("mcp-external-delete"));
        assert!(!state.session_to_mcp.contains_key(&generated));
    }

    /// The read cursor is per-identity state like the inbox it indexes, so it has
    /// to travel with the mail. Left behind, the replacing identity starts at 0
    /// and its first `inbox` hands back every migrated message as if it were new.
    #[test]
    fn replaces_carries_the_read_cursor_so_migrated_mail_is_not_replayed() {
        let state = test_state();
        handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": TEST_UUID_B, "name": "root"
            }),
            Some("mcp-old-connection"),
        );
        state.push_agent_inbox(
            TEST_UUID_B,
            crate::state::AgentMessage {
                id: "msg-already-read".to_string(),
                from_tuic_session: "worker".to_string(),
                from_name: "worker".to_string(),
                content: "results".to_string(),
                timestamp: 1,
                delivered_via_channel: false,
            },
        );
        let first_read = handle_messaging(
            &state,
            &serde_json::json!({"action": "inbox"}),
            Some("mcp-old-connection"),
        );
        assert_eq!(first_read["count"], 1, "the old identity read its mail");

        handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register",
                "tuic_session": TEST_UUID_A,
                "name": "root",
                "replaces": TEST_UUID_B,
            }),
            Some("mcp-new-connection"),
        );

        let after_handoff = handle_messaging(
            &state,
            &serde_json::json!({"action": "inbox"}),
            Some("mcp-new-connection"),
        );
        assert_eq!(
            after_handoff["count"], 0,
            "mail the superseded identity had already read must not come back as new"
        );
        assert!(
            !state.agent_read_cursor.contains_key(TEST_UUID_B),
            "a retired identity must not leave its cursor behind"
        );
    }

    #[tokio::test]
    async fn ending_an_mcp_session_drops_the_read_cursor_with_the_inbox() {
        let state = test_state();
        let registered = handle_messaging(
            &state,
            &serde_json::json!({"action": "register"}),
            Some("mcp-cursor-teardown"),
        );
        let generated = registered["tuic_session"].as_str().unwrap().to_string();
        state.push_agent_inbox(
            &generated,
            crate::state::AgentMessage {
                id: "msg-read".to_string(),
                from_tuic_session: "worker".to_string(),
                from_name: "worker".to_string(),
                content: "results".to_string(),
                timestamp: 1,
                delivered_via_channel: false,
            },
        );
        handle_messaging(
            &state,
            &serde_json::json!({"action": "inbox"}),
            Some("mcp-cursor-teardown"),
        );
        assert!(state.agent_read_cursor.contains_key(&generated));

        let mut headers = HeaderMap::new();
        headers.insert(MCP_SESSION_HEADER, "mcp-cursor-teardown".parse().unwrap());
        let _ = mcp_delete(State(Arc::clone(&state)), headers).await;

        assert!(
            !state.agent_read_cursor.contains_key(&generated),
            "the cursor indexes an inbox that teardown just deleted — it cannot outlive it"
        );
    }

    fn join_two_bridges_to_one_pty(state: &Arc<AppState>) {
        apply_initialize_identity(state, "mcp-primary", Some(TEST_UUID_A));
        live_mcp_session(state, "mcp-primary");
        apply_initialize_identity(state, "mcp-sibling", Some(TEST_UUID_A));
        live_mcp_session(state, "mcp-sibling");
        state.orchestrator_peers.insert(TEST_UUID_A.to_string());
        state.push_agent_inbox(
            TEST_UUID_A,
            crate::state::AgentMessage {
                id: "msg-shared".to_string(),
                from_tuic_session: "worker".to_string(),
                from_name: "worker".to_string(),
                content: "preflight done".to_string(),
                timestamp: 1,
                delivered_via_channel: false,
            },
        );
    }

    async fn end_mcp_session(state: &Arc<AppState>, sid: &str) {
        let mut headers = HeaderMap::new();
        headers.insert(MCP_SESSION_HEADER, sid.parse().unwrap());
        let _ = mcp_delete(State(Arc::clone(state)), headers).await;
    }

    /// The reported symptom: the agent talks through the second bridge, so a
    /// locked-out sibling answers "You are not registered" to every inbox read
    /// while its mail piles up under the identity it cannot reach.
    #[test]
    fn joined_sibling_bridge_reads_the_shared_inbox() {
        let state = test_state();
        join_two_bridges_to_one_pty(&state);

        let inbox = handle_messaging(
            &state,
            &serde_json::json!({"action": "inbox", "since": 0}),
            Some("mcp-sibling"),
        );

        assert!(
            inbox.get("error").is_none(),
            "a joined sibling must not be told it is unregistered: {inbox}"
        );
        assert_eq!(
            inbox["messages"][0]["id"], "msg-shared",
            "both bridges in one PTY read the same mailbox: {inbox}"
        );
    }

    /// The inbox and the orchestrator role belong to the PTY, not to one protocol
    /// session. When one of two bridges in that PTY goes away, tearing the identity
    /// down would strand the sibling that is still reading it.
    #[tokio::test]
    async fn ending_one_co_owner_keeps_the_identity_for_the_sibling() {
        let state = test_state();
        join_two_bridges_to_one_pty(&state);

        end_mcp_session(&state, "mcp-primary").await;

        assert_eq!(
            state
                .peer_agents
                .get(TEST_UUID_A)
                .map(|peer| peer.mcp_session_id.clone()),
            Some("mcp-sibling".to_string()),
            "the surviving co-owner must be promoted to delivery owner"
        );
        assert!(
            state
                .agent_inbox
                .get(TEST_UUID_A)
                .is_some_and(|inbox| inbox.iter().any(|m| m.id == "msg-shared")),
            "buffered mail must survive: the sibling has not read it yet"
        );
        assert!(
            state.orchestrator_peers.contains(TEST_UUID_A),
            "the orchestrator role belongs to the PTY, not to the departed bridge"
        );
        assert_eq!(
            state
                .session_to_mcp
                .get(TEST_UUID_A)
                .map(|entry| entry.clone()),
            Some(vec!["mcp-sibling".to_string()]),
            "the departed session must drop its own route"
        );
        assert!(!state.mcp_to_session.contains_key("mcp-primary"));
    }

    /// A bridge joining while the last co-owner tears the identity down must not
    /// end up holding a route to a peer that no longer exists — that is the shape
    /// of every silent-delivery-loss bug in this module.
    #[tokio::test]
    async fn joining_a_bridge_while_the_owner_tears_down_leaves_no_dangling_route() {
        for round in 0..200 {
            let state = test_state();
            apply_initialize_identity(&state, "mcp-primary", Some(TEST_UUID_A));
            live_mcp_session(&state, "mcp-primary");

            let joiner_state = Arc::clone(&state);
            let joiner = tokio::task::spawn_blocking(move || {
                apply_initialize_identity(&joiner_state, "mcp-joiner", Some(TEST_UUID_A));
            });
            end_mcp_session(&state, "mcp-primary").await;
            joiner.await.expect("joining task panicked");

            if state.mcp_to_session.contains_key("mcp-joiner") {
                assert!(
                    state.peer_agents.contains_key(TEST_UUID_A),
                    "round {round}: the joiner kept a route to an identity that was torn down"
                );
                assert!(
                    state
                        .session_to_mcp
                        .get(TEST_UUID_A)
                        .is_some_and(|reverse| reverse.iter().any(|s| s == "mcp-joiner")),
                    "round {round}: forward route with no reverse entry to clean it up"
                );
            } else {
                assert!(
                    !state.peer_agents.contains_key(TEST_UUID_A),
                    "round {round}: identity survived with nobody routed to it"
                );
            }
        }
    }

    /// A co-owner that never became delivery owner still has to clean up after
    /// itself, and the last one out tears the identity down as before.
    #[tokio::test]
    async fn ending_the_last_co_owner_removes_the_identity() {
        let state = test_state();
        join_two_bridges_to_one_pty(&state);

        end_mcp_session(&state, "mcp-sibling").await;
        assert!(
            state.peer_agents.contains_key(TEST_UUID_A),
            "a non-owner leaving must not retire the identity"
        );
        assert!(!state.mcp_to_session.contains_key("mcp-sibling"));
        assert_eq!(
            state
                .session_to_mcp
                .get(TEST_UUID_A)
                .map(|entry| entry.clone()),
            Some(vec!["mcp-primary".to_string()])
        );

        end_mcp_session(&state, "mcp-primary").await;
        assert!(!state.peer_agents.contains_key(TEST_UUID_A));
        assert!(!state.agent_inbox.contains_key(TEST_UUID_A));
        assert!(!state.orchestrator_peers.contains(TEST_UUID_A));
        assert!(!state.session_to_mcp.contains_key(TEST_UUID_A));
        assert!(!state.mcp_to_session.contains_key("mcp-primary"));
    }

    #[test]
    fn register_renames_auto_bound_caller_without_hijack_rejection() {
        // After the initialize auto-bind, the SAME mcp session may still call
        // register to set a friendly name/project. The live-hijack guard must
        // not treat this as a hijack (prior binding is its own session).
        let state = test_state();
        apply_initialize_identity(&state, "mcp-self", Some(TEST_UUID_A));
        // Simulate the mcp session being live (guard checks mcp_sessions).
        state.mcp_sessions.insert(
            "mcp-self".to_string(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code: false,
                requires_meta_tools: false,
                has_sse_stream: false,
                sse_generation: 0,
                repo_path: None,
            },
        );
        let r = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": TEST_UUID_A, "name": "renamed"
            }),
            Some("mcp-self"),
        );
        assert_eq!(r["ok"], true, "self-rename after auto-bind must succeed");
        assert_eq!(state.peer_agents.get(TEST_UUID_A).unwrap().name, "renamed");
    }

    /// An agent that registered a made-up UUID must be able to repair itself by
    /// announcing the `$TUIC_SESSION` TUIC actually injected. The bound identity
    /// resolves to no terminal; the announced one does. Refusing the real identity
    /// to protect the phantom is how an orchestrator loses every reply it is owed.
    #[cfg(unix)]
    #[test]
    fn register_accepts_the_real_identity_over_a_bound_phantom() {
        let state = test_state();
        let mcp = "mcp-self-repair";
        insert_managed_test_session(&state, "pty-repair", "/tmp");
        state.bind_live_pty(TEST_UUID_A, "pty-repair");

        // First registration files the caller under a fabricated identity.
        let phantom = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": TEST_UUID_B, "name": "orchestrator"
            }),
            Some(mcp),
        );
        assert_eq!(phantom["ok"], true);
        assert_eq!(phantom["terminal"], false, "the phantom has no terminal");

        // Self-repair: same MCP session announces the identity that owns the PTY.
        let repaired = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": TEST_UUID_A, "name": "orchestrator"
            }),
            Some(mcp),
        );
        assert_eq!(
            repaired["ok"], true,
            "an identity backed by a live PTY must win over a bound one that is not: {repaired}"
        );
        assert_eq!(
            repaired["terminal"], true,
            "after the repair the peer must report a terminal: {repaired}"
        );
        assert_eq!(
            state
                .mcp_to_session
                .get(mcp)
                .map(|e| e.value().clone())
                .unwrap_or_default(),
            TEST_UUID_A,
            "routing must follow the repaired identity"
        );
    }

    /// The mirror case: a caller already bound to an identity that owns a PTY may
    /// not wander off to an invented one, and the refusal must name the identity
    /// it should be using instead of just stating that something is bound.
    #[cfg(unix)]
    #[test]
    fn register_rejects_a_fabricated_identity_and_names_the_real_one() {
        let state = test_state();
        let mcp = "mcp-fabricator";
        insert_managed_test_session(&state, "pty-real", "/tmp");
        state.bind_live_pty(TEST_UUID_A, "pty-real");
        apply_initialize_identity(&state, mcp, Some(TEST_UUID_A));

        let rejected = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": TEST_UUID_B, "name": "orchestrator"
            }),
            Some(mcp),
        );
        let error = rejected["error"].as_str().unwrap_or_default();
        assert!(
            !error.is_empty(),
            "a fabricated identity must not be accepted while a real one is bound: {rejected}"
        );
        assert!(
            error.contains(TEST_UUID_A),
            "the refusal must name the identity to use, got: {error}"
        );
        assert_eq!(
            state
                .mcp_to_session
                .get(mcp)
                .map(|e| e.value().clone())
                .unwrap_or_default(),
            TEST_UUID_A,
            "the real binding must survive the rejected call"
        );
    }

    /// Repairing an identity must not strand the mail already sent to the phantom —
    /// those are exactly the replies the caller was missing — and must not leave the
    /// dead address in `list_peers` for workers to keep writing to.
    #[cfg(unix)]
    #[test]
    fn repairing_an_identity_carries_its_mail_over_and_retires_the_phantom() {
        let state = test_state();
        let mcp = "mcp-carryover";
        insert_managed_test_session(&state, "pty-carryover", "/tmp");
        state.bind_live_pty(TEST_UUID_A, "pty-carryover");
        handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": TEST_UUID_B, "name": "orchestrator"
            }),
            Some(mcp),
        );
        state.push_agent_inbox(
            TEST_UUID_B,
            crate::state::AgentMessage {
                id: "msg-stranded".to_string(),
                from_tuic_session: "worker".to_string(),
                from_name: "worker".to_string(),
                content: "findings ready".to_string(),
                timestamp: 1,
                delivered_via_channel: false,
            },
        );

        handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": TEST_UUID_A, "name": "orchestrator"
            }),
            Some(mcp),
        );

        assert!(
            state.peer_agents.get(TEST_UUID_B).is_none(),
            "the abandoned terminal-less identity must not stay addressable"
        );
        let carried = state
            .agent_inbox
            .get(TEST_UUID_A)
            .map(|inbox| inbox.iter().any(|m| m.content == "findings ready"))
            .unwrap_or(false);
        assert!(
            carried,
            "mail buffered under the phantom must survive the repair"
        );
    }

    /// A caller that reconnects and registers a NEW uuid arrives with no implicit
    /// link to its old identity, so its inbox used to be stranded with nobody told.
    /// `replaces` is how it says which identity it supersedes — guessing by name
    /// is not an option, since peer identity decides who may read whose mail.
    #[test]
    fn replaces_carries_mail_over_from_a_new_protocol_session() {
        let state = test_state();
        insert_managed_test_session(&state, "pty-replaces", "/tmp");
        state.bind_live_pty(TEST_UUID_A, "pty-replaces");
        // The old identity registers on its own (now gone) connection.
        handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": TEST_UUID_B, "name": "root"
            }),
            Some("mcp-old-connection"),
        );
        state.push_agent_inbox(
            TEST_UUID_B,
            crate::state::AgentMessage {
                id: "msg-orphan".to_string(),
                from_tuic_session: "worker".to_string(),
                from_name: "worker".to_string(),
                content: "results".to_string(),
                timestamp: 1,
                delivered_via_channel: false,
            },
        );

        // A different protocol session claims the new identity: previously_bound is
        // None here, so only `replaces` can tie the two together.
        let response = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register",
                "tuic_session": TEST_UUID_A,
                "name": "root",
                "replaces": TEST_UUID_B,
            }),
            Some("mcp-new-connection"),
        );

        assert_eq!(response["superseded_identity"], TEST_UUID_B);
        assert_eq!(response["mail_migrated"], 1);
        assert!(state.peer_agents.get(TEST_UUID_B).is_none());
        let carried = state
            .agent_inbox
            .get(TEST_UUID_A)
            .map(|inbox| inbox.iter().any(|m| m.content == "results"))
            .unwrap_or(false);
        assert!(carried, "orphaned mail must reach the replacing identity");
    }

    /// The other half of the contract: an identity that still owns a live PTY is a
    /// reachable peer, not an abandoned one. Taking its mail would strand a working
    /// agent — so nothing moves, and the caller is told in so many words instead of
    /// the silent early return this used to be.
    #[cfg(unix)]
    #[test]
    fn replaces_refuses_to_take_mail_from_a_live_identity_and_says_so() {
        let state = test_state();
        insert_managed_test_session(&state, "pty-new", "/tmp");
        state.bind_live_pty(TEST_UUID_A, "pty-new");
        insert_managed_test_session(&state, "pty-still-alive", "/tmp");
        state.bind_live_pty(TEST_UUID_B, "pty-still-alive");
        handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": TEST_UUID_B, "name": "root"
            }),
            Some("mcp-live-owner"),
        );
        state.push_agent_inbox(
            TEST_UUID_B,
            crate::state::AgentMessage {
                id: "msg-theirs".to_string(),
                from_tuic_session: "worker".to_string(),
                from_name: "worker".to_string(),
                content: "not yours".to_string(),
                timestamp: 1,
                delivered_via_channel: false,
            },
        );

        let response = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register",
                "tuic_session": TEST_UUID_A,
                "name": "root",
                "replaces": TEST_UUID_B,
            }),
            Some("mcp-claimant"),
        );

        assert_eq!(response["mail_migrated"], 0);
        assert_eq!(response["mail_stranded"], 1);
        assert!(
            response["identity_warning"]
                .as_str()
                .unwrap_or_default()
                .contains("live PTY"),
            "the skip must be reported, not silent: {:?}",
            response["identity_warning"]
        );
        let kept = state
            .agent_inbox
            .get(TEST_UUID_B)
            .map(|inbox| inbox.iter().any(|m| m.content == "not yours"))
            .unwrap_or(false);
        assert!(kept, "a live peer keeps its own mail");
        assert!(
            state.peer_agents.get(TEST_UUID_B).is_some(),
            "a live peer must stay addressable"
        );
    }

    /// `delivered_via_channel` reported one sub-route but read as a delivery
    /// verdict, so `false` next to a confirming `delivery_path` was pure noise.
    /// `delivery_path` is now the single source of truth for the route.
    #[test]
    fn send_reports_the_route_only_through_delivery_path() {
        let state = test_state();
        handle_messaging(
            &state,
            &serde_json::json!({"action": "register", "tuic_session": TEST_UUID_A, "name": "sender"}),
            Some("mcp-route-sender"),
        );
        handle_messaging(
            &state,
            &serde_json::json!({"action": "register", "tuic_session": TEST_UUID_B, "name": "peer"}),
            Some("mcp-route-peer"),
        );

        let result = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send", "to": TEST_UUID_B, "message": "hello"
            }),
            Some("mcp-route-sender"),
        );

        assert_eq!(result["delivery_path"], "inbox_only");
        assert!(
            result.get("delivered_via_channel").is_none(),
            "the ambiguous field must be gone from the send response: {result:?}"
        );
    }

    /// A `send` landing in the middle of the retire must not vanish. The retire
    /// mutates several maps; without a shared critical section a message could
    /// be buffered under an identity that is deleted a moment later, which is
    /// exactly the silent drop the repair set out to end. Either the message
    /// reaches the repaired inbox, or the send is refused — never neither.
    #[test]
    fn a_send_racing_the_retire_is_never_silently_dropped() {
        const ROUNDS: usize = 300;

        for round in 0..ROUNDS {
            let state = test_state();
            let sender = TEST_UUID_A;
            let phantom = TEST_UUID_B;
            let repaired = "550e8400-e29b-41d4-a716-446655440a03";
            register_peer(&state, sender, "sender", "mcp-sender");
            register_peer(&state, phantom, "phantom", "mcp-phantom");
            register_peer(&state, repaired, "repaired", "mcp-repaired");

            let send_state = Arc::clone(&state);
            let content = format!("payload-{round}");
            let sent = content.clone();
            let sender_thread = std::thread::spawn(move || {
                handle_messaging(
                    &send_state,
                    &serde_json::json!({
                        "action": "send", "to": phantom, "message": sent
                    }),
                    Some("mcp-sender"),
                )
            });

            let retire_state = Arc::clone(&state);
            let retire_thread = std::thread::spawn(move || {
                retire_repaired_phantom_identity(&retire_state, phantom, repaired);
            });

            let send_result = sender_thread.join().expect("send thread panicked");
            retire_thread.join().expect("retire thread panicked");

            let accepted = send_result.get("error").is_none();
            let in_repaired = state
                .agent_inbox
                .get(repaired)
                .map(|inbox| inbox.iter().any(|m| m.content == content))
                .unwrap_or(false);
            let stranded = state
                .agent_inbox
                .get(phantom)
                .map(|inbox| inbox.iter().any(|m| m.content == content))
                .unwrap_or(false);

            assert!(
                !stranded,
                "round {round}: message left in the retired phantom's inbox, addressable by nobody"
            );
            if accepted {
                assert!(
                    in_repaired,
                    "round {round}: send reported success but the message reached no inbox"
                );
            }
        }
    }

    /// After the repair the peer is addressable in the normal sense: `send` must
    /// resolve it to the live PTY rather than parking the message in the inbox.
    #[cfg(unix)]
    #[test]
    fn send_reaches_a_repaired_peer_through_its_terminal() {
        let state = test_state();
        insert_managed_test_session(&state, "pty-addressable", "/tmp");
        state.shell_states.insert(
            "pty-addressable".to_string(),
            std::sync::atomic::AtomicU8::new(crate::pty::SHELL_IDLE),
        );
        state.session_states.insert(
            "pty-addressable".to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                ..Default::default()
            },
        );
        state.bind_live_pty(TEST_UUID_A, "pty-addressable");
        handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": TEST_UUID_B, "name": "orchestrator"
            }),
            Some("mcp-recipient"),
        );
        handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": TEST_UUID_A, "name": "orchestrator"
            }),
            Some("mcp-recipient"),
        );

        let sender_tuic = "550e8400-e29b-41d4-a716-4466554400c1";
        register_peer(&state, sender_tuic, "worker", "mcp-worker");
        let sent = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send", "to": TEST_UUID_A, "message": "findings ready"
            }),
            Some("mcp-worker"),
        );
        assert_eq!(sent["delivered"], true, "delivery must succeed: {sent}");
        assert_eq!(
            sent["delivery_path"], "terminal_or_queued_and_inbox",
            "the message must go to the terminal, not sit in the inbox: {sent}"
        );
        assert_eq!(
            sent["recipient_state"]["shell_state"], "idle",
            "recipient_state is only reported for a real managed PTY: {sent}"
        );
    }

    #[test]
    fn frame_peer_message_single_line_and_pointer() {
        // Normal message → framed one-liner with sender.
        let f = frame_peer_message("lead", "please rebase");
        assert_eq!(f, "[TUIC message from lead] please rebase");
        // Newlines collapse to spaces (no multi-line paste into a TUI).
        let f = frame_peer_message("lead", "line1\nline2");
        assert_eq!(f, "[TUIC message from lead] line1 line2");
        // Oversized body → pointer to the inbox instead of a screen flood.
        let big = "x".repeat(INJECT_MAX_BYTES + 100);
        let f = frame_peer_message("lead", &big);
        assert!(f.contains("agent action=inbox"));
        assert!(f.len() < INJECT_MAX_BYTES);
    }

    // ── blocking wait tests (Step 3) ────────────────────────────────

    #[test]
    fn clamp_wait_timeout_defaults_and_caps() {
        assert_eq!(
            clamp_wait_timeout(None),
            WAIT_DEFAULT_MS,
            "absent → default"
        );
        assert_eq!(
            clamp_wait_timeout(Some(0)),
            WAIT_DEFAULT_MS,
            "zero → default"
        );
        assert_eq!(clamp_wait_timeout(Some(1_000)), 1_000, "in-range preserved");
        assert_eq!(
            clamp_wait_timeout(Some(300_001)),
            WAIT_EFFECTIVE_MAX_MS,
            "over-cap clamped"
        );
        assert_eq!(WAIT_DEFAULT_MS, 60_000);
        assert_eq!(WAIT_MAX_MS, 300_000);
    }

    /// A caller that asks for the advertised maximum must get an answer, not a
    /// client-side abort. Codex ends a tools/call at exactly 300s, so a wait that
    /// runs the full 300000 ms loses that race every time.
    #[test]
    fn the_advertised_maximum_wait_answers_before_a_client_deadline() {
        assert_eq!(
            clamp_wait_timeout(Some(WAIT_MAX_MS)),
            WAIT_EFFECTIVE_MAX_MS,
            "asking for the documented maximum must not run to the client's ceiling"
        );
        const {
            assert!(
                WAIT_EFFECTIVE_MAX_MS < WAIT_MAX_MS,
                "the effective cap has to leave the client room to receive the reply"
            )
        };
        const {
            assert!(
                WAIT_MAX_MS - WAIT_EFFECTIVE_MAX_MS >= 5_000,
                "margin must at least match the bridge's own response margin"
            )
        };
        assert_eq!(
            clamp_wait_timeout(Some(WAIT_EFFECTIVE_MAX_MS - 1)),
            WAIT_EFFECTIVE_MAX_MS - 1,
            "a request below the effective cap is untouched"
        );
    }

    #[test]
    fn session_wait_met_idle_and_exited() {
        use std::sync::atomic::AtomicU8;
        let state = test_state();
        state
            .shell_states
            .insert("s1".to_string(), AtomicU8::new(crate::pty::SHELL_BUSY));
        assert!(!session_wait_met(&state, "s1", "idle"), "busy → not met");
        state
            .shell_states
            .insert("s1".to_string(), AtomicU8::new(crate::pty::SHELL_IDLE));
        assert!(session_wait_met(&state, "s1", "idle"), "idle → met");

        assert!(
            !session_wait_met(&state, "s2", "exited"),
            "unknown session → not exited (avoid false immediate met)"
        );
        state.exit_codes.insert("s3".to_string(), 0);
        assert!(
            session_wait_met(&state, "s3", "exited"),
            "exit code recorded → exited"
        );
    }

    /// `wait` now requires a real session (see below), so these tests register one.
    /// `#[cfg(unix)]` follows `insert_managed_test_session`, which opens a real PTY.
    #[cfg(unix)]
    #[tokio::test]
    async fn session_wait_returns_immediately_when_already_idle() {
        use std::sync::atomic::AtomicU8;
        let state = test_state();
        insert_managed_test_session(&state, "s", "/tmp");
        state
            .shell_states
            .insert("s".to_string(), AtomicU8::new(crate::pty::SHELL_IDLE));
        let r = handle_session_wait(
            &state,
            &serde_json::json!({"action":"wait","session_id":"s","until":"idle"}),
        )
        .await;
        assert_eq!(r["met"], true);
        assert_eq!(r["timed_out"], false);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mcp_delivery_regression_session_wait_times_out_with_flag() {
        use std::sync::atomic::AtomicU8;
        let state = test_state();
        insert_managed_test_session(&state, "s", "/tmp");
        state
            .shell_states
            .insert("s".to_string(), AtomicU8::new(crate::pty::SHELL_BUSY));
        let r = handle_session_wait(
            &state,
            &serde_json::json!({"action":"wait","session_id":"s","until":"idle","timeout_ms":200}),
        )
        .await;
        assert_eq!(r["met"], false);
        assert_eq!(r["timed_out"], true);
    }

    /// `subscribe_pty_events` CREATES the channel for whatever id it is handed,
    /// and teardown only reaps ids that were real sessions — so an unvalidated
    /// `wait` let a caller grow `pty_event_channels` with entries nothing would
    /// ever remove, one 256-slot broadcast channel per made-up id. It also blocked
    /// the caller for the full timeout on a session that cannot exist.
    #[tokio::test]
    async fn session_wait_rejects_an_unknown_session_without_subscribing() {
        let state = test_state();
        let started = std::time::Instant::now();

        let r = handle_session_wait(
            &state,
            &serde_json::json!({"action":"wait","session_id":"never-existed","until":"idle","timeout_ms":5_000}),
        )
        .await;

        assert!(
            r["error"]
                .as_str()
                .unwrap_or_default()
                .contains("Unknown session"),
            "unexpected response: {r}"
        );
        assert!(
            state.pty_event_channels.is_empty(),
            "an unknown id must not leave a broadcast channel behind"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "it must fail fast, not block for the full timeout"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mcp_delivery_regression_session_wait_wakes_from_pty_event_without_polling() {
        use std::sync::atomic::{AtomicU8, Ordering};

        let state = test_state();
        insert_managed_test_session(&state, "event-session", "/tmp");
        state.shell_states.insert(
            "event-session".to_string(),
            AtomicU8::new(crate::pty::SHELL_BUSY),
        );
        let waiting_state = Arc::clone(&state);
        let waiter = tokio::spawn(async move {
            handle_session_wait(
                &waiting_state,
                &serde_json::json!({
                    "action": "wait",
                    "session_id": "event-session",
                    "until": "idle",
                    "timeout_ms": 1_000,
                }),
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        state
            .shell_states
            .get("event-session")
            .unwrap()
            .store(crate::pty::SHELL_IDLE, Ordering::Release);
        state.emit_pty_event(crate::state::AppEvent::PtyParsed {
            session_id: "event-session".to_string(),
            parsed: serde_json::json!({"type": "shell-state", "state": "idle"}).into(),
        });

        let response = waiter.await.unwrap();
        assert_eq!(response["met"], true);
        assert_eq!(response["timed_out"], false);
    }

    #[tokio::test]
    async fn agent_wait_returns_on_existing_message_since() {
        use std::collections::VecDeque;
        let state = test_state();
        // Register caller so mcp_to_session resolves.
        apply_initialize_identity(&state, "mcp-w", Some(TEST_UUID_A));
        let mut q = VecDeque::new();
        q.push_back(crate::state::AgentMessage {
            id: "m1".into(),
            from_tuic_session: "lead".into(),
            from_name: "lead".into(),
            content: "go".into(),
            timestamp: 5_000,
            delivered_via_channel: false,
        });
        state.agent_inbox.insert(TEST_UUID_A.to_string(), q);
        let r = handle_agent_wait(
            &state,
            &serde_json::json!({"action":"wait","since":1000}),
            Some("mcp-w"),
        )
        .await;
        assert_eq!(r["met"], true);
        assert_eq!(r["new_messages"], 1);
        assert_eq!(r["next_since"], 5_000);
        assert_eq!(r["messages"][0]["id"], "m1");
        assert_eq!(r["messages"][0]["from_tuic_session"], "lead");
        assert_eq!(r["messages"][0]["from_name"], "lead");
        assert_eq!(r["messages"][0]["content"], "go");
        assert_eq!(r["messages"][0]["timestamp"], 5_000);
        // The recipient is holding the message; which sub-route carried it is
        // server-side forensics, and a `false` here read as "not delivered" is
        // the same ambiguity that removed the field from the send response.
        assert!(
            r["messages"][0].get("delivered_via_channel").is_none(),
            "delivered_via_channel must not reach the recipient"
        );
        assert!(
            r.get("hint").is_none(),
            "steady-state success needs no hint"
        );
        assert!(r.get("overflow").is_none());
        assert!(r.get("truncated").is_none());
    }

    #[tokio::test]
    async fn mcp_delivery_regression_agent_wait_remains_pending_beyond_ten_seconds_then_wakes() {
        let state = test_state();
        let sender_mcp = "mcp-long-wait-sender";
        let recipient_mcp = "mcp-long-wait-recipient";
        register_peer(&state, TEST_UUID_A, "sender", sender_mcp);
        register_peer(&state, TEST_UUID_B, "recipient", recipient_mcp);

        let waiting_state = Arc::clone(&state);
        let waiter = tokio::spawn(async move {
            post_test_tool_call(
                waiting_state,
                recipient_mcp,
                "agent",
                serde_json::json!({
                    "action": "wait",
                    "since": 0,
                    "timeout_ms": 15_000,
                }),
            )
            .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(10_200)).await;
        assert!(
            !waiter.is_finished(),
            "the full MCP request must remain pending beyond the ordinary 10-second transport deadline"
        );
        let sent = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send",
                "to": TEST_UUID_B,
                "message": "wake the wait",
            }),
            Some(sender_mcp),
        );
        assert_eq!(sent["delivery_path"], "waiter_and_inbox");

        let rpc = tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("event-driven wait must wake immediately after inbox delivery")
            .unwrap();
        let compact = rpc["result"]["content"][0]["text"]
            .as_str()
            .expect("native MCP result text");
        let response: serde_json::Value = serde_json::from_str(compact).unwrap();
        assert_eq!(response["met"], true);
        assert_eq!(response["timed_out"], false);
        assert_eq!(response["new_messages"], 1);
        assert_eq!(response["messages"][0]["content"], "wake the wait");
    }

    #[tokio::test]
    async fn mcp_delivery_regression_agent_wait_replayed_cursor_times_out_after_observation() {
        let state = test_state();
        apply_initialize_identity(&state, "mcp-w-replay", Some(TEST_UUID_A));
        state.push_agent_inbox(
            TEST_UUID_A,
            crate::state::AgentMessage {
                id: "m-replay".into(),
                from_tuic_session: "lead".into(),
                from_name: "lead".into(),
                content: "once".into(),
                timestamp: 5_000,
                delivered_via_channel: false,
            },
        );

        let first = handle_agent_wait(
            &state,
            &serde_json::json!({"action": "wait", "since": 0, "timeout_ms": 1}),
            Some("mcp-w-replay"),
        )
        .await;
        assert_eq!(first["met"], true);
        assert_eq!(first["new_messages"], 1);
        assert_eq!(first["next_since"], 5_000);

        let replay = handle_agent_wait(
            &state,
            &serde_json::json!({"action": "wait", "since": 0, "timeout_ms": 1}),
            Some("mcp-w-replay"),
        )
        .await;
        assert_eq!(replay["met"], false);
        assert_eq!(replay["timed_out"], true);
        assert_eq!(replay["new_messages"], 0);
        assert!(replay.get("messages").is_none());
        // A timed-out replay still answers with a usable cursor — and with the
        // position reading actually reached, not the `since=0` it was asked with.
        // Losing the cursor here is what drove callers back to replaying everything.
        assert_eq!(replay["next_since"], 5_000);
    }

    /// The point of the server-side cursor: a caller that never threads `since`
    /// must not keep re-reading the same mail. Before this, an omitted `since`
    /// defaulted to 0 and replayed the whole inbox on every call.
    #[tokio::test]
    async fn omitting_since_resumes_from_the_server_cursor() {
        let state = test_state();
        apply_initialize_identity(&state, "mcp-w-cursor", Some(TEST_UUID_A));
        let push = |id: &str, timestamp: u64| {
            state.push_agent_inbox(
                TEST_UUID_A,
                crate::state::AgentMessage {
                    id: id.into(),
                    from_tuic_session: "lead".into(),
                    from_name: "lead".into(),
                    content: "payload".into(),
                    timestamp,
                    delivered_via_channel: false,
                },
            );
        };
        push("m-1", 1_000);

        let first = handle_agent_wait(
            &state,
            &serde_json::json!({"action": "wait", "timeout_ms": 1}),
            Some("mcp-w-cursor"),
        )
        .await;
        assert_eq!(first["new_messages"], 1);
        assert_eq!(first["next_since"], 1_000);

        push("m-2", 2_000);
        let second = handle_agent_wait(
            &state,
            &serde_json::json!({"action": "wait", "timeout_ms": 1}),
            Some("mcp-w-cursor"),
        )
        .await;
        assert_eq!(
            second["new_messages"], 1,
            "only the new message — the cursor moved past m-1"
        );
        assert_eq!(second["messages"][0]["id"], "m-2");
        assert_eq!(second["next_since"], 2_000);
    }

    /// `since=0` stays the deliberate replay escape hatch, and must not rewind the
    /// stored cursor for the next omitted-`since` caller.
    #[tokio::test]
    async fn explicit_since_overrides_the_cursor_without_rewinding_it() {
        let state = test_state();
        apply_initialize_identity(&state, "mcp-w-override", Some(TEST_UUID_A));
        state.push_agent_inbox(
            TEST_UUID_A,
            crate::state::AgentMessage {
                id: "m-only".into(),
                from_tuic_session: "lead".into(),
                from_name: "lead".into(),
                content: "payload".into(),
                timestamp: 7_000,
                delivered_via_channel: false,
            },
        );

        let inbox = handle_messaging(
            &state,
            &serde_json::json!({"action": "inbox"}),
            Some("mcp-w-override"),
        );
        assert_eq!(inbox["count"], 1);
        assert_eq!(inbox["next_since"], 7_000);

        let replay = handle_messaging(
            &state,
            &serde_json::json!({"action": "inbox", "since": 0}),
            Some("mcp-w-override"),
        );
        assert_eq!(replay["count"], 1, "since=0 still replays on demand");

        assert_eq!(
            state
                .agent_read_cursor
                .get(TEST_UUID_A)
                .map(|entry| *entry.value()),
            Some(7_000),
            "a replay must not rewind the stored cursor"
        );
    }

    #[tokio::test]
    async fn agent_wait_inlines_full_retained_equal_millisecond_burst() {
        let state = test_state();
        apply_initialize_identity(&state, "mcp-w-overflow", Some(TEST_UUID_A));
        for index in 1..=crate::state::AGENT_INBOX_CAPACITY {
            state.push_agent_inbox(
                TEST_UUID_A,
                crate::state::AgentMessage {
                    id: format!("m{index:03}"),
                    from_tuic_session: "lead".into(),
                    from_name: "lead".into(),
                    content: format!("body-{index:03}"),
                    timestamp: 5_000,
                    delivered_via_channel: false,
                },
            );
        }

        let response = handle_agent_wait(
            &state,
            &serde_json::json!({"action": "wait", "since": 0}),
            Some("mcp-w-overflow"),
        )
        .await;

        assert_eq!(response["met"], true);
        assert_eq!(response["timed_out"], false);
        assert_eq!(response["new_messages"], crate::state::AGENT_INBOX_CAPACITY);
        assert_eq!(
            response["messages"].as_array().unwrap().len(),
            crate::state::AGENT_INBOX_CAPACITY
        );
        assert_eq!(response["messages"][0]["id"], "m001");
        assert_eq!(response["messages"][99]["id"], "m100");
        assert_eq!(response["next_since"], 5_099);
        assert!(response.get("overflow").is_none());
        assert!(response.get("truncated").is_none());
        assert!(response.get("hint").is_none());

        let retained = state.agent_inbox.get(TEST_UUID_A).unwrap();
        assert_eq!(
            retained.len(),
            crate::state::AGENT_INBOX_CAPACITY,
            "wait must not consume inbox messages"
        );
        assert_eq!(retained.front().unwrap().id, "m001");
        assert_eq!(retained.back().unwrap().id, "m100");
    }

    #[tokio::test]
    async fn agent_wait_requires_registration() {
        let state = test_state();
        let r = handle_agent_wait(
            &state,
            &serde_json::json!({"action":"wait"}),
            Some("mcp-unregistered"),
        )
        .await;
        assert!(r["error"].as_str().unwrap().contains("not registered"));
    }

    // ── messaging tool tests ────────────────────────────────────────

    #[test]
    fn messaging_register_without_tuic_session_generates_identity() {
        let state = test_state();
        let args = serde_json::json!({"action": "register"});
        let result = handle_messaging(&state, &args, Some("mcp-1"));
        assert_eq!(result["ok"], true);
        let generated = result["tuic_session"].as_str().unwrap();
        assert!(is_valid_uuid(generated));
        assert_eq!(
            state
                .mcp_to_session
                .get("mcp-1")
                .map(|entry| entry.value().clone()),
            Some(generated.to_owned())
        );
    }

    #[test]
    fn messaging_register_requires_mcp_session() {
        let state = test_state();
        let args = serde_json::json!({"action": "register", "tuic_session": "550e8400-e29b-41d4-a716-446655440a01"});
        let result = handle_messaging(&state, &args, None);
        // Still refused — but since tools/call no longer gates on the header, this
        // message is what a stateless caller actually sees, so it must name a way
        // out rather than just state the problem (#0f44).
        let error = result["error"].as_str().unwrap();
        assert!(error.contains("mcp-session-id"), "{error}");
        assert!(error.contains("initialize"), "{error}");
    }

    #[test]
    fn messaging_register_and_list_peers() {
        let state = test_state();

        // Register two agents
        let r1 = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": "550e8400-e29b-41d4-a716-446655440a01", "name": "worker-1", "project": "/repo/a"
            }),
            Some("mcp-1"),
        );
        assert_eq!(r1["ok"], true);
        assert_eq!(r1["name"], "worker-1");

        let r2 = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": "550e8400-e29b-41d4-a716-446655440a02", "name": "worker-2", "project": "/repo/a"
            }),
            Some("mcp-2"),
        );
        assert_eq!(r2["ok"], true);

        // List all peers
        let list = handle_messaging(
            &state,
            &serde_json::json!({"action": "list_peers"}),
            Some("mcp-1"),
        );
        assert_eq!(list["count"], 2);

        // Filter by project
        let filtered = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "list_peers", "project": "/repo/b"
            }),
            Some("mcp-1"),
        );
        assert_eq!(filtered["count"], 0);
    }

    #[test]
    fn messaging_register_updates_existing() {
        let state = test_state();

        handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": "550e8400-e29b-41d4-a716-446655440a01", "name": "old-name"
            }),
            Some("mcp-1"),
        );

        // Re-register with new name
        handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": "550e8400-e29b-41d4-a716-446655440a01", "name": "new-name"
            }),
            Some("mcp-2"),
        );

        assert_eq!(state.peer_agents.len(), 1);
        assert_eq!(
            state
                .peer_agents
                .get("550e8400-e29b-41d4-a716-446655440a01")
                .unwrap()
                .name,
            "new-name"
        );
        assert_eq!(
            state
                .peer_agents
                .get("550e8400-e29b-41d4-a716-446655440a01")
                .unwrap()
                .mcp_session_id,
            "mcp-2"
        );
    }

    /// Mark an MCP session as live so the anti-hijack guard sees it as occupied.
    fn live_mcp_session(state: &Arc<AppState>, sid: &str) {
        state.mcp_sessions.insert(
            sid.to_string(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code: true,
                requires_meta_tools: false,
                has_sse_stream: false,
                sse_generation: 0,
                repo_path: None,
            },
        );
    }

    #[test]
    fn messaging_rejects_non_loopback_caller() {
        // A non-loopback caller (remote/LAN, even if it cleared auth via lan_auth_bypass)
        // must not reach any messaging action — it could otherwise register an identity
        // or inject a message into a local agent's context.
        let state = test_state();
        let lan: SocketAddr = "192.168.1.50:4000".parse().unwrap();
        let args = serde_json::json!({
            "action": "register", "tuic_session": "550e8400-e29b-41d4-a716-446655440a01"
        });
        let rejected = handle_agent_unified(&state, lan, &args, Some("mcp-lan"));
        assert!(
            rejected["error"]
                .as_str()
                .unwrap_or("")
                .contains("localhost"),
            "expected localhost-only rejection, got {rejected}"
        );
        assert_eq!(
            state.peer_agents.len(),
            0,
            "LAN register must create no peer"
        );

        // Loopback caller passes the gate and registers normally.
        let loop_addr: SocketAddr = "127.0.0.1:1".parse().unwrap();
        let ok = handle_agent_unified(&state, loop_addr, &args, Some("mcp-local"));
        assert_eq!(ok["ok"], true);
        assert_eq!(state.peer_agents.len(), 1);
    }

    #[test]
    fn messaging_register_rejects_hijack_of_live_session() {
        // A second MCP session must not steal a tuic_session whose original session is
        // still live (that would re-route the victim's inbox to the claimant).
        let state = test_state();
        let tuic = "550e8400-e29b-41d4-a716-446655440a01";
        let r1 = handle_messaging(
            &state,
            &serde_json::json!({"action": "register", "tuic_session": tuic, "name": "victim"}),
            Some("mcp-1"),
        );
        assert_eq!(r1["ok"], true);
        live_mcp_session(&state, "mcp-1");

        let hijack = handle_messaging(
            &state,
            &serde_json::json!({"action": "register", "tuic_session": tuic, "name": "attacker"}),
            Some("mcp-2"),
        );
        assert!(
            hijack["error"]
                .as_str()
                .unwrap_or("")
                .contains("another active"),
            "expected hijack rejection, got {hijack}"
        );
        let peer = state.peer_agents.get(tuic).unwrap();
        assert_eq!(peer.name, "victim");
        assert_eq!(peer.mcp_session_id, "mcp-1");
    }

    #[test]
    fn messaging_register_same_live_session_can_rename() {
        // Reconnect/rename from the SAME session must still succeed even when live.
        let state = test_state();
        let tuic = "550e8400-e29b-41d4-a716-446655440a01";
        handle_messaging(
            &state,
            &serde_json::json!({"action": "register", "tuic_session": tuic, "name": "old"}),
            Some("mcp-1"),
        );
        live_mcp_session(&state, "mcp-1");
        let r = handle_messaging(
            &state,
            &serde_json::json!({"action": "register", "tuic_session": tuic, "name": "new"}),
            Some("mcp-1"),
        );
        assert_eq!(r["ok"], true);
        assert_eq!(state.peer_agents.get(tuic).unwrap().name, "new");
    }

    #[test]
    fn messaging_register_takeover_of_dead_session_allowed() {
        // A stale binding (prior session gone) is the normal post-crash/reconnect case
        // and must be takeable — mcp-1 is never marked live here.
        let state = test_state();
        let tuic = "550e8400-e29b-41d4-a716-446655440a01";
        handle_messaging(
            &state,
            &serde_json::json!({"action": "register", "tuic_session": tuic, "name": "old"}),
            Some("mcp-1"),
        );
        let r = handle_messaging(
            &state,
            &serde_json::json!({"action": "register", "tuic_session": tuic, "name": "new"}),
            Some("mcp-2"),
        );
        assert_eq!(r["ok"], true);
        assert_eq!(state.peer_agents.get(tuic).unwrap().mcp_session_id, "mcp-2");
    }

    #[test]
    fn mcp_regression_reconnect_reclaims_ttl_entry_and_retires_old_routing() {
        let state = test_state();
        let tuic = "550e8400-e29b-41d4-a716-446655440a01";
        let first = handle_messaging(
            &state,
            &serde_json::json!({"action": "register", "tuic_session": tuic, "name": "lead"}),
            Some("mcp-old"),
        );
        assert_eq!(first["ok"], true);
        state.mcp_sessions.insert(
            "mcp-old".to_string(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now()
                    - MCP_OWNER_ACTIVITY_GRACE
                    - std::time::Duration::from_secs(1),
                is_claude_code: true,
                requires_meta_tools: false,
                has_sse_stream: true, // historical flag alone is not live ownership
                sse_generation: 0,
                repo_path: None,
            },
        );

        let reconnected = handle_messaging(
            &state,
            &serde_json::json!({"action": "register", "tuic_session": tuic, "name": "lead"}),
            Some("mcp-new"),
        );

        assert_eq!(reconnected["ok"], true, "{reconnected}");
        assert_eq!(
            state.peer_agents.get(tuic).unwrap().mcp_session_id,
            "mcp-new"
        );
        assert!(
            state.mcp_to_session.get("mcp-old").is_none(),
            "stale protocol session must lose inbox ownership"
        );
        assert_eq!(
            state.session_to_mcp.get(tuic).map(|entry| entry.clone()),
            Some(vec!["mcp-new".to_string()])
        );
    }

    #[test]
    fn messaging_register_default_name() {
        let state = test_state();
        let r = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register", "tuic_session": "550e8400-e29b-41d4-a716-446655440a01"
            }),
            Some("mcp-1"),
        );
        assert_eq!(r["name"], "agent");
        let peers = handle_messaging(
            &state,
            &serde_json::json!({"action": "list_peers"}),
            Some("mcp-1"),
        );
        assert!(
            peers["peers"][0].get("project").is_none(),
            "absent optional peer project must not serialize as null"
        );
    }

    fn register_peer(state: &Arc<AppState>, tuic: &str, name: &str, mcp: &str) {
        handle_messaging(
            state,
            &serde_json::json!({
                "action": "register", "tuic_session": tuic, "name": name
            }),
            Some(mcp),
        );
    }

    #[cfg(unix)]
    fn install_completed_agent_submission_probe(
        state: &Arc<AppState>,
        session_id: &str,
        agent_type: &str,
    ) -> std::sync::mpsc::Receiver<String> {
        use portable_pty::native_pty_system;
        use std::io::Read;

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open probe PTY");
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "printf 'READY\\n'; IFS= read -r line; printf 'SUBMITTED:%s\\n' \"$line\"",
        ]);
        let child = pair
            .slave
            .spawn_command(command)
            .expect("spawn probe shell");
        let mut reader = pair.master.try_clone_reader().expect("clone probe reader");
        let writer = pair.master.take_writer().expect("take probe writer");
        state.sessions.insert(
            session_id.to_string(),
            Mutex::new(PtySession {
                writer: Arc::new(Mutex::new(writer)),
                master: pair.master,
                _child: child,
                paused: Arc::new(AtomicBool::new(false)),
                worktree: None,
                cwd: None,
                display_name: Some("submission-probe".to_string()),
                display_name_is_custom: false,
                is_remote: true,
                shell: "/bin/sh".to_string(),
            }),
        );
        state.session_states.insert(
            session_id.to_string(),
            crate::state::SessionState {
                agent_type: Some(agent_type.to_string()),
                suggested_actions: Some(vec!["old completion".to_string()]),
                ..Default::default()
            },
        );
        state.shell_states.insert(
            session_id.to_string(),
            std::sync::atomic::AtomicU8::new(crate::pty::SHELL_IDLE),
        );
        let mut silence = crate::pty::SilenceState::new();
        silence.confirm_idle();
        silence.mark_suggest_candidate(vec!["old completion".to_string()], 0);
        state.silence_states.insert(
            session_id.to_string(),
            std::sync::Arc::new(parking_lot::Mutex::new(silence)),
        );

        let (output_tx, output_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut output = String::new();
            let _ = reader.read_to_string(&mut output);
            let _ = output_tx.send(output);
        });
        output_rx
    }

    #[test]
    fn register_populates_reverse_index_for_o1_cleanup() {
        // PERF-1: agent(register) must populate session_to_mcp so tombstone
        // cleanup avoids the O(n) scan over mcp_to_session.
        let state = test_state();
        let tuic = "550e8400-e29b-41d4-a716-446655440aa1";
        let mcp = "mcp-perf1";
        register_peer(&state, tuic, "agent", mcp);

        assert_eq!(
            state.mcp_to_session.get(mcp).map(|e| e.value().clone()),
            Some(tuic.to_string()),
            "forward index must be populated"
        );
        let reverse = state.session_to_mcp.get(tuic).map(|e| e.value().clone());
        assert_eq!(
            reverse,
            Some(vec![mcp.to_string()]),
            "reverse index must be populated to enable O(1) cleanup"
        );
    }

    #[test]
    fn messaging_send_requires_to_and_message() {
        let state = test_state();
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440a01",
            "sender",
            "mcp-1",
        );

        let r1 = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send", "message": "hello"
            }),
            Some("mcp-1"),
        );
        assert!(r1["error"].as_str().unwrap().contains("'to'"));

        let r2 = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send", "to": "550e8400-e29b-41d4-a716-446655440a02"
            }),
            Some("mcp-1"),
        );
        assert!(r2["error"].as_str().unwrap().contains("'message'"));
    }

    #[test]
    fn messaging_send_to_unregistered_peer() {
        let state = test_state();
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440a01",
            "sender",
            "mcp-1",
        );

        let r = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send", "to": "tab-999", "message": "hello"
            }),
            Some("mcp-1"),
        );
        assert!(r["error"].as_str().unwrap().contains("not registered"));
    }

    #[test]
    fn messaging_send_and_inbox() {
        let state = test_state();
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440a01",
            "alice",
            "mcp-1",
        );
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440a02",
            "bob",
            "mcp-2",
        );

        // Alice sends to Bob
        let r = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send", "to": "550e8400-e29b-41d4-a716-446655440a02", "message": "hello bob"
            }),
            Some("mcp-1"),
        );
        assert_eq!(r["ok"], true);

        // Bob checks inbox
        let inbox = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "inbox"
            }),
            Some("mcp-2"),
        );
        let msgs = inbox["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["from_name"], "alice");
        assert_eq!(msgs[0]["content"], "hello bob");
        assert_eq!(
            msgs[0]["from_tuic_session"],
            "550e8400-e29b-41d4-a716-446655440a01"
        );
    }

    #[test]
    fn mcp_delivery_regression_completed_claude_sse_submits_through_pty() {
        let state = test_state();
        register_peer(&state, TEST_UUID_A, "sender", "mcp-sender");
        register_peer(&state, TEST_UUID_B, "recipient", "mcp-recipient");
        state.mcp_sessions.insert(
            "mcp-recipient".to_string(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code: true,
                requires_meta_tools: false,
                has_sse_stream: true,
                sse_generation: 0,
                repo_path: None,
            },
        );
        let (channel, mut receiver) = tokio::sync::broadcast::channel(4);
        state
            .messaging_channels
            .insert("mcp-recipient".to_string(), channel);
        let submitted_output =
            install_completed_agent_submission_probe(&state, TEST_UUID_B, "claude");

        let result = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send",
                "to": TEST_UUID_B,
                "message": "start the next task",
            }),
            Some("mcp-sender"),
        );

        assert_eq!(result["delivery_path"], "terminal_or_queued_and_inbox");
        assert!(
            matches!(
                receiver.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty)
            ),
            "a completed composer must not surrender wake-up ownership to SSE"
        );
        let output = submitted_output
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("probe exits only after the separately written Enter submits the line");
        assert!(
            output.contains("SUBMITTED:[TUIC message from sender] start the next task"),
            "the completed Claude PTY must observe a complete submitted line: {output:?}"
        );
        let message_id = result["message_id"].as_str().unwrap();
        assert_eq!(
            state.agent_delivery_owner(TEST_UUID_B, message_id),
            Some(crate::state::AgentDeliveryOwner::TerminalDispatched)
        );
        assert!(
            state
                .pending_injections
                .get(TEST_UUID_B)
                .is_none_or(|pending| pending.is_empty()),
            "successful PTY submission must not leave a queued duplicate"
        );
        let snapshot = state.session_state_with_shell(TEST_UUID_B).unwrap();
        assert_eq!(snapshot.shell_state.as_deref(), Some("busy"));
        assert_eq!(snapshot.agent_state.as_deref(), Some("working"));
        assert!(snapshot.suggested_actions.is_none());
        assert_eq!(snapshot.turn_epoch, 1);
    }

    #[cfg(unix)]
    #[test]
    fn idle_orchestrator_receives_only_generic_mail_wake() {
        let state = test_state();
        register_peer(&state, TEST_UUID_A, "sender", "mcp-sender");
        register_peer(&state, TEST_UUID_B, "orchestrator", "mcp-recipient");
        state.orchestrator_peers.insert(TEST_UUID_B.to_string());
        let submitted_output =
            install_completed_agent_submission_probe(&state, TEST_UUID_B, "codex");

        let result = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send",
                "to": TEST_UUID_B,
                "message": "secret peer payload",
            }),
            Some("mcp-sender"),
        );

        assert_eq!(result["delivery_path"], "wake_notification_and_inbox");
        let output = submitted_output
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("generic wake should submit a new turn");
        assert!(output.contains("message available"), "{output:?}");
        assert!(output.contains("agent action=inbox"), "{output:?}");
        assert!(
            !output.contains("secret peer payload"),
            "the peer payload must remain inbox-only: {output:?}"
        );
        assert_eq!(
            state.agent_inbox.get(TEST_UUID_B).unwrap()[0].content,
            "secret peer payload"
        );
    }

    #[cfg(unix)]
    #[test]
    fn idle_orchestrator_reads_child_lifecycle_off_the_notice_itself() {
        let state = test_state();
        register_peer(&state, TEST_UUID_B, "orchestrator", "mcp-recipient");
        state.orchestrator_peers.insert(TEST_UUID_B.to_string());
        state
            .session_parent
            .insert(TEST_UUID_A.to_string(), TEST_UUID_B.to_string());
        let submitted_output =
            install_completed_agent_submission_probe(&state, TEST_UUID_B, "codex");

        crate::pty::push_state_change_to_parent(
            &state,
            TEST_UUID_A,
            serde_json::json!({
                "type": "state_change",
                "state": "exited",
                "session_id": TEST_UUID_A,
                "exit_code": 0,
            }),
        );

        let output = submitted_output
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("a lifecycle notice should submit a new turn");
        assert!(
            output.contains(&format!(
                "child agent {} exited (exit 0)",
                &TEST_UUID_A[..8]
            )),
            "{output:?}"
        );
        assert!(
            !output.contains("message available"),
            "a lifecycle-only window must not cost an inbox round-trip: {output:?}"
        );
        assert_eq!(
            state.agent_inbox.get(TEST_UUID_B).unwrap().len(),
            1,
            "the inbox copy stays authoritative and auditable"
        );
        assert_eq!(
            state.orchestrator_wake_needed_through(TEST_UUID_B),
            None,
            "the notice acknowledged itself"
        );
    }

    #[cfg(unix)]
    #[test]
    fn working_orchestrator_is_inbox_only_even_with_claude_channel() {
        let state = test_state();
        register_peer(&state, TEST_UUID_A, "sender", "mcp-sender");
        register_peer(&state, TEST_UUID_B, "orchestrator", "mcp-recipient");
        state.orchestrator_peers.insert(TEST_UUID_B.to_string());
        state.mcp_sessions.insert(
            "mcp-recipient".to_string(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code: true,
                requires_meta_tools: false,
                has_sse_stream: true,
                sse_generation: 0,
                repo_path: None,
            },
        );
        let (channel, mut receiver) = tokio::sync::broadcast::channel(4);
        state
            .messaging_channels
            .insert("mcp-recipient".to_string(), channel);
        let _submitted_output =
            install_completed_agent_submission_probe(&state, TEST_UUID_B, "claude");
        state
            .session_states
            .get_mut(TEST_UUID_B)
            .unwrap()
            .suggested_actions = None;
        state
            .silence_states
            .get(TEST_UUID_B)
            .unwrap()
            .lock()
            .reset_suggest_memory();
        state.shell_states.insert(
            TEST_UUID_B.to_string(),
            std::sync::atomic::AtomicU8::new(crate::pty::SHELL_BUSY),
        );

        let result = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send",
                "to": TEST_UUID_B,
                "message": "do not steer the active turn",
            }),
            Some("mcp-sender"),
        );

        assert_eq!(result["delivery_path"], "inbox_only");
        assert_eq!(result["delivered"], false);
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        assert!(
            state
                .pending_injections
                .get(TEST_UUID_B)
                .is_none_or(|pending| pending.is_empty()),
            "busy orchestrator mail must not be queued for a later idle transition"
        );
    }

    #[test]
    fn mcp_delivery_regression_working_claude_keeps_sse_turn_delivery() {
        let state = test_state();
        register_peer(&state, TEST_UUID_A, "sender", "mcp-sender");
        register_peer(&state, TEST_UUID_B, "recipient", "mcp-recipient");
        state.mcp_sessions.insert(
            "mcp-recipient".to_string(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code: true,
                requires_meta_tools: false,
                has_sse_stream: true,
                sse_generation: 0,
                repo_path: None,
            },
        );
        let (channel, mut receiver) = tokio::sync::broadcast::channel(4);
        state
            .messaging_channels
            .insert("mcp-recipient".to_string(), channel);
        let _submitted_output =
            install_completed_agent_submission_probe(&state, TEST_UUID_B, "claude");
        {
            let mut session = state.session_states.get_mut(TEST_UUID_B).unwrap();
            session.suggested_actions = None;
        }
        state
            .silence_states
            .get(TEST_UUID_B)
            .unwrap()
            .lock()
            .reset_suggest_memory();
        state
            .shell_states
            .get(TEST_UUID_B)
            .unwrap()
            .store(crate::pty::SHELL_BUSY, std::sync::atomic::Ordering::Release);

        let result = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send",
                "to": TEST_UUID_B,
                "message": "context for the active task",
            }),
            Some("mcp-sender"),
        );

        assert_eq!(result["delivery_path"], "sse_channel_and_inbox");
        assert!(receiver.try_recv().is_ok());
        let snapshot = state.session_state_with_shell(TEST_UUID_B).unwrap();
        assert_eq!(snapshot.agent_state.as_deref(), Some("working"));
        assert_eq!(snapshot.turn_epoch, 0);
    }

    #[test]
    fn mcp_delivery_regression_inbox_only_preserves_completed_lifecycle() {
        let state = test_state();
        register_peer(&state, TEST_UUID_A, "sender", "mcp-sender");
        register_peer(&state, TEST_UUID_B, "recipient", "mcp-recipient");
        state.session_states.insert(
            TEST_UUID_B.to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                suggested_actions: Some(vec!["old completion".to_string()]),
                ..Default::default()
            },
        );
        state.shell_states.insert(
            TEST_UUID_B.to_string(),
            std::sync::atomic::AtomicU8::new(crate::pty::SHELL_IDLE),
        );
        let mut silence = crate::pty::SilenceState::new();
        silence.confirm_idle();
        silence.mark_suggest_candidate(vec!["old completion".to_string()], 0);
        state.silence_states.insert(
            TEST_UUID_B.to_string(),
            std::sync::Arc::new(parking_lot::Mutex::new(silence)),
        );

        let result = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send",
                "to": TEST_UUID_B,
                "message": "buffer only",
            }),
            Some("mcp-sender"),
        );

        assert_eq!(result["accepted"], true);
        assert_eq!(result["delivery_path"], "inbox_only");
        let snapshot = state.session_state_with_shell(TEST_UUID_B).unwrap();
        assert_eq!(snapshot.agent_state.as_deref(), Some("completed"));
        assert_eq!(snapshot.turn_epoch, 0);
        assert_eq!(
            snapshot.suggested_actions,
            Some(vec!["old completion".to_string()])
        );
    }

    #[cfg(unix)]
    #[test]
    fn mcp_delivery_regression_codex_live_sse_submits_through_pty_before_working() {
        let state = test_state();
        register_peer(&state, TEST_UUID_A, "sender", "mcp-sender");
        register_peer(&state, TEST_UUID_B, "recipient", "mcp-recipient");
        state.mcp_sessions.insert(
            "mcp-recipient".to_string(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                // A bridge-owned SSE stream can look Claude-capable even when
                // its managed terminal is actually Codex. The PTY type is the
                // authoritative cross-check for channel-turn support.
                is_claude_code: true,
                requires_meta_tools: false,
                has_sse_stream: true,
                sse_generation: 0,
                repo_path: None,
            },
        );
        let (channel, mut channel_receiver) = tokio::sync::broadcast::channel(4);
        state
            .messaging_channels
            .insert("mcp-recipient".to_string(), channel);
        let submitted_output =
            install_completed_agent_submission_probe(&state, TEST_UUID_B, "codex");

        let result = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send",
                "to": TEST_UUID_B,
                "message": "start the next task",
            }),
            Some("mcp-sender"),
        );

        assert_eq!(result["accepted"], true);
        assert_eq!(result["delivery_path"], "terminal_or_queued_and_inbox");
        assert!(
            matches!(
                channel_receiver.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty)
            ),
            "Codex must not receive the Claude-only channel notification"
        );
        let output = submitted_output
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("probe exits only after the separately written Enter submits the line");
        assert!(
            output.contains("SUBMITTED:[TUIC message from sender] start the next task"),
            "the managed Codex PTY must observe a complete submitted line: {output:?}"
        );
        let snapshot = state.session_state_with_shell(TEST_UUID_B).unwrap();
        assert_eq!(snapshot.shell_state.as_deref(), Some("busy"));
        assert_eq!(snapshot.agent_state.as_deref(), Some("working"));
        assert!(snapshot.suggested_actions.is_none());
        assert_eq!(snapshot.turn_epoch, 1);
    }

    #[test]
    fn messaging_inbox_limit_and_since() {
        let state = test_state();
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440a01",
            "alice",
            "mcp-1",
        );
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440a02",
            "bob",
            "mcp-2",
        );

        // Send 3 messages
        for i in 0..3 {
            handle_messaging(
                &state,
                &serde_json::json!({
                    "action": "send", "to": "550e8400-e29b-41d4-a716-446655440a02", "message": format!("msg-{}", i)
                }),
                Some("mcp-1"),
            );
        }

        // Limit to 2
        let inbox = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "inbox", "limit": 2
            }),
            Some("mcp-2"),
        );
        assert_eq!(inbox["messages"].as_array().unwrap().len(), 2);

        // Since filter — get timestamp of first message
        let first_ts = inbox["messages"][0]["timestamp"].as_u64().unwrap();
        let since_inbox = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "inbox", "since": first_ts
            }),
            Some("mcp-2"),
        );
        // Should return messages after that timestamp (at least the remaining ones)
        let msgs = since_inbox["messages"].as_array().unwrap();
        assert!(
            msgs.iter()
                .all(|m| m["timestamp"].as_u64().unwrap() > first_ts)
        );
    }

    #[test]
    fn messaging_send_requires_sender_registration() {
        let state = test_state();
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440a02",
            "bob",
            "mcp-2",
        );

        let r = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send", "to": "550e8400-e29b-41d4-a716-446655440a02", "message": "hello"
            }),
            Some("mcp-unknown"),
        );
        assert!(r["error"].as_str().unwrap().contains("Register first"));
    }

    #[test]
    fn messaging_inbox_fifo_eviction() {
        let state = test_state();
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440a01",
            "alice",
            "mcp-1",
        );
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440a02",
            "bob",
            "mcp-2",
        );

        // Send more than AGENT_INBOX_CAPACITY messages
        for i in 0..(crate::state::AGENT_INBOX_CAPACITY + 10) {
            handle_messaging(
                &state,
                &serde_json::json!({
                    "action": "send", "to": "550e8400-e29b-41d4-a716-446655440a02", "message": format!("msg-{}", i)
                }),
                Some("mcp-1"),
            );
        }

        let inbox = handle_messaging(
            &state,
            &serde_json::json!({"action": "inbox", "limit": 200}),
            Some("mcp-2"),
        );
        let msgs = inbox["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), crate::state::AGENT_INBOX_CAPACITY);
        // First message should be msg-10 (oldest 10 evicted)
        assert_eq!(msgs[0]["content"], "msg-10");
    }

    #[test]
    fn messaging_inbox_missed_count_on_eviction() {
        let state = test_state();
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440a01",
            "alice",
            "mcp-1",
        );
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440a02",
            "bob",
            "mcp-2",
        );

        // Fill to capacity — no eviction yet
        for i in 0..crate::state::AGENT_INBOX_CAPACITY {
            handle_messaging(
                &state,
                &serde_json::json!({
                    "action": "send", "to": "550e8400-e29b-41d4-a716-446655440a02", "message": format!("msg-{}", i)
                }),
                Some("mcp-1"),
            );
        }
        let inbox = handle_messaging(
            &state,
            &serde_json::json!({"action": "inbox"}),
            Some("mcp-2"),
        );
        assert_eq!(
            inbox["missed_count"].as_u64().unwrap_or(0),
            0,
            "no evictions yet"
        );

        // 5 more messages → 5 evictions
        for i in 0..5 {
            handle_messaging(
                &state,
                &serde_json::json!({
                    "action": "send", "to": "550e8400-e29b-41d4-a716-446655440a02", "message": format!("extra-{}", i)
                }),
                Some("mcp-1"),
            );
        }
        let inbox = handle_messaging(
            &state,
            &serde_json::json!({"action": "inbox"}),
            Some("mcp-2"),
        );
        assert_eq!(
            inbox["missed_count"].as_u64().unwrap(),
            5,
            "5 evictions reported"
        );

        // Second read — counter reset after first read
        let inbox2 = handle_messaging(
            &state,
            &serde_json::json!({"action": "inbox"}),
            Some("mcp-2"),
        );
        assert_eq!(
            inbox2["missed_count"].as_u64().unwrap_or(0),
            0,
            "counter reset after read"
        );
    }

    #[test]
    fn messaging_send_message_size_limit() {
        let state = test_state();
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440a01",
            "alice",
            "mcp-1",
        );
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440a02",
            "bob",
            "mcp-2",
        );

        let big_msg = "x".repeat(crate::state::AGENT_MESSAGE_MAX_BYTES + 1);
        let r = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send", "to": "550e8400-e29b-41d4-a716-446655440a02", "message": big_msg
            }),
            Some("mcp-1"),
        );
        assert!(r["error"].as_str().unwrap().contains("64 KB"));
    }

    // ── Meta-tool collapse tests (story 1078) ───────────────────────────

    /// Helper: extract tool names from a tool definitions value.
    fn tool_names(tools: &serde_json::Value) -> Vec<String> {
        tools
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t["name"].as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn meta_tool_definitions_returns_exactly_three_tools_with_expected_names() {
        let state = test_state();
        let defs = meta_tool_definitions(&state);
        let names = tool_names(&defs);
        assert_eq!(names.len(), 3, "meta_tool_definitions must return 3 tools");
        assert_eq!(names, vec!["search_tools", "get_tool_schema", "call_tool"]);
        // Each must have a non-empty description and an inputSchema object.
        for tool in defs.as_array().unwrap() {
            assert!(
                tool["description"]
                    .as_str()
                    .map(|s| !s.is_empty())
                    .unwrap_or(false),
                "meta tool {:?} missing description",
                tool["name"]
            );
            assert!(
                tool["inputSchema"].is_object(),
                "meta tool {:?} missing inputSchema",
                tool["name"]
            );
        }
    }

    #[test]
    fn meta_tool_names_constant_matches_definitions() {
        let state = test_state();
        let defs = meta_tool_definitions(&state);
        let names = tool_names(&defs);
        let expected: Vec<String> = META_TOOL_NAMES.iter().map(|s| s.to_string()).collect();
        assert_eq!(names, expected);
    }

    #[test]
    fn native_tool_definitions_returns_base_plus_ai_terminal_tools() {
        let defs = native_tool_definitions();
        let names = tool_names(&defs);
        assert_eq!(
            names,
            vec![
                "session",
                "agent",
                "task",
                "repo",
                "ui",
                "plugin_dev_guide",
                "config",
                "debug",
                "ai_terminal_read_screen",
                "ai_terminal_send_input",
                "ai_terminal_send_key",
                "ai_terminal_wait_for",
                "ai_terminal_get_state",
                "ai_terminal_get_context",
                "ai_terminal_read_file",
                "ai_terminal_write_file",
                "ai_terminal_edit_file",
                "ai_terminal_list_files",
                "ai_terminal_search_files",
                "ai_terminal_run_command",
                "ai_terminal_drive_agent",
            ],
            "native_tool_definitions must return 8 base tools + 13 ai_terminal_* tools in order"
        );
    }

    #[test]
    fn session_description_mentions_tmux_pane_semantics() {
        let defs = native_tool_definitions();
        let session = defs
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "session")
            .unwrap();
        let desc = session["description"].as_str().unwrap();
        assert!(
            desc.contains("tmux"),
            "session description must reference tmux for discoverability"
        );
        assert!(
            desc.contains("send-keys") || desc.contains("send_keys"),
            "session description must mention send-keys equivalent"
        );
        assert!(
            desc.contains("capture-pane") || desc.contains("capture_pane"),
            "session description must mention capture-pane equivalent"
        );
    }

    #[test]
    fn agent_tool_includes_messaging_actions() {
        let defs = native_tool_definitions();
        let agent = defs
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "agent")
            .unwrap();
        let action_desc = agent["inputSchema"]["properties"]["action"]["description"]
            .as_str()
            .unwrap();
        for action in &["register", "list_peers", "send", "inbox", "wait"] {
            assert!(
                action_desc.contains(action),
                "agent action description must include '{action}'"
            );
        }
    }

    #[test]
    fn agent_tool_description_carries_orchestration_crash_course() {
        // Tool descriptions reach every MCP client (unlike initialize
        // `instructions`, which clients like Codex ignore). The 5-line
        // orchestration primer + wait/send delivery semantics must live here.
        let defs = native_tool_definitions();
        let agent = defs
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "agent")
            .unwrap();
        let desc = agent["description"].as_str().unwrap();
        assert!(
            desc.contains("Managed PTYs auto-bind"),
            "must state the condition for auto-identity"
        );
        assert!(
            desc.contains("headerless external caller"),
            "must explain how external callers establish identity"
        );
        assert!(desc.contains("wait"), "must mention the wait primitive");
        assert!(
            desc.contains("Ordinary managed agents keep direct delivery"),
            "must preserve ordinary managed-agent delivery"
        );
        assert!(
            desc.contains("generic `agent action=inbox` wake"),
            "must explain payload-free orchestrator wake delivery"
        );
        assert!(
            desc.contains("do NOT poll"),
            "must discourage polling loops"
        );
        assert!(desc.contains("state only"));
        assert!(desc.contains("must report task output"));
    }

    #[test]
    fn session_tool_description_includes_wait() {
        let defs = native_tool_definitions();
        let session = defs
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "session")
            .unwrap();
        let action_desc = session["inputSchema"]["properties"]["action"]["description"]
            .as_str()
            .unwrap();
        assert!(action_desc.contains("wait"), "session must advertise wait");
        assert!(
            session["inputSchema"]["properties"]["until"].is_object(),
            "session wait needs an 'until' param"
        );
    }

    #[test]
    fn repo_tool_includes_workspace_github_worktree_actions() {
        let defs = native_tool_definitions();
        let repo = defs
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "repo")
            .unwrap();
        let action_desc = repo["inputSchema"]["properties"]["action"]["description"]
            .as_str()
            .unwrap();
        for action in &[
            "list",
            "active",
            "prs",
            "status",
            "worktree_list",
            "worktree_create",
            "worktree_remove",
        ] {
            assert!(
                action_desc.contains(action),
                "repo action description must include '{action}'"
            );
        }
    }

    #[test]
    fn ui_tool_includes_notify_actions() {
        let defs = native_tool_definitions();
        let ui = defs
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "ui")
            .unwrap();
        let action_desc = ui["inputSchema"]["properties"]["action"]["description"]
            .as_str()
            .unwrap();
        for action in &["tab", "toast", "confirm"] {
            assert!(
                action_desc.contains(action),
                "ui action description must include '{action}'"
            );
        }
    }

    #[test]
    fn debug_tool_includes_sessions_action() {
        let defs = native_tool_definitions();
        let debug = defs
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "debug")
            .unwrap();
        let action_desc = debug["inputSchema"]["properties"]["action"]["description"]
            .as_str()
            .unwrap();
        assert!(
            action_desc.contains("sessions"),
            "debug action description must include 'sessions'"
        );
    }

    #[test]
    fn merged_tools_collapse_false_returns_all_native_tools() {
        let state = test_state();
        assert!(!state.config.read().collapse_tools);
        // ai_terminal_* tools are gated behind `ai_terminal_mcp_enabled`; enable
        // it so `merged_tool_definitions` returns the full `native_tool_definitions`.
        state.config.write().ai_terminal_mcp_enabled = true;

        let merged = merged_tool_definitions(&state, None);
        let names = tool_names(&merged);

        let native = tool_names(&native_tool_definitions());
        assert_eq!(
            names, native,
            "collapse_tools=false should return all native tools"
        );
        assert!(
            names.len() > 3,
            "baseline native tool set must exceed 3 tools"
        );
    }

    #[test]
    fn merged_tools_hide_ai_terminal_when_flag_disabled() {
        let state = test_state();
        assert!(!state.config.read().ai_terminal_mcp_enabled);

        let merged = merged_tool_definitions(&state, None);
        let names = tool_names(&merged);

        for name in &names {
            assert!(
                !super::super::ai_terminal::is_ai_terminal_tool(name),
                "ai_terminal tool {name} must be hidden when ai_terminal_mcp_enabled=false"
            );
        }
    }

    #[test]
    fn merged_tools_collapse_true_returns_exactly_three_meta_tools() {
        let state = test_state();
        state.config.write().collapse_tools = true;

        let merged = merged_tool_definitions(&state, None);
        let names = tool_names(&merged);

        assert_eq!(names.len(), 3);
        assert_eq!(names, vec!["search_tools", "get_tool_schema", "call_tool"]);
    }

    #[test]
    fn grok_session_uses_meta_tools_without_mutating_global_config() {
        let state = test_state();
        assert!(!state.config.read().collapse_tools);
        state.mcp_sessions.insert(
            "grok-session".to_string(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code: false,
                requires_meta_tools: true,
                has_sse_stream: false,
                sse_generation: 0,
                repo_path: None,
            },
        );

        let merged = merged_tool_definitions(&state, Some("grok-session"));
        assert_eq!(
            tool_names(&merged),
            vec!["search_tools", "get_tool_schema", "call_tool"]
        );
        assert!(!state.config.read().collapse_tools);
    }

    #[test]
    fn grok_client_requires_meta_tools() {
        assert!(client_requires_meta_tools(Some("grok-shell-tuicommander")));
        assert!(client_requires_meta_tools(Some("GROK-SHELL-tuicommander")));
        assert!(!client_requires_meta_tools(Some("claude-code")));
        assert!(!client_requires_meta_tools(Some(
            "not-grok-shell-tuicommander"
        )));
        assert!(!client_requires_meta_tools(None));
    }

    #[tokio::test]
    async fn unsupported_server_discover_is_the_deliberate_fallback_boundary() {
        let response = mcp_post(
            State(test_state()),
            ConnectInfo("127.0.0.1:0".parse().unwrap()),
            HeaderMap::new(),
            Json(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "server/discover",
                "params": {
                    "_meta": {
                        "io.modelcontextprotocol/clientInfo": {
                            "name": "probe-client",
                            "version": "1.0.0"
                        }
                    }
                }
            })),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 7,
                "error": { "code": -32601, "message": "Method not found: server/discover" }
            })
        );
    }

    /// Sanity check on the token-reduction claim for lazy tool loading.
    /// Measured on the native-only test state (no upstreams registered):
    /// baseline ≈ 11 KiB, collapsed ≈ 1.7 KiB — roughly 6.7× reduction.
    /// In production with typical upstreams (100+ tools) the baseline is
    /// ~35 KiB, pushing the real reduction toward ~20×. Thresholds here
    /// are regression guards, not targets, so they use the conservative
    /// native-only numbers.
    #[test]
    fn collapse_tools_payload_size_meets_reduction_target() {
        let state = test_state();

        let baseline = serde_json::to_vec(&merged_tool_definitions(&state, None))
            .expect("serialize baseline")
            .len();

        state.config.write().collapse_tools = true;
        let collapsed = serde_json::to_vec(&merged_tool_definitions(&state, None))
            .expect("serialize collapsed")
            .len();

        assert!(
            collapsed < 4096,
            "collapsed tools/list must stay under 4 KiB, got {collapsed} bytes"
        );
        assert!(
            baseline >= collapsed * 5,
            "expected >=5x reduction on native-only state, baseline={baseline} collapsed={collapsed}"
        );
    }

    #[test]
    fn merged_tools_collapse_true_ignores_disabled_native_tools() {
        // When collapsed, disabled_native_tools has no effect on the returned list —
        // the 3 meta-tools are always the full response. (Enforcement happens inside
        // search_tools / call_tool handlers in story 1079/1080.)
        let state = test_state();
        state.config.write().collapse_tools = true;
        state.config.write().disabled_native_tools = vec!["session".to_string()];

        let merged = merged_tool_definitions(&state, None);
        assert_eq!(tool_names(&merged).len(), 3);
    }

    // ── Meta-tool handler tests (story 1079) ───────────────────────────

    fn loopback_addr() -> SocketAddr {
        "127.0.0.1:12345".parse().unwrap()
    }

    fn non_loopback_addr() -> SocketAddr {
        "192.168.1.42:12345".parse().unwrap()
    }

    // search_tools

    #[test]
    fn search_tools_requires_query() {
        let state = test_state();
        let r = handle_search_tools(&state, &serde_json::json!({}));
        assert!(r["error"].as_str().unwrap().contains("query"));

        let r = handle_search_tools(&state, &serde_json::json!({ "query": "" }));
        assert!(r["error"].as_str().unwrap().contains("query"));

        let r = handle_search_tools(&state, &serde_json::json!({ "query": "   " }));
        assert!(r["error"].as_str().unwrap().contains("query"));
    }

    #[test]
    fn search_tools_returns_ranked_results_for_session_query() {
        let state = test_state();
        // Query targets the PTY multiplexer specifically — distinguishes
        // `session` from the ai_terminal_* observation tools that also
        // mention "terminal".
        let r = handle_search_tools(
            &state,
            &serde_json::json!({ "query": "PTY multiplexer tmux pane lifecycle" }),
        );
        let results = r["results"].as_array().unwrap();
        assert!(!results.is_empty(), "expected non-empty results");
        assert_eq!(results[0]["name"], "session");
        // summary is the first sentence of the description — must be populated.
        assert!(
            results[0]["summary"]
                .as_str()
                .map(|s| !s.is_empty())
                .unwrap_or(false)
        );
    }

    #[test]
    fn search_tools_returns_ranked_results_for_github_query() {
        let state = test_state();
        let r = handle_search_tools(&state, &serde_json::json!({ "query": "github PR status" }));
        let results = r["results"].as_array().unwrap();
        assert_eq!(results[0]["name"], "repo");
    }

    #[test]
    fn search_tools_excludes_disabled_native_tools() {
        let state = test_state();
        state.config.write().disabled_native_tools = vec!["session".to_string()];
        rebuild_tool_search_index(&state);

        let r = handle_search_tools(&state, &serde_json::json!({ "query": "terminal session" }));
        let results = r["results"].as_array().unwrap();
        // "session" must not appear at all.
        let has_session = results.iter().any(|v| v["name"] == "session");
        assert!(
            !has_session,
            "disabled 'session' tool must be absent from search results"
        );
    }

    #[test]
    fn search_tools_nonsense_query_returns_empty() {
        let state = test_state();
        let r = handle_search_tools(
            &state,
            &serde_json::json!({ "query": "xyzzyplugh nonsense qqq" }),
        );
        let results = r["results"].as_array().unwrap();
        assert_eq!(results.len(), 0);
        assert_eq!(r["count"], 0);
    }

    #[test]
    fn search_tools_respects_limit() {
        let state = test_state();
        let r = handle_search_tools(
            &state,
            &serde_json::json!({ "query": "action", "limit": 2 }),
        );
        let results = r["results"].as_array().unwrap();
        assert!(results.len() <= 2);
    }

    // get_tool_schema

    #[test]
    fn get_tool_schema_requires_tool_name() {
        let state = test_state();
        let r = handle_get_tool_schema(&state, &serde_json::json!({}));
        assert!(r["error"].as_str().unwrap().contains("tool_name"));
    }

    #[test]
    fn get_tool_schema_returns_full_definition_for_native_tool() {
        let state = test_state();
        let r = handle_get_tool_schema(&state, &serde_json::json!({ "tool_name": "session" }));
        assert_eq!(r["name"], "session");
        assert!(r["description"].as_str().is_some());
        assert!(r["inputSchema"].is_object());
        assert_eq!(r["inputSchema"]["type"], "object");
    }

    #[test]
    fn get_tool_schema_returns_error_for_unknown_tool() {
        let state = test_state();
        let r = handle_get_tool_schema(
            &state,
            &serde_json::json!({ "tool_name": "does_not_exist" }),
        );
        let err = r["error"].as_str().unwrap();
        assert!(err.contains("not found"));
        assert!(
            err.contains("search_tools"),
            "error should guide user to search_tools"
        );
    }

    #[test]
    fn get_tool_schema_excludes_disabled_native_tools() {
        let state = test_state();
        state.config.write().disabled_native_tools = vec!["debug".to_string()];
        rebuild_tool_search_index(&state);
        let r = handle_get_tool_schema(&state, &serde_json::json!({ "tool_name": "debug" }));
        assert!(r["error"].as_str().is_some());
    }

    // call_tool

    #[tokio::test]
    async fn call_tool_requires_tool_name() {
        let state = test_state();
        let r = handle_call_tool(&state, loopback_addr(), &serde_json::json!({}), None, None).await;
        assert!(r["error"].as_str().unwrap().contains("tool_name"));
    }

    #[tokio::test]
    async fn call_tool_blocks_meta_tool_recursion() {
        let state = test_state();
        for meta in META_TOOL_NAMES {
            let r = handle_call_tool(
                &state,
                loopback_addr(),
                &serde_json::json!({ "tool_name": meta, "arguments": { "query": "x" } }),
                None,
                None,
            )
            .await;
            let err = r["error"].as_str().unwrap();
            assert!(
                err.contains("cannot invoke meta-tool"),
                "meta '{meta}' should be blocked: {err}"
            );
        }
    }

    #[tokio::test]
    async fn call_tool_rejects_disabled_native_tool() {
        let state = test_state();
        state.config.write().disabled_native_tools = vec!["workspace".to_string()];
        let r = handle_call_tool(
            &state,
            loopback_addr(),
            &serde_json::json!({ "tool_name": "workspace", "arguments": { "action": "active" } }),
            None,
            None,
        )
        .await;
        assert!(r["error"].as_str().unwrap().contains("disabled"));
    }

    #[tokio::test]
    async fn call_tool_returns_unknown_tool_error_for_bogus_name() {
        let state = test_state();
        let r = handle_call_tool(
            &state,
            loopback_addr(),
            &serde_json::json!({ "tool_name": "nonsense_xyz", "arguments": {} }),
            None,
            None,
        )
        .await;
        let err = r["error"].as_str().unwrap();
        assert!(err.contains("Unknown tool"));
    }

    #[tokio::test]
    async fn call_tool_dispatches_to_native_handler_propagating_args() {
        // session with a missing action should surface handle_session's guidance
        // error — this proves the args went through the dispatch layer.
        let state = test_state();
        let r = handle_call_tool(
            &state,
            loopback_addr(),
            &serde_json::json!({ "tool_name": "session", "arguments": {} }),
            None,
            None,
        )
        .await;
        let err = r["error"].as_str().unwrap();
        assert!(
            err.contains("action"),
            "expected handle_session's 'action' guidance error: {err}"
        );
    }

    #[tokio::test]
    async fn call_tool_propagates_addr_for_localhost_only_tools() {
        // config save is restricted to loopback addresses. call_tool must propagate
        // the caller's addr so the restriction still fires through the meta layer.
        let state = test_state();
        let r = handle_call_tool(
            &state,
            non_loopback_addr(),
            &serde_json::json!({
                "tool_name": "config",
                "arguments": { "action": "save", "config": {} }
            }),
            None,
            None,
        )
        .await;
        let err = r["error"].as_str().unwrap();
        assert!(
            err.contains("localhost"),
            "non-loopback config save must be rejected via addr propagation: {err}"
        );
    }

    #[tokio::test]
    async fn call_tool_missing_arguments_defaults_to_empty_object() {
        // Omitting 'arguments' must not crash — handler receives {} and produces
        // its own missing-action error.
        let state = test_state();
        let r = handle_call_tool(
            &state,
            loopback_addr(),
            &serde_json::json!({ "tool_name": "session" }),
            None,
            None,
        )
        .await;
        assert!(r["error"].as_str().unwrap().contains("action"));
    }

    #[tokio::test]
    async fn call_tool_routes_unknown_upstream_prefixed_name_through_proxy() {
        // No upstreams are registered in tests — any tool_name with "__" falls
        // through to proxy_tool_call, which errors out. We just verify that the
        // error comes from the upstream path (not the native unknown-tool branch).
        let state = test_state();
        let r = handle_call_tool(
            &state,
            loopback_addr(),
            &serde_json::json!({ "tool_name": "fake_upstream__some_tool", "arguments": {} }),
            None,
            None,
        )
        .await;
        let err = r["error"].as_str().unwrap();
        // proxy_tool_call returns an error string — just assert it's an error and
        // that the native unknown-tool message is NOT what we got.
        assert!(
            !err.contains("Unknown tool"),
            "upstream-prefixed name must not hit native fallthrough: {err}"
        );
    }

    // Route via the top-level dispatcher too, to cover the match-arm wiring.
    #[tokio::test]
    async fn handle_mcp_tool_call_routes_search_tools() {
        let state = test_state();
        let r = handle_mcp_tool_call(
            &state,
            loopback_addr(),
            "search_tools",
            &serde_json::json!({ "query": "terminal" }),
            None,
        )
        .await;
        assert!(r["results"].is_array());
    }

    #[tokio::test]
    async fn handle_mcp_tool_call_routes_get_tool_schema() {
        let state = test_state();
        let r = handle_mcp_tool_call(
            &state,
            loopback_addr(),
            "get_tool_schema",
            &serde_json::json!({ "tool_name": "agent" }),
            None,
        )
        .await;
        assert_eq!(r["name"], "agent");
    }

    #[tokio::test]
    async fn handle_mcp_tool_call_routes_call_tool() {
        let state = test_state();
        let r = handle_mcp_tool_call(
            &state,
            loopback_addr(),
            "call_tool",
            &serde_json::json!({ "tool_name": "session", "arguments": {} }),
            None,
        )
        .await;
        assert!(r["error"].as_str().unwrap().contains("action"));
    }

    #[tokio::test]
    async fn handle_mcp_tool_call_routes_repo() {
        let state = test_state();
        let r = handle_mcp_tool_call(
            &state,
            loopback_addr(),
            "repo",
            &serde_json::json!({ "action": "list" }),
            None,
        )
        .await;
        // repo action=list returns an array of repos (may be empty in test)
        assert!(
            r.is_array(),
            "repo action=list should return array, got: {r}"
        );
    }

    #[tokio::test]
    async fn handle_mcp_tool_call_routes_agent_messaging() {
        let state = test_state();
        // agent action=register without tuic_session should return an error
        let r = handle_mcp_tool_call(
            &state,
            loopback_addr(),
            "agent",
            &serde_json::json!({ "action": "register" }),
            None,
        )
        .await;
        assert!(
            r["error"].is_string(),
            "agent action=register without tuic_session should error"
        );
    }

    #[tokio::test]
    async fn handle_mcp_tool_call_routes_ui_toast() {
        let state = test_state();
        let r = handle_mcp_tool_call(
            &state,
            loopback_addr(),
            "ui",
            &serde_json::json!({ "action": "toast", "title": "test" }),
            None,
        )
        .await;
        assert!(
            !r["error"].is_string(),
            "ui action=toast should succeed, got: {r}"
        );
    }

    /// `sound` is what an unattended agent uses to reach a user who is not
    /// watching, so every accepted form must resolve to a real notification
    /// sound: silence is silence, `true` still means "match the level", and a
    /// name (notably `attention`) overrides it.
    #[test]
    fn toast_sound_resolves_to_a_notification_sound_or_silence() {
        use serde_json::json;
        for (value, level, expected) in [
            (json!(null), "info", None),
            (json!(false), "error", None),
            (json!(true), "info", Some("info")),
            (json!(true), "warn", Some("warning")),
            (json!(true), "error", Some("error")),
            (json!("attention"), "info", Some("attention")),
            (json!("question"), "error", Some("question")),
        ] {
            assert_eq!(
                resolve_toast_sound(&value, level).expect("valid sound"),
                expected.map(str::to_string),
                "sound={value} level={level}"
            );
        }
    }

    /// A typo must not silently produce a silent toast — the agent would believe
    /// it had rung a bell that never rang.
    #[test]
    fn toast_sound_rejects_unknown_names() {
        let err = resolve_toast_sound(&serde_json::json!("buzzer"), "info")
            .expect_err("unknown sound must be rejected");
        let message = err["error"].as_str().expect("error message");
        assert!(
            message.contains("attention"),
            "lists the valid names: {message}"
        );
        assert!(resolve_toast_sound(&serde_json::json!(3), "info").is_err());
    }

    #[tokio::test]
    async fn ui_toast_puts_the_resolved_sound_on_the_bus() {
        let state = test_state();
        let mut rx = state.event_bus.subscribe();
        let r = handle_mcp_tool_call(
            &state,
            loopback_addr(),
            "ui",
            &serde_json::json!({
                "action": "toast",
                "title": "need you",
                "level": "warn",
                "sound": "attention",
            }),
            None,
        )
        .await;
        assert!(!r["error"].is_string(), "toast should succeed, got: {r}");
        match rx.try_recv().expect("McpToast on the bus") {
            crate::state::AppEvent::McpToast { sound, level, .. } => {
                assert_eq!(sound.as_deref(), Some("attention"));
                assert_eq!(level, "warn", "the callback does not change the severity");
            }
            other => panic!("expected McpToast, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn ui_toast_includes_origin_repo_path_from_peer_agent() {
        use crate::state::PeerAgent;
        let state = test_state();
        let mcp_sid = "mcp-toast-origin".to_string();
        let tuic = "00000000-0000-0000-0000-000000000003".to_string();
        state.mcp_to_session.insert(mcp_sid.clone(), tuic.clone());
        state.peer_agents.insert(
            tuic.clone(),
            PeerAgent {
                tuic_session: tuic,
                mcp_session_id: mcp_sid.clone(),
                name: "codex".to_string(),
                project: Some("/Gits/personal/tuicommander".to_string()),
                registered_at: 0,
            },
        );

        let mut rx = state.event_bus.subscribe();
        let result = handle_mcp_tool_call(
            &state,
            loopback_addr(),
            "ui",
            &serde_json::json!({
                "action": "toast",
                "title": "done",
            }),
            Some(&mcp_sid),
        )
        .await;
        assert_eq!(result["ok"], true);

        match rx.try_recv().expect("McpToast on the bus") {
            crate::state::AppEvent::McpToast {
                origin_repo_path, ..
            } => assert_eq!(
                origin_repo_path.as_deref(),
                Some("/Gits/personal/tuicommander")
            ),
            other => panic!("expected McpToast, got {other:?}"),
        }
    }

    /// The repo path alone cannot navigate: several tabs share a repo. Clicking
    /// the toast has to land on the exact terminal that raised it, so the event
    /// carries the caller's TUIC session id too.
    #[tokio::test]
    async fn ui_toast_includes_origin_session_id_from_peer_agent() {
        use crate::state::PeerAgent;
        let state = test_state();
        let mcp_sid = "mcp-toast-origin-session".to_string();
        let tuic = "00000000-0000-0000-0000-000000000004".to_string();
        state.mcp_to_session.insert(mcp_sid.clone(), tuic.clone());
        state.peer_agents.insert(
            tuic.clone(),
            PeerAgent {
                tuic_session: tuic.clone(),
                mcp_session_id: mcp_sid.clone(),
                name: "codex".to_string(),
                project: Some("/Gits/personal/tuicommander".to_string()),
                registered_at: 0,
            },
        );

        let mut rx = state.event_bus.subscribe();
        let result = handle_mcp_tool_call(
            &state,
            loopback_addr(),
            "ui",
            &serde_json::json!({
                "action": "toast",
                "title": "done",
            }),
            Some(&mcp_sid),
        )
        .await;
        assert_eq!(result["ok"], true);

        match rx.try_recv().expect("McpToast on the bus") {
            crate::state::AppEvent::McpToast {
                origin_session_id, ..
            } => assert_eq!(origin_session_id.as_deref(), Some(tuic.as_str())),
            other => panic!("expected McpToast, got {other:?}"),
        }
    }

    /// An unbound caller (no PTY behind the MCP session) must not invent one:
    /// a wrong id would send the click to somebody else's terminal.
    #[tokio::test]
    async fn ui_toast_omits_origin_session_id_for_unbound_caller() {
        let state = test_state();
        let mut rx = state.event_bus.subscribe();
        let result = handle_mcp_tool_call(
            &state,
            loopback_addr(),
            "ui",
            &serde_json::json!({ "action": "toast", "title": "done" }),
            Some("mcp-toast-unbound"),
        )
        .await;
        assert_eq!(result["ok"], true);

        match rx.try_recv().expect("McpToast on the bus") {
            crate::state::AppEvent::McpToast {
                origin_session_id, ..
            } => assert_eq!(origin_session_id, None),
            other => panic!("expected McpToast, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn handle_mcp_tool_call_routes_debug_sessions() {
        let state = test_state();
        let r = handle_mcp_tool_call(
            &state,
            loopback_addr(),
            "debug",
            &serde_json::json!({ "action": "sessions" }),
            None,
        )
        .await;
        assert!(
            r.is_array(),
            "debug action=sessions should return array of sessions"
        );
    }

    #[tokio::test]
    async fn handle_mcp_tool_call_old_names_return_unknown() {
        let state = test_state();
        for old_name in &["github", "worktree", "workspace", "messaging", "notify"] {
            let r = handle_mcp_tool_call(
                &state,
                loopback_addr(),
                old_name,
                &serde_json::json!({ "action": "list" }),
                None,
            )
            .await;
            assert!(
                r["error"].as_str().unwrap_or("").contains("Unknown tool"),
                "old tool name '{old_name}' should return Unknown tool error, got: {r}"
            );
        }
    }

    // ---- build_mcp_instructions collapse mode (story 1081) -------------------

    #[test]
    fn instructions_collapse_off_lists_individual_tools() {
        let state = test_state();
        let out = build_mcp_instructions(&state, None);
        // Tools bullets + concrete workflow references are present.
        assert!(out.contains("## Tools\n"), "expected classic Tools section");
        assert!(
            out.contains("- `session` ("),
            "expected session bullet in tools list"
        );
        assert!(out.contains("## Workflow"), "expected Workflow section");
        assert!(!out.contains("## Tools — Lazy Discovery"));
        assert!(!out.contains("search_tools"));
    }

    #[test]
    fn instructions_scope_ack_to_connection_and_use_agent_session_primitives() {
        let state = test_state();
        let out = build_mcp_instructions(&state, None);
        assert!(out.contains("exactly once per MCP connection or reconnect"));
        assert!(out.contains("Never repeat it on each conversational turn"));
        assert!(out.contains("There is no separate `swarm` action"));
        assert!(!out.contains("Aliases \"swarm\""));
        assert!(out.contains("Lifecycle notifications carry state only"));
        assert!(out.contains("workers must report results with `agent action=send`"));
    }

    #[test]
    fn instructions_collapse_on_describes_search_schema_call_flow() {
        let state = test_state();
        state.config.write().collapse_tools = true;
        let out = build_mcp_instructions(&state, None);

        // Slim section referencing meta-tools (detail lives in tool descriptions).
        assert!(out.contains("## Tools"), "expected tools header");
        assert!(out.contains("`search_tools`"), "must mention search_tools");
        assert!(
            out.contains("`get_tool_schema`"),
            "must mention get_tool_schema"
        );
        assert!(out.contains("`call_tool`"), "must mention call_tool");
        assert!(out.contains("worktree"), "must mention worktree caveat");
        // The concrete tools list and legacy workflow must NOT appear — those
        // reference tool names the model cannot invoke directly in collapse mode.
        assert!(
            !out.contains("- `session` ("),
            "tools list must be suppressed in collapse mode"
        );
        assert!(
            !out.contains("## Workflow"),
            "legacy workflow must be suppressed in collapse mode"
        );
    }

    #[test]
    fn initialize_instructions_pin_the_one_call_submit_rule_in_both_modes() {
        let state = test_state();
        let classic = build_mcp_instructions_for_mode(&state, None, false);
        let collapsed = build_mcp_instructions_for_mode(&state, None, true);

        assert!(classic.contains(
            "**Submit:** `session action=submit session_id=<id> input=<text>` once; never split text/Enter; never poll."
        ));
        assert!(collapsed.contains(
            "**Submit:** `call_tool tool_name=session arguments={action:submit,session_id,input}` once; never split text/Enter; never poll."
        ));
        assert!(!classic.contains("text then"));
        assert!(!collapsed.contains("status after"));
    }

    // ---- Swarm Layer 4: MCP tool descriptions (#1165-b124) -------------------

    #[test]
    fn session_description_includes_status_action() {
        let defs = native_tool_definitions();
        let session = defs
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "session")
            .unwrap();
        let desc = session["description"].as_str().unwrap();
        assert!(
            desc.contains("status:"),
            "session description must document the status action"
        );
        let action_enum = session["inputSchema"]["properties"]["action"]["description"]
            .as_str()
            .unwrap();
        assert!(
            action_enum.contains("status"),
            "session action enum must include status"
        );
    }

    #[test]
    fn session_submit_schema_pins_receipt_and_raw_input_semantics() {
        let defs = native_tool_definitions();
        let session = defs
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "session")
            .unwrap();
        let description = session["description"].as_str().unwrap();
        let properties = &session["inputSchema"]["properties"];

        assert!(
            description.contains("Use one call; never split text and Enter; never poll after it.")
        );
        assert!(description.contains(
            "Acknowledgement means child terminal movement after Enter, not semantic application acceptance."
        ));
        assert!(
            description.contains("composer_state (tracked InputLineBuffer, not application state)")
        );
        assert!(description.contains(
            "Never queues; partial composers, dialogs, busy agents, and older queued commands reject before writing."
        ));
        assert!(description.contains(
            "input: Raw text/key compatibility surface. Send text and/or special_key; ok confirms PTY write only."
        ));
        assert_eq!(
            properties["action"]["description"],
            "One of: list, create, submit, input, output, status, wait, resize, close, kill, pause, resume, process_stats"
        );
        assert_eq!(
            properties["input"]["description"],
            "Non-empty command (action=submit) or raw text (action=input)"
        );
        assert_eq!(
            properties["timeout_ms"]["description"],
            "action=submit: acknowledgement wait, clamped 250-10000ms, default 3000. action=wait: max wait, default 60000; values at or above 300000 run as 295000."
        );
    }

    #[test]
    fn session_description_requires_list_for_global_overview() {
        let defs = native_tool_definitions();
        let session = defs
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "session")
            .unwrap();
        let description = session["description"].as_str().unwrap();
        assert!(description.contains("All active sessions and states in one call"));
        assert!(description.contains("never fan out per-session status calls"));
    }

    #[test]
    fn print_mode_description_clarifies_visible_vs_headless() {
        let defs = native_tool_definitions();
        let agent = defs
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "agent")
            .unwrap();
        let pm_desc = agent["inputSchema"]["properties"]["print_mode"]["description"]
            .as_str()
            .unwrap();
        assert!(
            pm_desc.contains("visible") || pm_desc.contains("TUI tab"),
            "print_mode must mention visible TUI tab"
        );
        assert!(
            pm_desc.contains("headless"),
            "print_mode must mention headless mode"
        );
    }

    #[test]
    fn instructions_include_session_status_for_monitoring() {
        let state = test_state();
        let out = build_mcp_instructions(&state, None);
        assert!(
            out.contains("status"),
            "instructions must mention session status for multi-agent monitoring"
        );
    }

    #[test]
    fn instructions_tools_and_definitions_in_sync_for_session_actions() {
        // build_mcp_instructions session bullet must list the same actions as SESSION_ACTIONS.
        let state = test_state();
        let out = build_mcp_instructions(&state, None);
        for action in SESSION_ACTIONS.split(", ") {
            assert!(
                out.contains(action),
                "instructions must mention session action '{action}'"
            );
        }
    }

    // ---- ToolSearchIndex lifecycle (story 1080) ------------------------------

    /// Fresh AppState constructed outside the tests-only test_state() helper
    /// (which eagerly rebuilds) starts with an empty cached index. This pins
    /// the invariant that the default field value is empty.
    #[test]
    fn tool_search_index_default_is_empty() {
        // Mirror the lib-default construction (no eager rebuild).
        let idx = crate::tool_search::ToolSearchIndex::build(&[]);
        assert!(idx.is_empty());
    }

    /// After `rebuild_tool_search_index`, the cache contains every native
    /// tool from `native_tool_definitions()` (when `ai_terminal_mcp_enabled`).
    #[test]
    fn rebuild_tool_search_index_populates_all_native_tools() {
        let state = test_state();
        // ai_terminal_* tools are gated behind `ai_terminal_mcp_enabled`. Enable
        // the flag and rebuild so the index matches the full native tool set.
        state.config.write().ai_terminal_mcp_enabled = true;
        rebuild_tool_search_index(&state);
        let idx = state.tool_search_index.read();
        let native_count = native_tool_definitions().as_array().unwrap().len();
        assert_eq!(idx.len(), native_count);
        // Spot-check a few well-known native tools by name.
        assert!(idx.get_schema("session").is_some());
        assert!(idx.get_schema("repo").is_some());
        assert!(idx.get_schema("agent").is_some());
    }

    /// After mutating `disabled_native_tools` and rebuilding, the disabled
    /// tool no longer appears in the cached index.
    #[test]
    fn rebuild_tool_search_index_respects_disabled_native_tools() {
        let state = test_state();
        assert!(
            state
                .tool_search_index
                .read()
                .get_schema("session")
                .is_some()
        );
        state.config.write().disabled_native_tools = vec!["session".to_string()];
        rebuild_tool_search_index(&state);
        assert!(
            state
                .tool_search_index
                .read()
                .get_schema("session")
                .is_none()
        );
    }

    /// The background updater task subscribes to `mcp_tools_changed` and
    /// rebuilds the cached index on every signal. This is what wires upstream
    /// add/remove, native-tool toggle, and collapse-tools toggle events into
    /// the cache without each call site having to rebuild manually.
    #[tokio::test]
    async fn tool_search_index_rebuilds_on_broadcast() {
        let state = test_state();

        // Start the updater — it does its own initial rebuild, then loops on the broadcast.
        spawn_tool_search_index_updater(state.clone());
        // Give the initial build a moment to land.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(
            state
                .tool_search_index
                .read()
                .get_schema("session")
                .is_some()
        );

        // Mutate config and fire the signal; the updater must rebuild.
        state.config.write().disabled_native_tools = vec!["session".to_string()];
        let _ = state.mcp_tools_changed.send(());

        // Poll for the rebuild with a short deadline — the task is async.
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        while std::time::Instant::now() < deadline {
            if state
                .tool_search_index
                .read()
                .get_schema("session")
                .is_none()
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("tool_search_index was not rebuilt after mcp_tools_changed signal");
    }

    /// Toggling `collapse_tools` must not corrupt the searchable corpus:
    /// the cache always holds the full tool list regardless of the collapse
    /// state (collapse only affects what the client sees via tools/list).
    #[tokio::test]
    async fn tool_search_index_ignores_collapse_tools_toggle() {
        let state = test_state();
        spawn_tool_search_index_updater(state.clone());
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let before = state.tool_search_index.read().len();

        state.config.write().collapse_tools = true;
        let _ = state.mcp_tools_changed.send(());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let after = state.tool_search_index.read().len();
        assert_eq!(
            before, after,
            "collapse_tools toggle must not change searchable corpus size"
        );
        // And native tools must still be searchable.
        assert!(
            state
                .tool_search_index
                .read()
                .get_schema("session")
                .is_some()
        );
    }

    #[test]
    fn ui_tab_emits_event() {
        let state = test_state();
        let mut rx = state.event_bus.subscribe();

        let result = handle_ui(
            &state,
            &serde_json::json!({
                "action": "tab",
                "id": "test-panel",
                "title": "Test",
                "html": "<p>hello</p>"
            }),
            None,
        );
        assert_eq!(result["ok"], true);
        assert_eq!(result["id"], "test-panel");

        let event = rx.try_recv().expect("Expected UiTab event");
        match event {
            crate::state::AppEvent::UiTab {
                id,
                title,
                html,
                url,
                pinned,
                focus,
                origin_repo_path,
            } => {
                assert_eq!(id, "test-panel");
                assert_eq!(title, "Test");
                assert_eq!(html, "<p>hello</p>");
                assert!(url.is_none(), "url should be None for html tab");
                assert!(!pinned, "pinned should default to false");
                assert!(focus, "focus should default to true");
                assert!(
                    origin_repo_path.is_none(),
                    "origin_repo_path should be None when no mcp_session"
                );
            }
            other => panic!("Expected UiTab, got {:?}", other),
        }
    }

    #[test]
    fn ui_tab_includes_origin_repo_path_from_peer_agent() {
        use crate::state::PeerAgent;
        let state = test_state();
        let mcp_sid = "mcp-xyz".to_string();
        let tuic = "00000000-0000-0000-0000-000000000001".to_string();
        // Register an MCP→tuic mapping and a peer agent with a project path.
        state.mcp_to_session.insert(mcp_sid.clone(), tuic.clone());
        state.peer_agents.insert(
            tuic.clone(),
            PeerAgent {
                tuic_session: tuic.clone(),
                mcp_session_id: mcp_sid.clone(),
                name: "wiz".to_string(),
                project: Some("/Gits/personal/alpha".to_string()),
                registered_at: 0,
            },
        );

        let mut rx = state.event_bus.subscribe();
        let result = handle_ui(
            &state,
            &serde_json::json!({
                "action": "tab",
                "id": "mcf",
                "title": "MCF",
                "html": "<p/>"
            }),
            Some(&mcp_sid),
        );
        assert_eq!(result["ok"], true);

        let event = rx.try_recv().expect("Expected UiTab event");
        match event {
            crate::state::AppEvent::UiTab {
                origin_repo_path, ..
            } => {
                assert_eq!(
                    origin_repo_path.as_deref(),
                    Some("/Gits/personal/alpha"),
                    "caller's repo path must be propagated so the tab lands in the right repo"
                );
            }
            other => panic!("Expected UiTab, got {:?}", other),
        }
    }

    #[test]
    #[ignore = "requires real PTY (openpty) — fails in sandboxed CI; covered by integration tests"]
    fn ui_tab_falls_back_to_pty_cwd_when_no_peer_agent() {
        use crate::state::PtySession;
        use portable_pty::{PtySize, native_pty_system};

        let state = test_state();
        let mcp_sid = "mcp-no-peer".to_string();
        let tuic = "00000000-0000-0000-0000-000000000002".to_string();
        state.mcp_to_session.insert(mcp_sid.clone(), tuic.clone());

        // Spawn a minimal PTY session with cwd set so we can exercise the fallback.
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = portable_pty::CommandBuilder::new("true");
        cmd.cwd("/tmp");
        let child = pair.slave.spawn_command(cmd).expect("spawn");
        let writer = pair.master.take_writer().expect("writer");
        state.sessions.insert(
            tuic.clone(),
            parking_lot::Mutex::new(PtySession {
                writer: Arc::new(parking_lot::Mutex::new(writer)),
                master: pair.master,
                _child: child,
                paused: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                worktree: None,
                cwd: Some("/Gits/personal/beta".to_string()),
                display_name: None,
                display_name_is_custom: false,
                is_remote: false,
                shell: "true".to_string(),
            }),
        );

        let mut rx = state.event_bus.subscribe();
        handle_ui(
            &state,
            &serde_json::json!({
                "action": "tab",
                "id": "beta-tab",
                "title": "Beta",
                "html": "<p/>"
            }),
            Some(&mcp_sid),
        );

        let event = rx.try_recv().expect("Expected UiTab event");
        match event {
            crate::state::AppEvent::UiTab {
                origin_repo_path, ..
            } => {
                assert_eq!(origin_repo_path.as_deref(), Some("/Gits/personal/beta"));
            }
            other => panic!("Expected UiTab, got {:?}", other),
        }
    }

    #[test]
    fn ui_tab_falls_back_to_mcp_session_repo_path() {
        let state = test_state();
        let mcp_sid = "mcp-no-peer-no-pty".to_string();
        state.mcp_sessions.insert(
            mcp_sid.clone(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code: true,
                requires_meta_tools: false,
                has_sse_stream: false,
                sse_generation: 0,
                repo_path: Some("/Gits/personal/gamma".to_string()),
            },
        );

        let mut rx = state.event_bus.subscribe();
        let result = handle_ui(
            &state,
            &serde_json::json!({
                "action": "tab",
                "id": "gamma-tab",
                "title": "Gamma",
                "html": "<p/>"
            }),
            Some(&mcp_sid),
        );
        assert_eq!(result["ok"], true);

        let event = rx.try_recv().expect("Expected UiTab event");
        match event {
            crate::state::AppEvent::UiTab {
                origin_repo_path, ..
            } => {
                assert_eq!(
                    origin_repo_path.as_deref(),
                    Some("/Gits/personal/gamma"),
                    "should fall back to mcp_sessions repo_path when no peer agent or PTY session"
                );
            }
            other => panic!("Expected UiTab, got {:?}", other),
        }
    }

    #[test]
    fn ui_tab_requires_fields() {
        let state = test_state();
        let r = handle_ui(&state, &serde_json::json!({"action": "tab"}), None);
        assert!(r["error"].as_str().unwrap().contains("'id'"));

        let r = handle_ui(
            &state,
            &serde_json::json!({"action": "tab", "id": "x"}),
            None,
        );
        assert!(r["error"].as_str().unwrap().contains("'title'"));

        // Requires either html or url — url is accepted as alternative to html
        let r = handle_ui(
            &state,
            &serde_json::json!({"action": "tab", "id": "x", "title": "t"}),
            None,
        );
        assert!(r["error"].as_str().unwrap().contains("'html' or 'url'"));

        // url alone is accepted
        let r = handle_ui(
            &state,
            &serde_json::json!({"action": "tab", "id": "x", "title": "t", "url": "http://localhost/"}),
            None,
        );
        assert_eq!(r["ok"], true);

        // Both html and url is rejected
        let r = handle_ui(
            &state,
            &serde_json::json!({"action": "tab", "id": "x", "title": "t", "html": "<p/>", "url": "http://localhost/"}),
            None,
        );
        assert!(r["error"].as_str().unwrap().contains("not both"));
    }

    #[test]
    fn ui_tab_focus_false() {
        let state = test_state();
        let mut rx = state.event_bus.subscribe();

        handle_ui(
            &state,
            &serde_json::json!({
                "action": "tab",
                "id": "bg",
                "title": "Background",
                "html": "<p/>",
                "focus": false
            }),
            None,
        );

        let event = rx.try_recv().expect("Expected UiTab event");
        match event {
            crate::state::AppEvent::UiTab { focus, .. } => {
                assert!(!focus, "focus=false should be respected");
            }
            other => panic!("Expected UiTab, got {:?}", other),
        }
    }

    #[test]
    fn ui_tab_pinned_false() {
        let state = test_state();
        let mut rx = state.event_bus.subscribe();

        handle_ui(
            &state,
            &serde_json::json!({
                "action": "tab",
                "id": "unpinned",
                "title": "T",
                "html": "<p/>",
                "pinned": false
            }),
            None,
        );

        let event = rx.try_recv().expect("Expected UiTab event");
        match event {
            crate::state::AppEvent::UiTab { pinned, .. } => {
                assert!(!pinned);
            }
            other => panic!("Expected UiTab, got {:?}", other),
        }
    }

    // -------- HTML tab lifecycle tests (story 1176-b88b) --------

    #[test]
    fn ui_tab_warns_when_session_already_has_terminal() {
        use crate::state::VtLogBuffer;
        let state = test_state();
        // Simulate an active session by inserting into vt_log_buffers
        state.vt_log_buffers.insert(
            "sess-active".to_string(),
            parking_lot::Mutex::new(VtLogBuffer::new(24, 220, 500)),
        );

        // Calling ui(tab) with session_id = active session should warn, not create tab
        let r = handle_ui(
            &state,
            &serde_json::json!({
                "action": "tab",
                "id": "status-tab",
                "title": "Status",
                "html": "<p>status</p>",
                "session_id": "sess-active"
            }),
            None,
        );
        assert!(
            r.get("warning").and_then(|v| v.as_str()).is_some(),
            "should return warning when session_id has an active terminal"
        );
        assert_eq!(
            r["ok"],
            serde_json::json!(false),
            "should not create tab when session already has terminal"
        );
    }

    #[test]
    fn ui_tab_no_warning_without_session_id() {
        let state = test_state();
        // No session_id → normal tab creation, no warning
        let r = handle_ui(
            &state,
            &serde_json::json!({
                "action": "tab",
                "id": "standalone-tab",
                "title": "My Tab",
                "html": "<p>hello</p>"
            }),
            None,
        );
        assert_eq!(r["ok"], serde_json::json!(true));
        assert!(r.get("warning").is_none());
    }

    #[test]
    fn ui_tab_no_warning_for_unknown_session_id() {
        let state = test_state();
        // session_id refers to a session that doesn't exist → no warning, tab created normally
        let r = handle_ui(
            &state,
            &serde_json::json!({
                "action": "tab",
                "id": "status-tab",
                "title": "Status",
                "html": "<p>hi</p>",
                "session_id": "nonexistent-session"
            }),
            None,
        );
        assert_eq!(
            r["ok"],
            serde_json::json!(true),
            "nonexistent session_id should not block tab creation"
        );
    }

    #[test]
    fn ui_tab_registers_creator_and_clears_on_session_close() {
        use crate::state::VtLogBuffer;
        let state = test_state();
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440b02",
            "orchestrator",
            "mcp-orch",
        );
        // Map mcp_session_id → tuic_session
        state.mcp_to_session.insert(
            "mcp-orch".to_string(),
            "550e8400-e29b-41d4-a716-446655440b02".to_string(),
        );

        // Create HTML tab as orchestrator
        let r = handle_ui(
            &state,
            &serde_json::json!({
                "action": "tab",
                "id": "orch-status",
                "title": "Orchestrator",
                "html": "<p>running</p>"
            }),
            Some("mcp-orch"),
        );
        assert_eq!(r["ok"], serde_json::json!(true));

        // session_html_tabs should have the tab registered under the creator's session
        let tabs = state
            .session_html_tabs
            .get("550e8400-e29b-41d4-a716-446655440b02");
        assert!(
            tabs.is_some(),
            "tab should be registered under creator session"
        );
        assert!(tabs.unwrap().contains(&"orch-status".to_string()));

        // Insert vt_log_buffers so close succeeds
        state.vt_log_buffers.insert(
            "550e8400-e29b-41d4-a716-446655440b02".to_string(),
            parking_lot::Mutex::new(VtLogBuffer::new(24, 220, 500)),
        );
        // Close the session — should clear its html tabs
        handle_session(
            &state,
            &serde_json::json!({"action": "close", "session_id": "550e8400-e29b-41d4-a716-446655440b02"}),
            None,
        );

        assert!(
            state
                .session_html_tabs
                .get("550e8400-e29b-41d4-a716-446655440b02")
                .is_none(),
            "session_html_tabs should be cleared after session close"
        );
    }

    /// Characterization for SIMP-1: when a session has registered HTML tabs and is
    /// closed via the MCP `session(close)` action, the entry MUST be drained from
    /// `session_html_tabs` (the same shared helper is used by `session(kill)`).
    #[test]
    fn session_close_drains_session_html_tabs_entry() {
        let target = "550e8400-e29b-41d4-a716-446655440d01";
        let state = test_state();
        state
            .session_html_tabs
            .insert(target.to_string(), vec!["html-tab-1".to_string()]);

        use crate::state::VtLogBuffer;
        state.vt_log_buffers.insert(
            target.to_string(),
            parking_lot::Mutex::new(VtLogBuffer::new(24, 220, 500)),
        );
        handle_session(
            &state,
            &serde_json::json!({"action": "close", "session_id": target}),
            None,
        );
        assert!(
            state.session_html_tabs.get(target).is_none(),
            "html tabs entry must be removed after close (drives SIMP-1 helper)"
        );
    }

    // -------- Tombstone / post-mortem output regression tests --------

    /// Simulate a process-exited session (tombstone) by inserting buffers and
    /// an exit code without a `sessions` entry. The `output` action must serve
    /// the last output with `exited: true` and the captured `exit_code` — NOT
    /// return "Session not found".
    #[test]
    fn tombstoned_session_output_returns_last_buffer_and_exit_code() {
        use crate::OutputRingBuffer;
        use crate::state::VtLogBuffer;
        use std::sync::atomic::AtomicU64;

        let state = test_state();
        let sid = "tombstone-test-1".to_string();

        // Pre-populate buffers with sample output.
        let mut ring = OutputRingBuffer::new(4096);
        ring.write(b"hello from the crypt\n");
        state
            .output_buffers
            .insert(sid.clone(), parking_lot::Mutex::new(ring));

        let mut vt = VtLogBuffer::new(24, 80, 100);
        vt.process(b"hello from the crypt\r\n");
        state
            .vt_log_buffers
            .insert(sid.clone(), parking_lot::Mutex::new(vt));

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        state
            .last_output_ms
            .insert(sid.clone(), AtomicU64::new(now_ms));
        state.exit_codes.insert(sid.clone(), 42);

        // Sanity: session entry is absent (this IS the tombstone).
        assert!(!state.sessions.contains_key(&sid));

        // Raw format path.
        let raw_res = handle_session(
            &state,
            &serde_json::json!({"action": "output", "session_id": sid, "format": "raw"}),
            None,
        );
        assert!(
            raw_res.get("error").is_none(),
            "Unexpected error: {raw_res}"
        );
        assert_eq!(raw_res["exited"], serde_json::json!(true));
        assert_eq!(raw_res["exit_code"], serde_json::json!(42));
        assert!(
            raw_res["data"]
                .as_str()
                .unwrap()
                .contains("hello from the crypt"),
            "Expected tombstoned output in raw response: {raw_res}"
        );

        // Default (VT-clean) format path.
        let clean_res = handle_session(
            &state,
            &serde_json::json!({"action": "output", "session_id": sid}),
            None,
        );
        assert!(
            clean_res.get("error").is_none(),
            "Unexpected error: {clean_res}"
        );
        assert_eq!(clean_res["exited"], serde_json::json!(true));
        assert_eq!(clean_res["exit_code"], serde_json::json!(42));
        assert!(
            clean_res["data"]
                .as_str()
                .unwrap()
                .contains("hello from the crypt"),
            "Expected tombstoned output in clean response: {clean_res}"
        );
    }

    #[test]
    fn session_output_omits_unknown_exit_code() {
        use crate::OutputRingBuffer;

        let state = test_state();
        let sid = "tombstone-without-exit-code";
        let mut ring = OutputRingBuffer::new(4096);
        ring.write(b"final output\n");
        state
            .output_buffers
            .insert(sid.to_string(), parking_lot::Mutex::new(ring));

        let response = handle_session(
            &state,
            &serde_json::json!({"action": "output", "session_id": sid, "format": "raw"}),
            None,
        );

        assert_eq!(response["exited"], true);
        assert!(
            response.get("exit_code").is_none(),
            "unknown optional exit_code must be omitted: {response}"
        );
    }

    /// A timeout response must not carry a redundant `hint`. This used to force
    /// the timeout with a nonexistent session id — that path now returns an error
    /// instead of blocking, so the timeout is forced with a real busy session,
    /// which is what a timeout actually means.
    #[cfg(unix)]
    #[tokio::test]
    async fn session_wait_timeout_has_no_redundant_hint() {
        use std::sync::atomic::AtomicU8;
        let state = test_state();
        insert_managed_test_session(&state, "busy-session", "/tmp");
        state.shell_states.insert(
            "busy-session".to_string(),
            AtomicU8::new(crate::pty::SHELL_BUSY),
        );
        let response = handle_session_wait(
            &state,
            &serde_json::json!({
                "action": "wait",
                "session_id": "busy-session",
                "timeout_ms": 1,
            }),
        )
        .await;

        assert_eq!(response["met"], false);
        assert_eq!(response["timed_out"], true);
        assert!(response.get("hint").is_none());
    }

    /// `session output` response includes `cursor` field (== total VtLog lines)
    /// and `total_written` remains present for backwards compat.
    #[test]
    fn session_output_includes_cursor_field() {
        use crate::OutputRingBuffer;
        use crate::state::VtLogBuffer;
        use std::sync::atomic::AtomicU64;

        let state = test_state();
        let sid = "cursor-field-test".to_string();

        let mut ring = OutputRingBuffer::new(4096);
        ring.write(b"line one\n");
        state
            .output_buffers
            .insert(sid.clone(), parking_lot::Mutex::new(ring));

        let mut vt = VtLogBuffer::new(24, 80, 200);
        // Feed >24 lines so some scroll into log (total_pushed > 0).
        for i in 0..30 {
            vt.process(format!("line {i}\r\n").as_bytes());
        }
        state
            .vt_log_buffers
            .insert(sid.clone(), parking_lot::Mutex::new(vt));

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        state
            .last_output_ms
            .insert(sid.clone(), AtomicU64::new(now_ms));
        state.exit_codes.insert(sid.clone(), 0);

        let res = handle_session(
            &state,
            &serde_json::json!({"action": "output", "session_id": sid}),
            None,
        );
        assert!(res.get("error").is_none(), "Unexpected error: {res}");
        assert!(res.get("cursor").is_some(), "cursor field missing: {res}");
        assert!(
            res.get("total_written").is_some(),
            "total_written missing (backwards compat): {res}"
        );
        let cursor = res["cursor"].as_u64().expect("cursor must be u64");
        assert!(cursor > 0, "cursor should be > 0 after scrollback: {res}");
        assert_eq!(
            res["cursor"], res["total_written"],
            "cursor and total_written must match"
        );
    }

    /// `since_cursor` returns only new lines since the given position.
    #[test]
    fn session_output_since_cursor_returns_delta() {
        use crate::OutputRingBuffer;
        use crate::state::VtLogBuffer;
        use std::sync::atomic::AtomicU64;

        let state = test_state();
        let sid = "since-cursor-test".to_string();

        state.output_buffers.insert(
            sid.clone(),
            parking_lot::Mutex::new(OutputRingBuffer::new(4096)),
        );

        let mut vt = VtLogBuffer::new(24, 80, 200);
        // Feed >24 lines so total_pushed > 0.
        for i in 0..30 {
            vt.process(format!("old line {i}\r\n").as_bytes());
        }
        let cursor_after_old = vt.total_lines();
        assert!(cursor_after_old > 0, "scrollback must have lines");

        // Feed >24 new lines so they overflow the viewport into scrollback.
        for i in 0..30 {
            vt.process(format!("new line {i}\r\n").as_bytes());
        }
        state
            .vt_log_buffers
            .insert(sid.clone(), parking_lot::Mutex::new(vt));

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        state
            .last_output_ms
            .insert(sid.clone(), AtomicU64::new(now_ms));
        state.exit_codes.insert(sid.clone(), 0);

        let res = handle_session(
            &state,
            &serde_json::json!({"action": "output", "session_id": sid, "since_cursor": cursor_after_old}),
            None,
        );
        assert!(res.get("error").is_none(), "Unexpected error: {res}");
        let data = res["data"].as_str().expect("data field");
        // Delta includes lines scrolled in since cursor — includes new lines.
        assert!(
            data.contains("new line"),
            "expected new lines in delta: {res}"
        );
        let new_cursor = res["cursor"].as_u64().expect("cursor must be u64");
        assert!(
            new_cursor > cursor_after_old as u64,
            "cursor must advance: {res}"
        );
    }

    /// A session with no trace (never existed or fully reaped) must return a
    /// structured error with `reason: session_not_found_or_reaped` — not the
    /// bare "Session not found" the pre-fix code returned.
    #[test]
    fn unknown_session_id_returns_structured_error() {
        let state = test_state();

        let res = handle_session(
            &state,
            &serde_json::json!({"action": "output", "session_id": "does-not-exist-at-all"}),
            None,
        );

        assert_eq!(
            res["error"].as_str(),
            Some("Session not found"),
            "Should surface error: {res}"
        );
        assert_eq!(
            res["reason"].as_str(),
            Some("session_not_found_or_reaped"),
            "Unknown session should report session_not_found_or_reaped: {res}"
        );
    }

    /// After `mark_session_exited`, output buffers + last_output_ms + exit_codes
    /// must survive, while transient per-session state must be reaped.
    #[test]
    fn mark_session_exited_preserves_tombstone_state() {
        use crate::OutputRingBuffer;
        use crate::state::VtLogBuffer;
        use std::sync::atomic::{AtomicU8, AtomicU64};

        let state = test_state();
        let sid = "mark-exited-test".to_string();

        // Insert buffers + transient state as if a session had been running.
        state.output_buffers.insert(
            sid.clone(),
            parking_lot::Mutex::new(OutputRingBuffer::new(1024)),
        );
        state.vt_log_buffers.insert(
            sid.clone(),
            parking_lot::Mutex::new(VtLogBuffer::new(24, 80, 100)),
        );
        state.last_output_ms.insert(sid.clone(), AtomicU64::new(0));
        state
            .shell_states
            .insert(sid.clone(), AtomicU8::new(crate::pty::SHELL_BUSY));
        state
            .terminal_rows
            .insert(sid.clone(), std::sync::atomic::AtomicU16::new(24));

        // No `sessions` entry — emulate the reader-thread path where the
        // session has already been removed by the caller before mark.
        crate::pty::mark_session_exited(&sid, &state);

        // Tombstone survivors.
        assert!(
            state.output_buffers.contains_key(&sid),
            "output buffer must survive"
        );
        assert!(
            state.vt_log_buffers.contains_key(&sid),
            "vt log must survive"
        );
        assert!(
            state.last_output_ms.contains_key(&sid),
            "last_output_ms must survive"
        );
        // Transient state must be reaped.
        assert!(
            !state.shell_states.contains_key(&sid),
            "shell_states reaped"
        );
        assert!(
            !state.terminal_rows.contains_key(&sid),
            "terminal_rows reaped"
        );
    }

    // --- build_spawn_prompt ---

    #[test]
    fn build_spawn_prompt_no_parent_returns_original() {
        let result = build_spawn_prompt("do the task", None, "child-123", "worker");
        assert_eq!(result, "do the task");
    }

    #[test]
    fn build_spawn_prompt_with_parent_prepends_preamble() {
        let result = build_spawn_prompt("do the task", Some("parent-456"), "child-123", "worker");
        assert!(
            result.contains("parent-456"),
            "preamble must mention parent"
        );
        assert!(
            result.contains("do the task"),
            "original prompt must be preserved"
        );
        let preamble_end = result.find("do the task").unwrap();
        assert!(preamble_end > 0, "preamble must precede prompt");
        assert!(
            result.contains("register"),
            "preamble must include the reconnect registration fallback"
        );
        assert!(result.contains("pre-registered as peer `worker`"));
    }

    #[test]
    fn build_spawn_prompt_with_parent_includes_send_instruction() {
        let result = build_spawn_prompt("my task", Some("orch-789"), "child-abc", "worker");
        assert!(
            result.contains("orch-789"),
            "preamble must include parent session for send target"
        );
        assert!(
            result.contains("send"),
            "preamble must instruct send on completion"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn absent_spawn_cwd_uses_unbound_managed_header_and_rejects_bound_mismatch() {
        let state = test_state();
        insert_managed_test_session(&state, TEST_UUID_A, "/tmp");
        insert_managed_test_session(&state, TEST_UUID_B, "/");

        let unbound_hint =
            managed_parent_cwd_from_header(&state, Some("mcp-unbound"), Some(TEST_UUID_A));
        assert!(state.mcp_to_session.get("mcp-unbound").is_none());
        assert_eq!(
            resolve_effective_spawn_cwd(
                &state,
                None,
                unbound_hint.as_deref(),
                None,
                Some("mcp-unbound"),
            )
            .as_deref(),
            Some("/tmp"),
            "an unbound managed bridge may use its asserted PTY cwd"
        );

        let mut events = state.event_bus.subscribe();
        let spawned = handle_mcp_tool_call_with_context(
            &state,
            "127.0.0.1:0".parse().unwrap(),
            "agent",
            &serde_json::json!({
                "action": "spawn",
                "name": "cwd-regression-child",
                "prompt": "verify cwd",
                "binary_path": "/usr/bin/true",
            }),
            Some("mcp-unbound"),
            unbound_hint.as_deref(),
        )
        .await;
        assert!(spawned.get("error").is_none(), "spawn failed: {spawned}");
        let created = events.try_recv().expect("spawn must emit session-created");
        match created {
            crate::state::AppEvent::SessionCreated { cwd, .. } => {
                assert_eq!(cwd.as_deref(), Some("/tmp"));
            }
            other => panic!("expected session-created, got {other:?}"),
        }

        state
            .mcp_to_session
            .insert("mcp-bound".to_string(), TEST_UUID_A.to_string());
        let mismatched_hint =
            managed_parent_cwd_from_header(&state, Some("mcp-bound"), Some(TEST_UUID_B));
        assert_eq!(
            mismatched_hint, None,
            "a bound caller rejects a spoofed header"
        );
        assert_eq!(
            resolve_effective_spawn_cwd(
                &state,
                None,
                mismatched_hint.as_deref(),
                Some(TEST_UUID_A),
                Some("mcp-bound"),
            )
            .as_deref(),
            Some("/tmp"),
            "the verified caller binding remains authoritative"
        );
        assert!(
            state.mcp_to_session.get("mcp-unbound").is_none(),
            "cwd fallback must not repair the missing identity binding"
        );
    }

    // --- ui(action=confirm): answerable from any client, not just the desktop ---

    /// Wait for `handle_confirm` to publish its request, and return the id.
    ///
    /// The handler registers the pending entry before it awaits, so polling the
    /// registry is enough — no need to reach into the event bus for the id.
    async fn await_pending_confirm(state: &Arc<AppState>) -> String {
        for _ in 0..200 {
            if let Some(entry) = state.confirm_responses.iter().next() {
                return entry.key().clone();
            }
            tokio::task::yield_now().await;
        }
        panic!("confirm request was never registered");
    }

    #[tokio::test]
    async fn confirm_returns_the_answer_a_client_gave() {
        let state = test_state();
        let addr = "127.0.0.1:0".parse().unwrap();

        let answering = state.clone();
        tokio::spawn(async move {
            let id = await_pending_confirm(&answering).await;
            crate::mcp_http::resolve_mcp_confirm(&answering, &id, true);
        });

        let result = handle_confirm(
            &state,
            addr,
            &serde_json::json!({"title": "Delete branch?", "message": "git branch -D wip"}),
            None,
        )
        .await;

        assert_eq!(result["confirmed"], true);
        assert!(
            result.get("reason").is_none(),
            "a real answer must not be reported as a timeout"
        );
    }

    #[tokio::test]
    async fn confirm_reaches_every_client_over_the_event_bus() {
        let state = test_state();
        let addr = "127.0.0.1:0".parse().unwrap();
        // Subscribing before the call is what a remote SSE client does; without
        // this bus hop a phone would never learn an agent is waiting on it.
        let mut rx = state.event_bus.subscribe();

        let answering = state.clone();
        tokio::spawn(async move {
            let id = await_pending_confirm(&answering).await;
            crate::mcp_http::resolve_mcp_confirm(&answering, &id, false);
        });

        let _ = handle_confirm(
            &state,
            addr,
            &serde_json::json!({"title": "Force push?", "message": "to main"}),
            None,
        )
        .await;

        let mut saw_request = None;
        let mut saw_resolution = false;
        while let Ok(event) = rx.try_recv() {
            match event {
                crate::state::AppEvent::McpConfirm {
                    request_id,
                    title,
                    message,
                    ..
                } => {
                    assert_eq!(title, "Force push?");
                    assert_eq!(message, "to main");
                    saw_request = Some(request_id);
                }
                crate::state::AppEvent::McpConfirmResolved {
                    request_id,
                    confirmed,
                } => {
                    assert_eq!(Some(&request_id), saw_request.as_ref());
                    assert!(!confirmed);
                    saw_resolution = true;
                }
                _ => {}
            }
        }
        assert!(saw_request.is_some(), "no request reached the bus");
        assert!(
            saw_resolution,
            "clients that did not answer are never told to dismiss the dialog"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn confirm_gives_up_when_nobody_answers() {
        let state = test_state();
        let addr = "127.0.0.1:0".parse().unwrap();

        let result = handle_confirm(
            &state,
            addr,
            &serde_json::json!({"title": "Drop the table?"}),
            None,
        )
        .await;

        // Silence is not consent: a destructive op nobody approved must read as
        // refused, and say why so the caller can tell it from a real "no".
        assert_eq!(result["confirmed"], false);
        assert!(
            result["reason"]
                .as_str()
                .is_some_and(|r| r.contains("no answer")),
            "timeout must be distinguishable from a refusal: {result}"
        );
        assert!(
            state.confirm_responses.is_empty(),
            "an expired request must not leak its registry entry"
        );
    }

    #[tokio::test]
    async fn answering_a_confirm_twice_resolves_it_once() {
        let state = test_state();
        let addr = "127.0.0.1:0".parse().unwrap();
        let mut rx = state.event_bus.subscribe();

        let answering = state.clone();
        tokio::spawn(async move {
            let id = await_pending_confirm(&answering).await;
            // Every client races to answer the same request. The loser must be a
            // no-op, not an error and not a second resolution.
            crate::mcp_http::resolve_mcp_confirm(&answering, &id, true);
            crate::mcp_http::resolve_mcp_confirm(&answering, &id, false);
        });

        let result = handle_confirm(
            &state,
            addr,
            &serde_json::json!({"title": "Proceed?"}),
            None,
        )
        .await;

        assert_eq!(result["confirmed"], true);
        let resolutions = std::iter::from_fn(|| rx.try_recv().ok())
            .filter(|e| matches!(e, crate::state::AppEvent::McpConfirmResolved { .. }))
            .count();
        assert_eq!(resolutions, 1, "the losing answer must not re-broadcast");
    }

    #[tokio::test]
    async fn confirm_refuses_a_non_loopback_caller() {
        let state = test_state();
        let addr = "192.168.1.50:9876".parse().unwrap();

        let result = handle_confirm(
            &state,
            addr,
            &serde_json::json!({"title": "Proceed?"}),
            None,
        )
        .await;

        assert!(
            result["error"]
                .as_str()
                .is_some_and(|e| e.contains("localhost"))
        );
        assert!(state.confirm_responses.is_empty());
    }

    #[tokio::test]
    async fn confirm_requires_a_title() {
        let state = test_state();
        let addr = "127.0.0.1:0".parse().unwrap();

        let result = handle_confirm(
            &state,
            addr,
            &serde_json::json!({"message": "no title"}),
            None,
        )
        .await;

        assert!(
            result["error"]
                .as_str()
                .is_some_and(|e| e.contains("title"))
        );
    }

    // --- spawn auto-registration + inbox pre-init ---

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_auto_registers_child_in_peer_list() {
        let state = test_state();
        let addr = "127.0.0.1:0".parse().unwrap();
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440b01",
            "orchestrator",
            "mcp-orch",
        );

        let result = handle_agent(
            &state,
            addr,
            &serde_json::json!({
                "action": "spawn",
                "prompt": "hello",
                "binary_path": LONG_LIVED_TEST_BINARY,
                "cwd": "/tmp",
            }),
            Some("mcp-orch"),
        );
        // Skip if PTY cannot be opened (sandbox/CI without /dev/ptmx access)
        if result
            .get("error")
            .and_then(|e| e.as_str())
            .is_some_and(|e| e.contains("Failed to open PTY"))
        {
            eprintln!("Skipping: PTY not available in this environment");
            return;
        }
        assert!(result.get("error").is_none(), "spawn failed: {result}");
        let session_id = result["session_id"].as_str().unwrap();

        let peers = handle_messaging(
            &state,
            &serde_json::json!({"action": "list_peers"}),
            Some("mcp-orch"),
        );
        let sessions: Vec<&str> = peers["peers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["tuic_session"].as_str().unwrap())
            .collect();
        assert!(
            sessions.contains(&session_id),
            "child {session_id} not in list_peers: {sessions:?}"
        );

        handle_session(
            &state,
            &serde_json::json!({"action": "kill", "session_id": session_id}),
            None,
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_name_is_applied_to_peer_session_and_response() {
        let state = test_state();
        let addr = "127.0.0.1:0".parse().unwrap();
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440b01",
            "orchestrator",
            "mcp-orch",
        );
        let mut events = state.event_bus.subscribe();

        let result = handle_agent(
            &state,
            addr,
            &serde_json::json!({
                "action": "spawn",
                "name": "linux-primary",
                "prompt": "hello",
                "binary_path": LONG_LIVED_TEST_BINARY,
                "cwd": "/tmp",
            }),
            Some("mcp-orch"),
        );
        if result
            .get("error")
            .and_then(|e| e.as_str())
            .is_some_and(|e| e.contains("Failed to open PTY"))
        {
            eprintln!("Skipping: PTY not available in this environment");
            return;
        }

        assert!(result.get("error").is_none(), "spawn failed: {result}");
        assert_eq!(result["name"], "linux-primary");
        let session_id = result["session_id"].as_str().unwrap();
        let created = events
            .try_recv()
            .expect("named spawn must emit session-created");
        match created {
            crate::state::AppEvent::SessionCreated {
                session_id: event_session_id,
                display_name,
                ..
            } => {
                assert_eq!(event_session_id, session_id);
                assert_eq!(display_name.as_deref(), Some("linux-primary"));
            }
            other => panic!("expected session-created, got {other:?}"),
        }
        assert_eq!(result["peer_registered"], true);
        assert_eq!(result["communication_ready"], true);
        assert_eq!(result["send_to"], session_id);
        assert_eq!(
            result["parent_session_id"],
            "550e8400-e29b-41d4-a716-446655440b01"
        );
        assert_eq!(
            state.peer_agents.get(session_id).unwrap().name,
            "linux-primary"
        );
        assert_eq!(
            state
                .sessions
                .get(session_id)
                .unwrap()
                .lock()
                .display_name
                .as_deref(),
            Some("linux-primary")
        );

        let listed = handle_session(&state, &serde_json::json!({"action": "list"}), None);
        let listed_session = listed
            .as_array()
            .and_then(|sessions| {
                sessions
                    .iter()
                    .find(|session| session["session_id"] == session_id)
            })
            .expect("named spawned session must appear in session action=list");
        assert_eq!(listed_session["display_name"], "linux-primary");
        assert_eq!(listed_session["is_caller"], false);
        assert!(
            listed_session["alias"].as_str().is_some(),
            "independent short alias must remain available"
        );
        assert_ne!(listed_session["alias"], listed_session["display_name"]);

        apply_initialize_identity(&state, "child-mcp", Some(session_id));
        assert_eq!(
            state.peer_agents.get(session_id).unwrap().name,
            "linux-primary",
            "child auto-bind must preserve the parent-assigned name"
        );
        let caller_list = handle_session(
            &state,
            &serde_json::json!({"action": "list"}),
            Some("child-mcp"),
        );
        let caller = caller_list
            .as_array()
            .unwrap()
            .iter()
            .find(|session| session["session_id"] == session_id)
            .unwrap();
        assert_eq!(
            caller["is_caller"], true,
            "the caller's managed PTY must be explicit so it is never self-closed"
        );

        handle_session(
            &state,
            &serde_json::json!({"action": "kill", "session_id": session_id}),
            None,
        );
    }

    #[test]
    fn spawn_rejects_empty_name_before_opening_pty() {
        let state = test_state();
        let result = handle_agent(
            &state,
            "127.0.0.1:0".parse().unwrap(),
            &serde_json::json!({
                "action": "spawn",
                "name": "   ",
                "prompt": "hello",
                "binary_path": "/usr/bin/true",
            }),
            None,
        );

        assert_eq!(
            result["error"],
            "Action 'spawn' requires 'name' to be a non-empty string when provided"
        );
        assert!(state.sessions.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_pre_initializes_child_inbox() {
        let state = test_state();
        let addr = "127.0.0.1:0".parse().unwrap();
        register_peer(
            &state,
            "550e8400-e29b-41d4-a716-446655440b01",
            "orchestrator",
            "mcp-orch",
        );

        let result = handle_agent(
            &state,
            addr,
            &serde_json::json!({
                "action": "spawn",
                "prompt": "hello",
                "binary_path": LONG_LIVED_TEST_BINARY,
                "cwd": "/tmp",
            }),
            Some("mcp-orch"),
        );
        // Skip if PTY cannot be opened (sandbox/CI without /dev/ptmx access)
        if result
            .get("error")
            .and_then(|e| e.as_str())
            .is_some_and(|e| e.contains("Failed to open PTY"))
        {
            eprintln!("Skipping: PTY not available in this environment");
            return;
        }
        assert!(result.get("error").is_none(), "spawn failed: {result}");
        let session_id = result["session_id"].as_str().unwrap();

        assert!(
            state.agent_inbox.contains_key(session_id),
            "child inbox must be pre-initialized after spawn"
        );

        handle_session(
            &state,
            &serde_json::json!({"action": "kill", "session_id": session_id}),
            None,
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_without_multi_agent_preamble_for_unregistered_caller_succeeds() {
        let state = test_state();
        let addr = "127.0.0.1:0".parse().unwrap();
        let result = handle_agent(
            &state,
            addr,
            &serde_json::json!({
                "action": "spawn",
                "prompt": "hello",
                "binary_path": "/usr/bin/true",
                "cwd": "/tmp",
            }),
            Some("mcp-anon"),
        );
        // Skip if PTY cannot be opened (sandbox/CI without /dev/ptmx access)
        if result
            .get("error")
            .and_then(|e| e.as_str())
            .is_some_and(|e| e.contains("Failed to open PTY"))
        {
            eprintln!("Skipping: PTY not available in this environment");
            return;
        }
        assert!(
            result.get("error").is_none(),
            "unregistered caller spawn must succeed: {result}"
        );
        assert!(result["session_id"].as_str().is_some());
        assert!(
            result.get("parent_session_id").is_none(),
            "unregistered spawn must omit the absent parent"
        );
    }

    // ---- Layer 2: session(status) enrichment + spawn response (#1163-7599) ----

    #[test]
    fn session_status_unknown_session_returns_structured_error() {
        let state = test_state();
        let result = handle_session(
            &state,
            &serde_json::json!({"action": "status", "session_id": "nonexistent"}),
            None,
        );
        let err = result["error"].as_str().unwrap_or("");
        assert!(
            err.contains("not found"),
            "expected 'not found' error, got: {result}"
        );
    }

    #[test]
    fn session_status_omits_absent_optional_fields() {
        let state = test_state();
        let session_id = "status-compact";
        state.session_states.insert(
            session_id.to_string(),
            crate::state::SessionState::default(),
        );

        let response = handle_session(
            &state,
            &serde_json::json!({"action": "status", "session_id": session_id}),
            None,
        );
        let object = response.as_object().unwrap();
        for absent in [
            "shell_state",
            "agent_state",
            "agent_type",
            "exit_code",
            "idle_since_ms",
            "busy_duration_ms",
        ] {
            assert!(!object.contains_key(absent), "{absent} must be omitted");
        }
        assert!(object.contains_key("background_work"));
        assert!(object.contains_key("awaiting_input"));
    }

    #[test]
    fn session_status_includes_exit_code_when_exited() {
        let state = test_state();
        let sid = "s-exit-test";
        state
            .session_states
            .insert(sid.to_string(), crate::state::SessionState::default());
        state.shell_states.insert(
            sid.to_string(),
            std::sync::atomic::AtomicU8::new(crate::pty::SHELL_IDLE),
        );
        state.exit_codes.insert(sid.to_string(), 42);

        let result = handle_session(
            &state,
            &serde_json::json!({"action": "status", "session_id": sid}),
            None,
        );
        assert!(result.get("error").is_none(), "unexpected error: {result}");
        assert_eq!(
            result["exit_code"],
            serde_json::json!(42),
            "exit_code missing: {result}"
        );
    }

    #[test]
    fn session_status_includes_idle_since_ms_when_idle() {
        let state = test_state();
        let sid = "s-idle-test";
        state
            .session_states
            .insert(sid.to_string(), crate::state::SessionState::default());
        state.shell_states.insert(
            sid.to_string(),
            std::sync::atomic::AtomicU8::new(crate::pty::SHELL_IDLE),
        );
        let since = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
            - 500;
        state
            .shell_state_since_ms
            .insert(sid.to_string(), std::sync::atomic::AtomicU64::new(since));

        let result = handle_session(
            &state,
            &serde_json::json!({"action": "status", "session_id": sid}),
            None,
        );
        assert!(result.get("error").is_none(), "unexpected error: {result}");
        let idle_ms = result["idle_since_ms"].as_u64();
        assert!(
            idle_ms.is_some(),
            "idle_since_ms must be present when idle: {result}"
        );
        assert!(
            idle_ms.unwrap() >= 400,
            "idle_since_ms must reflect elapsed time: {result}"
        );
        assert!(
            result["busy_duration_ms"].is_null(),
            "busy_duration_ms must be absent when idle: {result}"
        );
    }

    #[test]
    fn session_status_includes_busy_duration_ms_when_busy() {
        let state = test_state();
        let sid = "s-busy-test";
        state
            .session_states
            .insert(sid.to_string(), crate::state::SessionState::default());
        state.shell_states.insert(
            sid.to_string(),
            std::sync::atomic::AtomicU8::new(crate::pty::SHELL_BUSY),
        );
        let since = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
            - 300;
        state
            .shell_state_since_ms
            .insert(sid.to_string(), std::sync::atomic::AtomicU64::new(since));

        let result = handle_session(
            &state,
            &serde_json::json!({"action": "status", "session_id": sid}),
            None,
        );
        assert!(result.get("error").is_none(), "unexpected error: {result}");
        let busy_ms = result["busy_duration_ms"].as_u64();
        assert!(
            busy_ms.is_some(),
            "busy_duration_ms must be present when busy: {result}"
        );
        assert!(
            busy_ms.unwrap() >= 200,
            "busy_duration_ms must reflect elapsed time: {result}"
        );
        assert!(
            result["idle_since_ms"].is_null(),
            "idle_since_ms must be absent when busy: {result}"
        );
    }

    #[test]
    fn session_list_includes_shell_state_per_entry() {
        let state = test_state();
        // Without real PTY sessions we can't test list output (sessions DashMap requires live PTY).
        // This test verifies the field would appear if a session entry exists.
        // Integration coverage via manual QA — list with running session must show shell_state.
        // Here we just verify the status handler path we control returns shell_state.
        let sid = "s-list-test";
        state
            .session_states
            .insert(sid.to_string(), crate::state::SessionState::default());
        state.shell_states.insert(
            sid.to_string(),
            std::sync::atomic::AtomicU8::new(crate::pty::SHELL_IDLE),
        );

        let result = handle_session(
            &state,
            &serde_json::json!({"action": "status", "session_id": sid}),
            None,
        );
        assert!(
            result["shell_state"].as_str().is_some(),
            "shell_state must be in status response: {result}"
        );
    }

    #[test]
    fn session_status_distinguishes_declared_completion_from_idle() {
        let state = test_state();
        let sid = "s-completed-test";
        state.session_states.insert(
            sid.to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                suggested_actions: Some(vec!["Review result".to_string()]),
                ..Default::default()
            },
        );
        state.shell_states.insert(
            sid.to_string(),
            std::sync::atomic::AtomicU8::new(crate::pty::SHELL_IDLE),
        );

        let result = handle_session(
            &state,
            &serde_json::json!({"action": "status", "session_id": sid}),
            None,
        );

        assert_eq!(result["shell_state"], "idle");
        assert_eq!(
            result["agent_state"], "completed",
            "an explicit suggest marker is task completion, not generic idle: {result}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_response_includes_enrichment_fields() {
        let state = test_state();
        let addr = "127.0.0.1:0".parse().unwrap();
        let result = handle_agent(
            &state,
            addr,
            &serde_json::json!({
                "action": "spawn",
                "prompt": "hello",
                "binary_path": LONG_LIVED_TEST_BINARY,
                "cwd": "/tmp",
            }),
            Some("mcp-orch"),
        );

        if result.get("error").is_some() {
            eprintln!("Skipping: PTY not available in this environment");
            return;
        }

        assert!(
            result["session_id"].as_str().is_some(),
            "session_id missing: {result}"
        );
        assert!(
            result["server_ts"].as_u64().is_some(),
            "server_ts missing: {result}"
        );
        assert!(
            result["monitor_with"].as_str().is_some(),
            "monitor_with missing: {result}"
        );
        assert!(
            result["status_with"].as_str().is_some(),
            "status_with missing: {result}"
        );
        // The compatibility monitor_with field remains session(output), but is
        // explicitly anomaly-only. A standalone spawn has no peer inbox hint.
        let monitor = result["monitor_with"].as_str().unwrap();
        assert!(
            monitor.starts_with("session(action=output"),
            "standalone compatibility monitor must remain session(output): {monitor}"
        );
        assert!(monitor.contains("anomaly fallback"));
        assert!(
            result.get("peer_monitor_with").is_none(),
            "standalone spawn must not include peer_monitor_with: {result}"
        );
        assert_eq!(result["peer_registered"], true);
        assert_eq!(result["communication_ready"], false);
        assert!(result["communication_warning"].as_str().is_some());

        let session_id = result["session_id"].as_str().unwrap();
        assert!(
            state.peer_agents.contains_key(session_id),
            "every managed child must be registered even when the caller has no peer identity"
        );
        assert!(
            state.agent_inbox.contains_key(session_id),
            "every managed child must have an inbox immediately after spawn"
        );

        handle_session(
            &state,
            &serde_json::json!({"action": "kill", "session_id": session_id}),
            None,
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn parent_registration_after_spawn_links_existing_child() {
        let state = test_state();
        let addr = "127.0.0.1:0".parse().unwrap();
        let parent_mcp = "mcp-late-parent";

        let spawned = handle_agent(
            &state,
            addr,
            &serde_json::json!({
                "action": "spawn",
                "prompt": "hello",
                "binary_path": LONG_LIVED_TEST_BINARY,
                "cwd": "/tmp",
            }),
            Some(parent_mcp),
        );
        if spawned.get("error").is_some() {
            eprintln!("Skipping: PTY not available in this environment");
            return;
        }
        let child = spawned["session_id"].as_str().unwrap();
        assert_eq!(spawned["communication_ready"], false);
        let pending_parent = pending_parent_id(parent_mcp);
        state.push_agent_inbox(
            &pending_parent,
            crate::state::AgentMessage {
                id: "tuic-auto-before-parent-registration".to_string(),
                from_tuic_session: child.to_string(),
                from_name: "tuic".to_string(),
                content: r#"{"type":"state_change","state":"idle"}"#.to_string(),
                timestamp: 1,
                delivered_via_channel: false,
            },
        );

        state.mcp_sessions.insert(
            parent_mcp.to_string(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code: false,
                requires_meta_tools: false,
                has_sse_stream: false,
                sse_generation: 0,
                repo_path: None,
            },
        );
        let registered = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register",
                "name": "orchestrator",
            }),
            Some(parent_mcp),
        );

        assert_eq!(registered["ok"], true, "registration failed: {registered}");
        assert_eq!(registered["identity_generated"], true);
        let parent_tuic = registered["tuic_session"].as_str().unwrap();
        assert!(is_valid_uuid(parent_tuic));
        assert_eq!(registered["linked_children"], 1);
        assert_eq!(
            state
                .session_parent
                .get(child)
                .map(|entry| entry.value().clone()),
            Some(parent_tuic.to_string()),
            "late parent registration must restore child lifecycle/message routing"
        );
        assert_eq!(
            state
                .agent_inbox
                .get(parent_tuic)
                .map(|messages| messages.len()),
            Some(1),
            "lifecycle mail emitted before parent registration must be preserved"
        );

        let ready_child = handle_agent(
            &state,
            addr,
            &serde_json::json!({
                "action": "spawn",
                "prompt": "report with agent send",
                "binary_path": LONG_LIVED_TEST_BINARY,
                "cwd": "/tmp",
            }),
            Some(parent_mcp),
        );
        assert!(
            ready_child.get("error").is_none(),
            "registered external parent spawn failed: {ready_child}"
        );
        assert_eq!(ready_child["communication_ready"], true);
        assert_eq!(ready_child["parent_session_id"], parent_tuic);
        let ready_child_id = ready_child["session_id"].as_str().unwrap();
        assert!(state.agent_inbox.contains_key(ready_child_id));

        for session_id in [child, ready_child_id] {
            handle_session(
                &state,
                &serde_json::json!({"action": "kill", "session_id": session_id}),
                None,
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_response_adds_peer_monitor_hint_when_caller_registered() {
        // The compatibility monitor_with field remains session(output), while
        // peer_monitor_with is the normal inbox path for a registered caller.
        let state = test_state();
        let addr = "127.0.0.1:0".parse().unwrap();
        let tuic = "550e8400-e29b-41d4-a716-446655440aa2";
        let mcp = "mcp-arch1-orch";
        register_peer(&state, tuic, "orchestrator", mcp);

        let result = handle_agent(
            &state,
            addr,
            &serde_json::json!({
                "action": "spawn",
                "prompt": "hello",
                "binary_path": "/usr/bin/true",
                "cwd": "/tmp",
            }),
            Some(mcp),
        );
        if result.get("error").is_some() {
            eprintln!("Skipping: PTY not available in this environment");
            return;
        }
        let monitor = result["monitor_with"]
            .as_str()
            .expect("monitor_with required");
        assert!(
            monitor.starts_with("session(action=output"),
            "compatibility monitor_with must remain session(output): {monitor}"
        );
        assert!(monitor.contains("anomaly fallback"));
        let peer_hint = result["peer_monitor_with"]
            .as_str()
            .expect("peer_monitor_with must be present for registered caller");
        assert!(
            peer_hint.starts_with("agent(action=inbox"),
            "peer_monitor_with must point at agent(inbox): {peer_hint}"
        );
    }

    // ── is_valid_uuid ────────────────────────────────────────────────────────

    #[test]
    fn is_valid_uuid_accepts_well_formed_uuid() {
        assert!(is_valid_uuid("550e8400-e29b-41d4-a716-446655440000"));
        assert!(is_valid_uuid("00000000-0000-0000-0000-000000000000"));
    }

    #[test]
    fn is_valid_uuid_rejects_injection_payloads() {
        assert!(!is_valid_uuid("injected\n## header"));
        assert!(!is_valid_uuid("short"));
        assert!(!is_valid_uuid(""));
        assert!(!is_valid_uuid("550e8400-e29b-41d4-a716-44665544000g")); // non-hex char
        assert!(!is_valid_uuid("550e8400e29b41d4a716446655440000")); // no dashes
    }

    // ── session(kill) self-kill guard ────────────────────────────────────────

    #[test]
    fn session_kill_rejects_own_session() {
        let state = test_state();
        let mcp_sid = "mcp-kill-guard-test";
        let tuic_sid = "550e8400-e29b-41d4-a716-446655440001";
        state
            .mcp_to_session
            .insert(mcp_sid.to_string(), tuic_sid.to_string());

        let result = handle_session(
            &state,
            &serde_json::json!({"action": "kill", "session_id": tuic_sid}),
            Some(mcp_sid),
        );
        assert!(
            result["error"].as_str().is_some(),
            "kill own session must return error: {result}"
        );
        assert!(
            result["error"]
                .as_str()
                .unwrap()
                .contains("Cannot kill own session"),
            "error message must mention 'Cannot kill own session': {result}"
        );
    }

    #[test]
    fn session_close_rejects_own_session() {
        // Mirror of the kill guard for `close`. With Story 074 auto-identity the
        // caller is in mcp_to_session even without an explicit register, so this
        // guard now fires for the common orchestrator-closes-itself mistake.
        let state = test_state();
        let mcp_sid = "mcp-close-guard-test";
        let tuic_sid = "550e8400-e29b-41d4-a716-446655440009";
        state
            .mcp_to_session
            .insert(mcp_sid.to_string(), tuic_sid.to_string());

        let result = handle_session(
            &state,
            &serde_json::json!({"action": "close", "session_id": tuic_sid}),
            Some(mcp_sid),
        );
        assert!(
            result["error"]
                .as_str()
                .map(|e| e.contains("Cannot close own session"))
                .unwrap_or(false),
            "close own session must be rejected with a hint: {result}"
        );
    }

    #[test]
    fn session_kill_allows_other_session() {
        let state = test_state();
        let mcp_sid = "mcp-kill-other-test";
        let own_tuic = "550e8400-e29b-41d4-a716-446655440002";
        let other_tuic = "550e8400-e29b-41d4-a716-446655440003";
        state
            .mcp_to_session
            .insert(mcp_sid.to_string(), own_tuic.to_string());

        // Killing a different session — should NOT be blocked by self-kill guard.
        // It will return "Session not found" (no real PTY), not the self-kill error.
        let result = handle_session(
            &state,
            &serde_json::json!({"action": "kill", "session_id": other_tuic}),
            Some(mcp_sid),
        );
        let err = result["error"].as_str().unwrap_or("");
        assert!(
            !err.contains("Cannot kill own session"),
            "self-kill guard must NOT block killing other sessions: {result}"
        );
    }

    // ── agent(register) UUID validation ─────────────────────────────────────

    #[test]
    fn agent_register_rejects_non_uuid_tuic_session() {
        let state = test_state();
        let result = handle_messaging(
            &state,
            &serde_json::json!({"action": "register", "tuic_session": "not-a-uuid"}),
            Some("mcp-reg-test"),
        );
        assert!(
            result["error"].as_str().is_some_and(|e| e.contains("UUID")),
            "register with non-UUID tuic_session must fail: {result}"
        );
    }

    #[test]
    fn agent_register_accepts_valid_uuid() {
        let state = test_state();
        let result = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register",
                "tuic_session": "550e8400-e29b-41d4-a716-446655440004"
            }),
            Some("mcp-reg-valid-test"),
        );
        assert!(
            result["ok"].as_bool() == Some(true),
            "register with valid UUID must succeed: {result}"
        );
    }

    // ── agent(send) + agent(inbox) caller resolution (RUST-3/PERF-2 — must use mcp_to_session O(1)) ──

    #[test]
    fn agent_send_succeeds_for_registered_peer() {
        let state = test_state();
        let sender_mcp = "mcp-send-sender";
        let sender_tuic = "550e8400-e29b-41d4-a716-446655440010";
        let recipient_mcp = "mcp-send-recipient";
        let recipient_tuic = "550e8400-e29b-41d4-a716-446655440011";
        register_peer(&state, sender_tuic, "alice", sender_mcp);
        register_peer(&state, recipient_tuic, "bob", recipient_mcp);

        let result = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send",
                "to": recipient_tuic,
                "message": "hello bob",
            }),
            Some(sender_mcp),
        );
        assert_eq!(
            result["ok"].as_bool(),
            Some(true),
            "send must succeed: {result}"
        );
        assert_eq!(result["accepted"], true);
        assert_eq!(result["buffered_in_inbox"], true);
        assert_eq!(result["delivery_path"], "inbox_only");
        assert!(
            result.get("recipient_state").is_none(),
            "generated/external peers have no PTY state"
        );
        let inbox = state
            .agent_inbox
            .get(recipient_tuic)
            .expect("recipient inbox exists");
        assert_eq!(inbox.len(), 1, "recipient should have 1 buffered message");
        assert_eq!(inbox[0].from_tuic_session, sender_tuic);
        assert_eq!(inbox[0].from_name, "alice");
    }

    /// A peer with no terminal must be told so at registration. Silence here is
    /// what let an agent launched outside a TUIC PTY believe it was addressable:
    /// it registered, mail arrived, and nothing ever surfaced it.
    #[test]
    fn register_reports_no_terminal_for_a_peer_without_a_pty() {
        let state = test_state();
        let result = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "register",
                "tuic_session": "550e8400-e29b-41d4-a716-4466554400a1",
                "name": "orphan",
            }),
            Some("mcp-orphan"),
        );
        assert_eq!(result["ok"], true);
        assert_eq!(
            result["terminal"], false,
            "an identity with no live PTY must report terminal=false: {result}"
        );
        let identity = result["identity"].as_str().unwrap_or_default();
        assert!(
            identity.contains("NO terminal"),
            "the identity note must state the consequence, got: {identity}"
        );
        assert!(
            identity.contains("agent action=wait") || identity.contains("agent action=inbox"),
            "it must name the way out (consume your own inbox), got: {identity}"
        );
    }

    /// `send` to a terminal-less peer is accepted but NOT delivered: the sender must
    /// be able to tell "it will act on this" from "it will never see this".
    #[test]
    fn send_to_a_peer_without_a_terminal_reports_not_delivered() {
        let state = test_state();
        let sender_mcp = "mcp-undeliverable-sender";
        let sender_tuic = "550e8400-e29b-41d4-a716-4466554400b0";
        let recipient_mcp = "mcp-undeliverable-recipient";
        let recipient_tuic = "550e8400-e29b-41d4-a716-4466554400b1";
        register_peer(&state, sender_tuic, "alice", sender_mcp);
        register_peer(&state, recipient_tuic, "phantom", recipient_mcp);

        let result = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send",
                "to": recipient_tuic,
                "message": "did you finish?",
            }),
            Some(sender_mcp),
        );
        // The mail is stored — that part did succeed.
        assert_eq!(result["ok"], true);
        assert_eq!(result["accepted"], true);
        assert_eq!(result["buffered_in_inbox"], true);
        assert_eq!(result["delivery_path"], "inbox_only");
        // …but nothing will surface it.
        assert_eq!(
            result["delivered"], false,
            "inbox_only must not be reported as delivered: {result}"
        );
        assert_eq!(result["recipient_has_terminal"], false);
        let warning = result["warning"].as_str().unwrap_or_default();
        assert!(
            warning.contains("NO terminal"),
            "the warning must say the recipient cannot be woken, got: {warning}"
        );
    }

    /// The counterpart: a waiter consumed the message, so `delivered` is true and no
    /// warning is attached. Guards against flagging healthy deliveries.
    #[tokio::test]
    async fn send_claimed_by_a_waiter_reports_delivered_without_warning() {
        let state = test_state();
        let sender_mcp = "mcp-waiter-sender";
        let sender_tuic = "550e8400-e29b-41d4-a716-4466554400c0";
        let recipient_mcp = "mcp-waiter-recipient";
        let recipient_tuic = "550e8400-e29b-41d4-a716-4466554400c1";
        register_peer(&state, sender_tuic, "alice", sender_mcp);
        register_peer(&state, recipient_tuic, "root", recipient_mcp);

        let waiting_state = Arc::clone(&state);
        let recipient = recipient_tuic.to_string();
        let waiter = tokio::spawn(async move {
            handle_agent_wait(
                &waiting_state,
                &serde_json::json!({"action": "wait", "timeout_ms": 5_000}),
                Some("mcp-waiter-recipient"),
            )
            .await
            .get("met")
            .cloned()
            .unwrap_or(serde_json::Value::Null)
            .as_bool()
            .unwrap_or(false)
                && !recipient.is_empty()
        });
        // Let the wait register its lease before sending.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let result = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send",
                "to": recipient_tuic,
                "message": "here is the result",
            }),
            Some(sender_mcp),
        );
        assert_eq!(result["delivery_path"], "waiter_and_inbox");
        assert_eq!(
            result["delivered"], true,
            "a waiter-owned message is delivered: {result}"
        );
        assert!(
            result.get("warning").is_none(),
            "a healthy delivery must carry no warning: {result}"
        );
        assert!(waiter.await.expect("waiter task"), "the wait must wake");
    }

    #[tokio::test]
    async fn external_peer_wait_observes_message_sent_before_wait() {
        let state = test_state();
        let sender_mcp = "mcp-prewait-sender";
        let sender_tuic = "550e8400-e29b-41d4-a716-446655440020";
        let recipient_mcp = "mcp-prewait-recipient";
        let recipient_tuic = "550e8400-e29b-41d4-a716-446655440021";
        register_peer(&state, sender_tuic, "alice", sender_mcp);
        register_peer(&state, recipient_tuic, "root", recipient_mcp);

        let sent = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send",
                "to": recipient_tuic,
                "message": "completed",
            }),
            Some(sender_mcp),
        );
        assert_eq!(sent["delivery_path"], "inbox_only");
        assert_eq!(
            state.agent_delivery_owner(recipient_tuic, sent["message_id"].as_str().unwrap()),
            None
        );

        let received = handle_agent_wait(
            &state,
            &serde_json::json!({"action": "wait", "since": 0, "timeout_ms": 1}),
            Some(recipient_mcp),
        )
        .await;
        assert_eq!(received["met"], true);
        assert_eq!(received["new_messages"], 1);
        assert_eq!(received["messages"][0]["content"], "completed");
    }

    #[tokio::test]
    async fn agent_send_includes_managed_recipient_shell_and_agent_state_only() {
        let state = test_state();
        #[cfg(unix)]
        let stable_shell = "/bin/cat";
        #[cfg(windows)]
        let stable_shell = "cmd.exe";
        let created = handle_session(
            &state,
            &serde_json::json!({"action": "create", "shell": stable_shell}),
            None,
        );
        if created.get("error").is_some() {
            eprintln!("Skipping: PTY not available in this environment");
            return;
        }
        let recipient = created["session_id"].as_str().unwrap();
        state.session_states.insert(
            recipient.to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                awaiting_input: true,
                ..Default::default()
            },
        );
        state.shell_states.insert(
            recipient.to_string(),
            std::sync::atomic::AtomicU8::new(crate::pty::SHELL_BUSY),
        );
        register_peer(&state, TEST_UUID_A, "sender", "mcp-managed-sender");
        register_peer(&state, recipient, "recipient", "mcp-managed-recipient");

        let response = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send",
                "to": recipient,
                "message": "state summary",
            }),
            Some("mcp-managed-sender"),
        );

        let recipient_state = response["recipient_state"].as_object().unwrap();
        assert_eq!(recipient_state.len(), 2);
        assert!(recipient_state["shell_state"].as_str().is_some());
        assert_eq!(recipient_state["agent_state"], "awaiting_input");

        let _ = handle_session(
            &state,
            &serde_json::json!({"action": "kill", "session_id": recipient}),
            None,
        );
    }

    #[test]
    fn agent_send_rejects_unregistered_caller() {
        let state = test_state();
        let recipient_tuic = "550e8400-e29b-41d4-a716-446655440012";
        register_peer(&state, recipient_tuic, "bob", "mcp-recipient-only");

        let result = handle_messaging(
            &state,
            &serde_json::json!({
                "action": "send",
                "to": recipient_tuic,
                "message": "ghost message",
            }),
            Some("mcp-not-registered"),
        );
        assert!(
            result["error"]
                .as_str()
                .is_some_and(|e| e.contains("not registered")),
            "send from unregistered MCP session must error: {result}"
        );
    }

    #[test]
    fn agent_inbox_returns_messages_for_registered_caller() {
        let state = test_state();
        let mcp_sid = "mcp-inbox-self";
        let tuic = "550e8400-e29b-41d4-a716-446655440013";
        register_peer(&state, tuic, "self", mcp_sid);

        // Send a message to self so the inbox has one entry.
        let send_result = handle_messaging(
            &state,
            &serde_json::json!({"action": "send", "to": tuic, "message": "note to self"}),
            Some(mcp_sid),
        );
        assert_eq!(
            send_result["ok"].as_bool(),
            Some(true),
            "send-to-self must succeed: {send_result}"
        );

        let result = handle_messaging(
            &state,
            &serde_json::json!({"action": "inbox"}),
            Some(mcp_sid),
        );
        let messages = result["messages"]
            .as_array()
            .expect("inbox returns messages array");
        assert_eq!(
            messages.len(),
            1,
            "inbox should contain 1 message: {result}"
        );
        assert_eq!(messages[0]["content"].as_str(), Some("note to self"));
    }

    // -----------------------------------------------------------------------
    // resolve_run_config tests
    // -----------------------------------------------------------------------

    fn make_agents_config() -> crate::config::AgentsConfig {
        use crate::config::{AgentRunConfig, AgentSettings, AgentsConfig};
        let mut agents = std::collections::HashMap::new();
        agents.insert(
            "claude".to_string(),
            AgentSettings {
                run_configs: vec![
                    AgentRunConfig {
                        name: "claude qwen3.5".to_string(),
                        command: "ollama".to_string(),
                        args: vec![
                            "launch".to_string(),
                            "claude".to_string(),
                            "--model".to_string(),
                            "qwen3.5".to_string(),
                        ],
                        env: [("OLLAMA_HOST".to_string(), "localhost:11434".to_string())]
                            .into_iter()
                            .collect(),
                        is_default: false,
                    },
                    AgentRunConfig {
                        name: "Default".to_string(),
                        command: "claude".to_string(),
                        args: vec![],
                        env: std::collections::HashMap::new(),
                        is_default: true,
                    },
                ],
                ..Default::default()
            },
        );
        agents.insert(
            "codex".to_string(),
            AgentSettings {
                run_configs: vec![AgentRunConfig {
                    name: "codex-fast".to_string(),
                    command: "codex".to_string(),
                    args: vec!["--fast".to_string()],
                    env: std::collections::HashMap::new(),
                    is_default: true,
                }],
                ..Default::default()
            },
        );
        AgentsConfig {
            agents,
            headless_agent: None,
        }
    }

    #[test]
    fn resolve_run_config_matches_by_name_case_insensitive() {
        let cfg = make_agents_config();
        let resolved = resolve_run_config("Claude Qwen3.5", &cfg);
        assert_eq!(resolved.agent_type, "claude");
        assert_eq!(resolved.command.as_deref(), Some("ollama"));
        assert!(
            resolved
                .args
                .as_ref()
                .unwrap()
                .contains(&"qwen3.5".to_string())
        );
        assert_eq!(
            resolved.env.get("OLLAMA_HOST").map(|s| s.as_str()),
            Some("localhost:11434")
        );
    }

    #[test]
    fn resolve_run_config_falls_back_to_agent_type() {
        let cfg = make_agents_config();
        let resolved = resolve_run_config("gemini", &cfg);
        assert_eq!(resolved.agent_type, "gemini");
        assert!(resolved.command.is_none());
        assert!(resolved.args.is_none());
        assert!(resolved.env.is_empty());
    }

    #[test]
    fn resolve_run_config_cross_agent_match() {
        let cfg = make_agents_config();
        let resolved = resolve_run_config("codex-fast", &cfg);
        assert_eq!(resolved.agent_type, "codex");
        assert_eq!(resolved.command.as_deref(), Some("codex"));
    }

    // -----------------------------------------------------------------------
    // substitute_prompt_in_args tests
    // -----------------------------------------------------------------------

    #[test]
    fn substitute_prompt_placeholder_present() {
        let args = vec![
            "-p".to_string(),
            "{prompt}".to_string(),
            "--no-input".to_string(),
        ];
        let result = substitute_prompt_in_args(&args, "fix the bug");
        assert_eq!(result, vec!["-p", "fix the bug", "--no-input"]);
    }

    #[test]
    fn substitute_prompt_placeholder_absent_appends() {
        let args = vec!["--fast".to_string()];
        let result = substitute_prompt_in_args(&args, "fix the bug");
        assert_eq!(result, vec!["--fast", "fix the bug"]);
    }

    #[test]
    fn substitute_prompt_multiple_placeholders() {
        let args = vec![
            "{prompt}".to_string(),
            "--echo".to_string(),
            "{prompt}".to_string(),
        ];
        let result = substitute_prompt_in_args(&args, "hello");
        assert_eq!(result, vec!["hello", "--echo", "hello"]);
    }

    // -----------------------------------------------------------------------
    // finalize_spawn_args tests (story 091 — prefill-only TUIs)
    // -----------------------------------------------------------------------

    #[test]
    fn finalize_codex_withholds_prompt_from_argv() {
        // codex's positional prompt only prefills its TUI (never submits):
        // the placeholder must be dropped and the task deferred for injection.
        let merged = vec!["{prompt}".to_string()];
        let (argv, deferred) = finalize_spawn_args("codex", &merged, "say pong");
        assert!(argv.is_empty(), "codex argv must not carry the task");
        assert_eq!(deferred.as_deref(), Some("say pong"));
    }

    #[test]
    fn finalize_codex_keeps_flags_drops_prompt() {
        let merged = vec![
            "{prompt}".to_string(),
            "--model".to_string(),
            "o4".to_string(),
        ];
        let (argv, deferred) = finalize_spawn_args("codex", &merged, "task");
        assert_eq!(argv, vec!["--model", "o4"]);
        assert_eq!(deferred.as_deref(), Some("task"));
    }

    #[test]
    fn finalize_codex_defers_even_without_placeholder() {
        // Run-config args with no {prompt}: substitute would APPEND the prompt,
        // which for codex still only prefills — defer it instead.
        let merged = vec!["--fast".to_string()];
        let (argv, deferred) = finalize_spawn_args("codex", &merged, "task");
        assert_eq!(argv, vec!["--fast"]);
        assert_eq!(deferred.as_deref(), Some("task"));
    }

    #[test]
    fn explicit_codex_flags_keep_flags_and_defer_prompt() {
        let explicit = vec!["--dangerously-bypass-approvals-and-sandbox".to_string()];
        let (argv, deferred) = finalize_explicit_spawn_args("codex", &explicit, "perform the task");

        assert_eq!(argv, explicit);
        assert_eq!(deferred.as_deref(), Some("perform the task"));
    }

    #[test]
    fn codex_spawn_composition_preserves_model_with_explicit_args() {
        let explicit = vec!["--dangerously-bypass-approvals-and-sandbox".to_string()];
        let (argv, deferred) = compose_mcp_spawn_args(McpSpawnArgs {
            agent_type: "codex",
            binary_path: "/usr/local/bin/codex",
            args: &explicit,
            prompt: "perform the task",
            model: Some("gpt-5.6-terra"),
            print_mode: false,
            output_format: None,
            default_template: false,
        })
        .unwrap();

        assert_eq!(
            argv,
            vec![
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                "gpt-5.6-terra"
            ]
        );
        assert_eq!(deferred.as_deref(), Some("perform the task"));
    }

    #[test]
    fn direct_codex_explicit_args_without_agent_type_use_codex_semantics() {
        let explicit = vec!["--search".to_string()];
        let agent_type = resolve_spawn_agent_type("/usr/local/bin/codex", None).unwrap();
        let (argv, deferred) = compose_mcp_spawn_args(McpSpawnArgs {
            agent_type: &agent_type,
            binary_path: "/usr/local/bin/codex",
            args: &explicit,
            prompt: "perform the task",
            model: None,
            print_mode: false,
            output_format: None,
            default_template: false,
        })
        .unwrap();

        assert_eq!(
            argv,
            vec!["--dangerously-bypass-approvals-and-sandbox", "--search"]
        );
        assert_eq!(deferred.as_deref(), Some("perform the task"));
    }

    #[test]
    fn direct_codex_binary_path_without_args_defers_prompt() {
        let agent_type = resolve_spawn_agent_type("/usr/local/bin/codex", None).unwrap();
        let template = crate::agent::default_prompt_args("codex").unwrap();
        let (argv, deferred) = compose_mcp_spawn_args(McpSpawnArgs {
            agent_type: &agent_type,
            binary_path: "/usr/local/bin/codex",
            args: &template,
            prompt: "perform the task",
            model: Some("gpt-5.6-luna"),
            print_mode: false,
            output_format: None,
            default_template: true,
        })
        .unwrap();

        assert_eq!(
            argv,
            vec![
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                "gpt-5.6-luna"
            ]
        );
        assert_eq!(deferred.as_deref(), Some("perform the task"));
    }

    #[test]
    fn explicit_codex_placeholder_remains_authoritative() {
        let explicit = vec!["exec".to_string(), "{prompt}".to_string()];
        let (argv, deferred) = finalize_explicit_spawn_args("codex", &explicit, "perform the task");

        assert_eq!(argv, vec!["exec", "perform the task"]);
        assert!(deferred.is_none());
    }

    #[test]
    fn explicit_non_prefill_flags_append_prompt() {
        let explicit = vec!["--verbose".to_string()];
        let (argv, deferred) =
            finalize_explicit_spawn_args("claude", &explicit, "perform the task");

        assert_eq!(argv, vec!["--verbose", "perform the task"]);
        assert!(deferred.is_none());
    }

    #[test]
    fn explicit_claude_placeholder_remains_authoritative() {
        let explicit = vec![
            "--model".to_string(),
            "opus".to_string(),
            "{prompt}".to_string(),
        ];
        let (argv, deferred) =
            finalize_explicit_spawn_args("claude", &explicit, "perform the task");

        assert_eq!(argv, vec!["--model", "opus", "perform the task"]);
        assert!(deferred.is_none());
    }

    #[test]
    fn finalize_other_agents_substitute_as_before() {
        let merged = vec!["session".to_string(), "{prompt}".to_string()];
        let (argv, deferred) = finalize_spawn_args("goose", &merged, "do it");
        assert_eq!(argv, vec!["session", "do it"]);
        assert!(deferred.is_none(), "non-prefill agents keep argv delivery");
    }

    #[test]
    fn agent_enter_uses_command_injection_but_other_inputs_stay_raw() {
        assert!(uses_agent_command_injection(Some("codex"), Some("\r")));
        assert!(uses_agent_command_injection(Some("opencode"), Some("\r")));
        assert!(!uses_agent_command_injection(Some("claude"), Some("\r")));
        assert!(!uses_agent_command_injection(None, Some("\r")));
        assert!(!uses_agent_command_injection(Some("codex"), Some("\t")));
        assert!(!uses_agent_command_injection(Some("codex"), None));
    }

    #[test]
    fn claude_template_argv_byte_identical_to_retired_branch() {
        // Story 092: claude folded into the default_prompt_args table. The row +
        // merge's claude flags-first rule must reproduce the retired dedicated
        // spawn branch's argv EXACTLY (element-for-element) for representative
        // spawns: prompt only; prompt+model; prompt+print_mode+output_format.
        let old_branch = |prompt: &str,
                          model: Option<&str>,
                          print_mode: bool,
                          output_format: Option<&str>|
         -> Vec<String> {
            // Verbatim ordering of the retired branch:
            // --print, --output-format F, --model M, <prompt>.
            let mut argv: Vec<String> = Vec::new();
            if print_mode {
                argv.push("--print".to_string());
            }
            if let Some(f) = output_format {
                argv.push("--output-format".to_string());
                argv.push(f.to_string());
            }
            if let Some(m) = model {
                argv.push("--model".to_string());
                argv.push(m.to_string());
            }
            argv.push(prompt.to_string());
            argv
        };
        let new_path = |prompt: &str,
                        model: Option<&str>,
                        print_mode: bool,
                        output_format: Option<&str>|
         -> Vec<String> {
            let template = crate::agent::default_prompt_args("claude").expect("claude row");
            let merged = merge_mcp_params_into_args(
                "claude",
                &template,
                model,
                print_mode,
                output_format,
                true,
            )
            .expect("no conflicts");
            let (argv, deferred) = finalize_spawn_args("claude", &merged, prompt);
            assert!(deferred.is_none(), "claude keeps argv prompt delivery");
            argv
        };
        for (model, print_mode, output_format) in [
            (None, false, None),               // prompt only
            (Some("opus"), false, None),       // prompt + model
            (None, true, Some("stream-json")), // prompt + print + format
        ] {
            assert_eq!(
                new_path("fix the bug", model, print_mode, output_format),
                old_branch("fix the bug", model, print_mode, output_format),
                "argv drift for model={model:?} print={print_mode} format={output_format:?}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // merge_mcp_params_into_args tests
    // -----------------------------------------------------------------------

    #[test]
    fn merge_params_model_no_conflict() {
        let args = vec!["--fast".to_string()];
        let result =
            merge_mcp_params_into_args("claude", &args, Some("gpt-4"), false, None, false).unwrap();
        assert!(result.contains(&"--model".to_string()));
        assert!(result.contains(&"gpt-4".to_string()));
    }

    #[test]
    fn merge_params_model_conflict() {
        let args = vec!["--model".to_string(), "sonnet".to_string()];
        let result = merge_mcp_params_into_args("claude", &args, Some("gpt-4"), false, None, false);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Conflict"));
    }

    #[test]
    fn merge_params_print_mode_appended() {
        let args = vec![];
        let result = merge_mcp_params_into_args("claude", &args, None, true, None, false).unwrap();
        assert!(result.contains(&"--print".to_string()));
    }

    #[test]
    fn merge_params_print_mode_already_present() {
        let args = vec!["--print".to_string()];
        let result = merge_mcp_params_into_args("claude", &args, None, true, None, false).unwrap();
        // Should not duplicate
        assert_eq!(result.iter().filter(|a| *a == "--print").count(), 1);
    }

    #[test]
    fn merge_params_output_format_conflict() {
        let args = vec!["--output-format".to_string(), "json".to_string()];
        let result = merge_mcp_params_into_args("claude", &args, None, false, Some("text"), false);
        assert!(result.is_err());
    }

    #[test]
    fn merge_params_output_format_no_conflict() {
        let args = vec![];
        let result =
            merge_mcp_params_into_args("claude", &args, None, false, Some("json"), false).unwrap();
        assert!(result.contains(&"--output-format".to_string()));
        assert!(result.contains(&"json".to_string()));
    }

    // Claude-only-param guard (todo.md O5): --print / --output-format must be
    // dropped for non-claude agents (codex/gemini/goose die with clap error 2).

    #[test]
    fn merge_params_codex_drops_print_mode() {
        let args = vec!["{prompt}".to_string()];
        let result = merge_mcp_params_into_args("codex", &args, None, true, None, false).unwrap();
        assert!(
            !result.contains(&"--print".to_string()),
            "codex must not receive --print"
        );
        assert_eq!(result, vec!["{prompt}".to_string()]);
    }

    #[test]
    fn merge_params_codex_drops_output_format() {
        let args = vec!["{prompt}".to_string()];
        let result =
            merge_mcp_params_into_args("codex", &args, None, false, Some("json"), false).unwrap();
        assert!(
            !result.contains(&"--output-format".to_string()),
            "codex must not receive --output-format"
        );
        assert!(!result.contains(&"json".to_string()));
    }

    #[test]
    fn merge_params_codex_drops_both() {
        let args = vec!["{prompt}".to_string()];
        let result =
            merge_mcp_params_into_args("codex", &args, None, true, Some("json"), false).unwrap();
        assert!(!result.contains(&"--print".to_string()));
        assert!(!result.contains(&"--output-format".to_string()));
        assert_eq!(result, vec!["{prompt}".to_string()]);
    }

    #[test]
    fn direct_codex_defaults_apply_bypass_after_merge() {
        let args = vec!["{prompt}".to_string()];
        let result = merge_mcp_params_into_args("codex", &args, None, false, None, false).unwrap();
        let result = apply_direct_codex_defaults("codex", result);
        assert_eq!(
            result,
            vec![
                "--dangerously-bypass-approvals-and-sandbox".to_string(),
                "{prompt}".to_string()
            ]
        );
    }

    #[test]
    fn direct_codex_bypass_after_option_terminator_does_not_satisfy_default() {
        let args = vec![
            "--".to_string(),
            CODEX_BYPASS_ARG.to_string(),
            "task text".to_string(),
        ];
        let result = apply_direct_codex_defaults("codex", args);

        assert_eq!(
            result,
            vec![CODEX_BYPASS_ARG, "--", CODEX_BYPASS_ARG, "task text"]
        );
    }

    #[test]
    fn direct_codex_executable_identity_is_exact_and_cross_platform() {
        assert!(is_direct_codex_executable("/usr/local/bin/codex"));
        assert!(is_direct_codex_executable("C:\\tools\\codex.exe"));
        assert!(is_direct_codex_executable("C:\\tools\\codex.cmd"));
        assert!(is_direct_codex_executable("/opt/tools/CODEX"));
        assert!(!is_direct_codex_executable(
            "/opt/company/bin/codex-wrapper"
        ));
    }

    #[test]
    fn named_codex_run_config_preserves_existing_bypass() {
        let args = vec![
            "--dangerously-bypass-approvals-and-sandbox".to_string(),
            "--search".to_string(),
        ];
        let agent_type = resolve_spawn_agent_type("codex", Some("codex")).unwrap();
        let result = compose_mcp_run_config_args(
            &agent_type,
            "codex",
            &args,
            "perform the task",
            None,
            false,
            None,
        )
        .unwrap();

        assert_eq!(
            result,
            vec![CODEX_BYPASS_ARG, "--search", "perform the task"],
            "authored run-config argv must remain the prefix of the legacy positional prompt"
        );
    }

    #[test]
    fn named_codex_run_config_missing_bypass_gets_direct_default() {
        let args = vec!["--search".to_string()];
        let agent_type = resolve_spawn_agent_type("codex", Some("codex")).unwrap();
        let result = compose_mcp_run_config_args(
            &agent_type,
            "codex",
            &args,
            "perform the task",
            None,
            false,
            None,
        )
        .unwrap();

        assert_eq!(
            result,
            vec![CODEX_BYPASS_ARG, "--search", "perform the task"]
        );
    }

    #[test]
    fn named_codex_exec_run_config_preserves_positional_prompt() {
        let agent_type = resolve_spawn_agent_type("codex", Some("codex")).unwrap();
        let result = compose_mcp_run_config_args(
            &agent_type,
            "codex",
            &["exec".to_string()],
            "perform the task",
            None,
            false,
            None,
        )
        .unwrap();

        assert_eq!(result, vec![CODEX_BYPASS_ARG, "exec", "perform the task"]);
    }

    #[test]
    fn named_codex_placeholder_run_config_remains_authoritative() {
        let agent_type = resolve_spawn_agent_type("codex", Some("codex")).unwrap();
        let result = compose_mcp_run_config_args(
            &agent_type,
            "codex",
            &["exec".to_string(), "{prompt}".to_string()],
            "perform the task",
            None,
            false,
            None,
        )
        .unwrap();

        assert_eq!(result, vec![CODEX_BYPASS_ARG, "exec", "perform the task"]);
    }

    #[test]
    fn named_codex_wrapper_preserves_positional_prompt_and_is_warned() {
        let args = vec!["launch-codex".to_string()];
        let command = "/opt/company/bin/agent-wrapper";
        let agent_type = resolve_spawn_agent_type(command, Some("codex")).unwrap();
        let result = compose_mcp_run_config_args(
            &agent_type,
            command,
            &args,
            "perform the task",
            None,
            false,
            None,
        )
        .unwrap();

        assert_eq!(result, vec!["launch-codex", "perform the task"]);
        assert!(codex_wrapper_launch_warning(Some(agent_type.as_str()), command).is_some());
    }

    #[test]
    fn direct_codex_executable_overrides_mismatched_bucket_semantics() {
        let agent_type = resolve_spawn_agent_type("/usr/local/bin/codex", Some("claude")).unwrap();
        assert_eq!(agent_type, "codex");

        let (argv, deferred) = compose_mcp_spawn_args(McpSpawnArgs {
            agent_type: &agent_type,
            binary_path: "/usr/local/bin/codex",
            args: &["--search".to_string()],
            prompt: "perform the task",
            model: None,
            print_mode: false,
            output_format: None,
            default_template: false,
        })
        .unwrap();
        assert_eq!(argv, vec![CODEX_BYPASS_ARG, "--search"]);
        assert_eq!(deferred.as_deref(), Some("perform the task"));
    }

    #[test]
    fn merge_params_codex_keeps_model() {
        // --model is generic (codex accepts it) — only print/output-format are gated.
        let args = vec!["{prompt}".to_string()];
        let result =
            merge_mcp_params_into_args("codex", &args, Some("gpt-5"), true, Some("json"), false)
                .unwrap();
        assert!(result.contains(&"--model".to_string()));
        assert!(result.contains(&"gpt-5".to_string()));
        assert!(!result.contains(&"--print".to_string()));
        assert!(!result.contains(&"--output-format".to_string()));
    }

    #[test]
    fn merge_params_claude_keeps_both() {
        // Regression: claude behavior unchanged — both flags still injected.
        let args: Vec<String> = vec![];
        let result =
            merge_mcp_params_into_args("claude", &args, None, true, Some("json"), false).unwrap();
        assert!(result.contains(&"--print".to_string()));
        assert!(result.contains(&"--output-format".to_string()));
        assert!(result.contains(&"json".to_string()));
    }

    #[test]
    fn merge_params_run_config_claude_keeps_appended_order() {
        // Regression (codex review, story 092): the claude flags-first rule is
        // scoped to the default template. A user run config may wrap claude in a
        // launcher subcommand ("launch claude {prompt}") — prepending flags
        // before it would feed them to the wrapper. Run-config args keep the
        // legacy appended placement.
        let args = vec!["launch".to_string(), "{prompt}".to_string()];
        let result =
            merge_mcp_params_into_args("claude", &args, Some("opus"), false, None, false).unwrap();
        assert_eq!(result, vec!["launch", "{prompt}", "--model", "opus"]);
    }

    #[test]
    fn agent_inbox_rejects_unregistered_caller() {
        let state = test_state();
        let result = handle_messaging(
            &state,
            &serde_json::json!({"action": "inbox"}),
            Some("mcp-no-register"),
        );
        assert!(
            result["error"]
                .as_str()
                .is_some_and(|e| e.contains("not registered")),
            "inbox call from unregistered MCP session must error: {result}"
        );
    }

    // resolve_repo_for_path: regression tests for #1373-6e2f.
    // Without boundary-aware matching, `/foo/bar-other` would resolve to `/foo/bar`.
    // Without longest-match, a nested repo `/foo/bar/sub` would resolve to its parent.

    #[test]
    fn resolve_repo_exact_match() {
        let known = vec!["/foo/bar".to_string()];
        assert_eq!(resolve_repo_for_path("/foo/bar", &known), "/foo/bar");
    }

    #[test]
    fn resolve_repo_subpath_match() {
        let known = vec!["/foo/bar".to_string()];
        assert_eq!(
            resolve_repo_for_path("/foo/bar/src/main.rs", &known),
            "/foo/bar"
        );
    }

    #[test]
    fn resolve_repo_no_match_returns_input() {
        let known = vec!["/foo/bar".to_string()];
        assert_eq!(resolve_repo_for_path("/baz/qux", &known), "/baz/qux");
    }

    #[test]
    fn resolve_repo_does_not_match_sibling_with_shared_prefix() {
        // Without the boundary check, `/foo/bar-other/x` would resolve to `/foo/bar`.
        let known = vec!["/foo/bar".to_string(), "/foo/bar-other".to_string()];
        assert_eq!(
            resolve_repo_for_path("/foo/bar-other/x", &known),
            "/foo/bar-other"
        );
    }

    #[test]
    fn resolve_repo_picks_longest_for_nested_repos() {
        // Nested repo: a path under `/foo/bar/sub` must resolve to the inner repo.
        let known = vec!["/foo/bar".to_string(), "/foo/bar/sub".to_string()];
        assert_eq!(
            resolve_repo_for_path("/foo/bar/sub/file.rs", &known),
            "/foo/bar/sub"
        );
        // Reverse insertion order should not change the result.
        let known_rev = vec!["/foo/bar/sub".to_string(), "/foo/bar".to_string()];
        assert_eq!(
            resolve_repo_for_path("/foo/bar/sub/file.rs", &known_rev),
            "/foo/bar/sub"
        );
    }

    #[test]
    fn resolve_repo_empty_known_returns_input() {
        assert_eq!(resolve_repo_for_path("/foo/bar", &[]), "/foo/bar");
    }

    // ── config tool: AI prompts + prompt library ────────────────────

    fn localhost() -> SocketAddr {
        "127.0.0.1:9999".parse().unwrap()
    }

    fn remote_addr() -> SocketAddr {
        "192.168.1.10:9999".parse().unwrap()
    }

    #[test]
    fn config_list_ai_prompts_returns_services() {
        let state = test_state();
        let r = handle_config(
            &state,
            localhost(),
            &serde_json::json!({"action": "list_ai_prompts"}),
        );
        let services = r["services"].as_array().unwrap();
        assert_eq!(services.len(), 1);
        assert_eq!(services[0]["name"], "diff_triage");
    }

    #[test]
    fn config_load_ai_prompt_returns_default_when_no_custom() {
        let state = test_state();
        let _guard = crate::config::set_config_dir_override(
            std::env::temp_dir().join("test-ai-prompts-load"),
        );
        let r = handle_config(
            &state,
            localhost(),
            &serde_json::json!({
                "action": "load_ai_prompt", "service": "diff_triage"
            }),
        );
        assert_eq!(r["is_custom"], false);
        assert_eq!(r["service"], "diff_triage");
        assert!(r["prompt"].as_str().unwrap().len() > 10);
        assert_eq!(r["prompt"], r["default_prompt"]);
    }

    #[test]
    fn config_load_ai_prompt_unknown_service_errors() {
        let state = test_state();
        let r = handle_config(
            &state,
            localhost(),
            &serde_json::json!({
                "action": "load_ai_prompt", "service": "nonexistent"
            }),
        );
        assert!(r["error"].as_str().unwrap().contains("Unknown"));
    }

    #[test]
    fn config_save_ai_prompt_round_trip() {
        let state = test_state();
        let dir = std::env::temp_dir().join("test-ai-prompts-save");
        let _ = std::fs::create_dir_all(&dir);
        let _guard = crate::config::set_config_dir_override(dir);

        let save_r = handle_config(
            &state,
            localhost(),
            &serde_json::json!({
                "action": "save_ai_prompt", "service": "diff_triage", "prompt": "Custom prompt"
            }),
        );
        assert_eq!(save_r["ok"], true);

        let load_r = handle_config(
            &state,
            localhost(),
            &serde_json::json!({
                "action": "load_ai_prompt", "service": "diff_triage"
            }),
        );
        assert_eq!(load_r["is_custom"], true);
        assert_eq!(load_r["prompt"], "Custom prompt");
    }

    #[test]
    fn config_save_ai_prompt_empty_resets_to_default() {
        let state = test_state();
        let dir = std::env::temp_dir().join("test-ai-prompts-reset");
        let _ = std::fs::create_dir_all(&dir);
        let _guard = crate::config::set_config_dir_override(dir);

        handle_config(
            &state,
            localhost(),
            &serde_json::json!({
                "action": "save_ai_prompt", "service": "diff_triage", "prompt": "Custom"
            }),
        );
        handle_config(
            &state,
            localhost(),
            &serde_json::json!({
                "action": "save_ai_prompt", "service": "diff_triage", "prompt": ""
            }),
        );

        let r = handle_config(
            &state,
            localhost(),
            &serde_json::json!({
                "action": "load_ai_prompt", "service": "diff_triage"
            }),
        );
        assert_eq!(r["is_custom"], false);
    }

    #[test]
    fn config_save_ai_prompt_blocked_from_remote() {
        let state = test_state();
        let r = handle_config(
            &state,
            remote_addr(),
            &serde_json::json!({
                "action": "save_ai_prompt", "service": "diff_triage", "prompt": "Hack"
            }),
        );
        assert!(r["error"].as_str().unwrap().contains("localhost"));
    }

    #[test]
    fn config_save_ai_prompt_preserves_other_fields() {
        let state = test_state();
        let dir = std::env::temp_dir().join("test-ai-prompts-preserve");
        let _ = std::fs::create_dir_all(&dir);
        let _guard = crate::config::set_config_dir_override(dir);

        handle_config(
            &state,
            localhost(),
            &serde_json::json!({
                "action": "save_ai_prompt", "service": "diff_triage", "prompt": "Custom"
            }),
        );

        let config = crate::config::load_ai_prompts();
        assert_eq!(config.diff_triage_system_prompt.as_deref(), Some("Custom"));
    }

    #[test]
    fn config_list_prompts_empty_library() {
        let state = test_state();
        let dir = std::env::temp_dir().join("test-prompts-list");
        let _ = std::fs::create_dir_all(&dir);
        let _guard = crate::config::set_config_dir_override(dir);

        let r = handle_config(
            &state,
            localhost(),
            &serde_json::json!({"action": "list_prompts"}),
        );
        assert_eq!(r["prompts"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn config_save_and_load_prompt_round_trip() {
        let state = test_state();
        let dir = std::env::temp_dir().join("test-prompts-roundtrip");
        let _ = std::fs::create_dir_all(&dir);
        let _guard = crate::config::set_config_dir_override(dir);

        let save_r = handle_config(
            &state,
            localhost(),
            &serde_json::json!({
                "action": "save_prompt", "id": "p1", "label": "My Prompt", "text": "Do stuff"
            }),
        );
        assert_eq!(save_r["ok"], true);

        let load_r = handle_config(
            &state,
            localhost(),
            &serde_json::json!({
                "action": "load_prompt", "id": "p1"
            }),
        );
        assert_eq!(load_r["label"], "My Prompt");
        assert_eq!(load_r["text"], "Do stuff");
        assert_eq!(load_r["pinned"], false);
    }

    #[test]
    fn config_save_prompt_upserts() {
        let state = test_state();
        let dir = std::env::temp_dir().join("test-prompts-upsert");
        let _ = std::fs::create_dir_all(&dir);
        let _guard = crate::config::set_config_dir_override(dir);

        handle_config(
            &state,
            localhost(),
            &serde_json::json!({
                "action": "save_prompt", "id": "p1", "label": "V1", "text": "Old"
            }),
        );
        handle_config(
            &state,
            localhost(),
            &serde_json::json!({
                "action": "save_prompt", "id": "p1", "label": "V2", "text": "New", "pinned": true
            }),
        );

        let list_r = handle_config(
            &state,
            localhost(),
            &serde_json::json!({"action": "list_prompts"}),
        );
        let prompts = list_r["prompts"].as_array().unwrap();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0]["label"], "V2");
        assert_eq!(prompts[0]["pinned"], true);
    }

    #[test]
    fn config_save_prompt_blocked_from_remote() {
        let state = test_state();
        let r = handle_config(
            &state,
            remote_addr(),
            &serde_json::json!({
                "action": "save_prompt", "id": "p1", "label": "X", "text": "Y"
            }),
        );
        assert!(r["error"].as_str().unwrap().contains("localhost"));
    }

    #[test]
    fn config_load_prompt_not_found() {
        let state = test_state();
        let dir = std::env::temp_dir().join("test-prompts-404");
        let _ = std::fs::create_dir_all(&dir);
        let _guard = crate::config::set_config_dir_override(dir);

        let r = handle_config(
            &state,
            localhost(),
            &serde_json::json!({
                "action": "load_prompt", "id": "nonexistent"
            }),
        );
        assert!(r["error"].as_str().unwrap().contains("not found"));
    }

    // ---- ui(action=screenshot) -------------------------------------------------

    #[tokio::test]
    async fn ui_screenshot_requires_id() {
        let state = test_state();
        let r = handle_mcp_tool_call(
            &state,
            loopback_addr(),
            "ui",
            &serde_json::json!({ "action": "screenshot" }),
            None,
        )
        .await;
        let err = r["error"].as_str().expect("should return error");
        assert!(
            err.contains("'id'"),
            "Missing id should mention 'id' in error, got: {err}"
        );
    }

    #[tokio::test]
    async fn ui_screenshot_times_out_without_frontend() {
        let state = test_state();
        // No frontend listener, so the screenshot request will time out.
        // Override timeout to 1s to keep the test fast.
        let r = handle_screenshot(
            &state,
            loopback_addr(),
            &serde_json::json!({ "id": "nonexistent-panel" }),
        )
        .await;
        let err = r["error"].as_str().expect("should return error");
        assert!(
            err.contains("timed out") || err.contains("not available"),
            "Expected timeout or not-available error, got: {err}"
        );
    }

    #[tokio::test]
    async fn ui_screenshot_channel_delivers_result() {
        let state = test_state();
        let panel_id = "test-panel";

        // Simulate: spawn a task that waits for a screenshot_responses entry
        // and delivers fake base64 data.
        let state2 = state.clone();
        let deliver = tokio::spawn(async move {
            // Poll for the channel to appear
            for _ in 0..50 {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                if let Some((_, sender)) = state2.screenshot_responses.remove("") {
                    // Won't match — we need the actual request_id.
                    state2.screenshot_responses.insert(String::new(), sender);
                }
                // Check all entries
                let keys: Vec<_> = state2
                    .screenshot_responses
                    .iter()
                    .map(|e| e.key().clone())
                    .collect();
                for key in keys {
                    if let Some((_, sender)) = state2.screenshot_responses.remove(&key) {
                        // 1x1 white WebP (minimal valid WebP)
                        let fake_b64 =
                            base64::engine::general_purpose::STANDARD.encode(b"\x00\x00\x00\x00");
                        let _ = sender.send(Some(fake_b64));
                        return;
                    }
                }
            }
        });

        let r = handle_screenshot(
            &state,
            loopback_addr(),
            &serde_json::json!({ "id": panel_id }),
        )
        .await;
        deliver.await.unwrap();

        // Should succeed (write file) or at least not be a timeout
        if let Some(err) = r["error"].as_str() {
            assert!(
                !err.contains("timed out"),
                "Should not have timed out with a responding channel, got: {err}"
            );
        } else {
            assert!(
                r["ok"].as_bool().unwrap_or(false),
                "Expected ok: true, got: {r}"
            );
            assert!(
                r["path"].as_str().is_some(),
                "Expected path in result, got: {r}"
            );
        }
    }

    #[tokio::test]
    async fn ui_screenshot_non_loopback_rejected() {
        let state = test_state();
        let remote_addr: SocketAddr = "192.168.1.1:12345".parse().unwrap();
        let r = handle_mcp_tool_call(
            &state,
            remote_addr,
            "ui",
            &serde_json::json!({ "action": "screenshot", "id": "x" }),
            None,
        )
        .await;
        let err = r["error"].as_str().expect("should return error");
        assert!(
            err.contains("localhost"),
            "Non-loopback should be rejected, got: {err}"
        );
    }

    // -----------------------------------------------------------------------
    // SSE stream teardown (F66)
    // -----------------------------------------------------------------------

    fn insert_sse_session(state: &Arc<AppState>) -> String {
        let sid = uuid::Uuid::new_v4().to_string();
        state.mcp_sessions.insert(
            sid.clone(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code: false,
                requires_meta_tools: false,
                has_sse_stream: false,
                sse_generation: 0,
                repo_path: None,
            },
        );
        sid
    }

    /// A client that walks away is the normal way a `GET /mcp` stream ends: axum
    /// drops the response body, so nothing after the `select!` loop ever runs.
    /// Teardown has to hang off the drop, otherwise every reconnect leaves a
    /// broadcast sender behind and `messaging_channels` only ever grows.
    #[tokio::test]
    async fn dropping_the_sse_response_evicts_the_session_messaging_channel() {
        let state = test_state();
        let sid = insert_sse_session(&state);
        let mut headers = HeaderMap::new();
        headers.insert(MCP_SESSION_HEADER, sid.parse().unwrap());

        let response = mcp_get(State(state.clone()), headers).await.into_response();
        assert!(
            state.messaging_channels.contains_key(&sid),
            "subscribing must have created the per-session channel"
        );
        assert!(
            state
                .mcp_sessions
                .get(&sid)
                .is_some_and(|meta| meta.has_sse_stream),
            "the session must be flagged as streaming while the response is alive"
        );

        drop(response);
        assert!(
            !state.messaging_channels.contains_key(&sid),
            "dropping the stream must evict the messaging channel"
        );
        assert!(
            state
                .mcp_sessions
                .get(&sid)
                .is_some_and(|meta| !meta.has_sse_stream),
            "dropping the stream must clear has_sse_stream"
        );
    }

    /// A reconnect can be accepted while the stream it replaces is still
    /// half-open. Teardown used to release the session unconditionally, so the
    /// older stream's drop removed the sender the replacement had just
    /// subscribed to: the new stream saw `Closed` and every later server
    /// message was lost.
    #[tokio::test]
    async fn dropping_a_superseded_sse_stream_leaves_its_replacement_alive() {
        let state = test_state();
        let sid = insert_sse_session(&state);
        let mut headers = HeaderMap::new();
        headers.insert(MCP_SESSION_HEADER, sid.parse().unwrap());

        let first = mcp_get(State(state.clone()), headers.clone())
            .await
            .into_response();
        let second = mcp_get(State(state.clone()), headers).await.into_response();

        // The replacement holds a receiver on the session's sender.
        let mut rx = state
            .messaging_channels
            .get(&sid)
            .expect("the replacement must have a channel")
            .subscribe();

        drop(first);
        assert!(
            state.messaging_channels.contains_key(&sid),
            "the superseded stream must not evict the live stream's channel"
        );
        assert!(
            state
                .mcp_sessions
                .get(&sid)
                .is_some_and(|meta| meta.has_sse_stream),
            "the session is still streaming through the replacement"
        );
        assert!(
            !matches!(
                rx.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Closed)
            ),
            "the replacement's receiver must still be open"
        );

        // The owner's own teardown still releases everything.
        drop(second);
        assert!(!state.messaging_channels.contains_key(&sid));
        assert!(
            state
                .mcp_sessions
                .get(&sid)
                .is_some_and(|meta| !meta.has_sse_stream)
        );
    }

    /// Generations come from one process-wide counter, not from the session.
    /// A `DELETE /mcp` can retire a session id while its stream is still
    /// half-open, and the next `GET` auto-recovers that id from scratch — a
    /// per-session counter would restart at zero and reissue the number the
    /// half-open stream still holds, whose teardown would then close the new one.
    #[tokio::test]
    async fn a_recreated_session_does_not_reissue_a_live_stream_s_generation() {
        let state = test_state();
        let sid = insert_sse_session(&state);
        let mut headers = HeaderMap::new();
        headers.insert(MCP_SESSION_HEADER, sid.parse().unwrap());

        let first = mcp_get(State(state.clone()), headers.clone())
            .await
            .into_response();
        // DELETE /mcp retires the session while `first` is still draining.
        state.mcp_sessions.remove(&sid);
        // The same id comes back and is auto-recovered from scratch.
        let second = mcp_get(State(state.clone()), headers).await.into_response();

        let mut rx = state
            .messaging_channels
            .get(&sid)
            .expect("the new stream must have a channel")
            .subscribe();

        drop(first);
        assert!(
            state.messaging_channels.contains_key(&sid),
            "the retired stream must not release the recreated session"
        );
        assert!(
            !matches!(
                rx.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Closed)
            ),
            "the new stream's receiver must still be open"
        );
        drop(second);
        assert!(!state.messaging_channels.contains_key(&sid));
    }

    /// The generation check protects the *present* session. When `DELETE /mcp`
    /// or the reaper has already retired the id, there is no generation to
    /// compare and teardown removes the channel outright — so that removal must
    /// still be serialized against a reconnect, which recreates the session and
    /// subscribes to a fresh sender. `get_mut` returning `None` cannot do it: it
    /// releases the shard first, and a `GET` landing in that window gets its
    /// brand-new sender deleted underneath it. Only holding the shard over the
    /// absent key does, so that is what this asserts — the race window itself is
    /// nanoseconds wide and cannot be hit on demand.
    #[test]
    fn teardown_of_a_retired_session_holds_it_across_the_channel_removal() {
        use dashmap::try_result::TryResult;

        let state = test_state();
        let sid = insert_sse_session(&state);
        let mut headers = HeaderMap::new();
        headers.insert(MCP_SESSION_HEADER, sid.parse().unwrap());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let first = rt
            .block_on(mcp_get(State(state.clone()), headers))
            .into_response();

        // DELETE /mcp retires the id: teardown will take the absent-key path.
        state.mcp_sessions.remove(&sid);

        // Hold the channel's shard so the removal inside teardown has to wait
        // there, with whatever it took on the session map still held.
        let channel_shard = state.messaging_channels.entry(sid.clone());

        let dropper = std::thread::spawn(move || drop(first));

        let mut held = false;
        for _ in 0..200 {
            if matches!(state.mcp_sessions.try_get(&sid), TryResult::Locked) {
                // A momentary `get_mut` on an absent key also locks the shard,
                // so a single observation proves nothing — the hold has to last.
                std::thread::sleep(std::time::Duration::from_millis(100));
                held = matches!(state.mcp_sessions.try_get(&sid), TryResult::Locked);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            held,
            "teardown must still own the retired session while it removes the channel"
        );

        drop(channel_shard);
        dropper.join().expect("teardown thread");
        assert!(
            !state.messaging_channels.contains_key(&sid),
            "with nobody left to own it, the channel is still released"
        );
    }

    // -----------------------------------------------------------------------
    // Bridge liveness poll (F60)
    // -----------------------------------------------------------------------

    /// Every bridge pings every 3s and asserts `x-tuic-session` on that ping.
    /// An already-bound bridge has nothing to bind, so the poll must not queue
    /// behind the process-global identity lock — with one bridge per agent
    /// terminal that is N/3 acquisitions per second to rewrite identical values.
    #[test]
    fn ping_from_an_already_bound_bridge_does_not_take_the_identity_lock() {
        let state = test_state();
        let sid = insert_sse_session(&state);
        let tuic = uuid::Uuid::new_v4().to_string();
        // Bind the identity the way initialize does, before we take the guard.
        assert!(apply_initialize_identity(&state, &sid, Some(tuic.as_str())));

        // Hold the identity lock, then let the bridge ping. A ping that needs the
        // lock cannot answer until we let go.
        let guard = PEER_IDENTITY_BIND_LOCK.lock();
        let (tx, rx) = std::sync::mpsc::channel();
        let ping_state = state.clone();
        let ping_sid = sid.clone();
        let ping_tuic = tuic.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            let mut headers = HeaderMap::new();
            headers.insert(MCP_SESSION_HEADER, ping_sid.parse().unwrap());
            headers.insert(TUIC_SESSION_HEADER, ping_tuic.parse().unwrap());
            let response = rt.block_on(async {
                mcp_post(
                    State(ping_state),
                    ConnectInfo(loopback_addr()),
                    headers,
                    Json(serde_json::json!({
                        "jsonrpc": "2.0", "id": 0, "method": "ping"
                    })),
                )
                .await
                .into_response()
            });
            let _ = tx.send(response.status());
        });

        let outcome = rx.recv_timeout(std::time::Duration::from_secs(2));
        drop(guard);
        assert_eq!(
            outcome.ok(),
            Some(StatusCode::OK),
            "ping blocked on PEER_IDENTITY_BIND_LOCK"
        );
    }

    // -----------------------------------------------------------------------
    // Per-repo upstream allowlist resolution (F62)
    // -----------------------------------------------------------------------

    /// A native tool never consults the per-repo upstream allowlist, so it must
    /// not pay for loading it. Proven by making `repo-settings.json` a reader-less
    /// FIFO: `read_to_string` blocks in `open()`, so any call that still touches
    /// the file never answers.
    #[cfg(unix)]
    #[test]
    fn a_native_tool_call_does_not_read_repo_settings() {
        use std::os::unix::ffi::OsStrExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let fifo = dir.path().join("repo-settings.json");
        let c_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(
            unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) },
            0,
            "mkfifo failed"
        );
        let _config_guard = crate::config::set_config_dir_override(dir.path().to_path_buf());

        let state = test_state();
        let sid = uuid::Uuid::new_v4().to_string();
        state.mcp_sessions.insert(
            sid.clone(),
            crate::state::McpSessionMeta {
                last_activity: std::time::Instant::now(),
                is_claude_code: false,
                requires_meta_tools: false,
                // A repo_path is what makes the allowlist lookup reach the disk.
                repo_path: Some("/test/repo".to_string()),
                has_sse_stream: false,
                sse_generation: 0,
            },
        );

        let (tx, rx) = std::sync::mpsc::channel();
        let call_state = state.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            let body = rt.block_on(post_test_tool_call(
                call_state,
                &sid,
                "definitely_not_a_native_tool",
                serde_json::json!({}),
            ));
            let _ = tx.send(body);
        });

        let outcome = rx.recv_timeout(std::time::Duration::from_secs(3));
        assert!(
            outcome.is_ok(),
            "a native tool call blocked on reading repo-settings.json"
        );
    }
}
