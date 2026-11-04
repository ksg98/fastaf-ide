//! Exact Codex identity received over the existing native-hook OSC channel.
//! Discovery's newest-file heuristic never participates in Chat resolution.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::state::{AppEvent, AppState};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CodexBinding {
    pub session_id: String,
    #[serde(skip)]
    transcript_path: PathBuf,
    #[serde(skip)]
    cwd: PathBuf,
    #[serde(skip)]
    owner_pid: u32,
}

#[derive(Deserialize)]
struct NativeSession {
    session_id: String,
    transcript_path: PathBuf,
    cwd: PathBuf,
    hook_event_name: String,
}

/// Hook stdin is encoded so native paths cannot introduce OSC delimiters.
/// The inherited TUIC_SESSION must identify this reader, never another tab.
pub(crate) fn receive(state: &AppState, sid: &str, tuic: Option<&str>, payload: &str) {
    let Some((owner, encoded)) = payload.split_once(':') else {
        return;
    };
    if tuic != Some(owner) || encoded.len() > 32 * 1024 {
        return;
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return;
    };
    let Ok(native) = serde_json::from_slice::<NativeSession>(&bytes) else {
        return;
    };
    if !matches!(
        native.hook_event_name.as_str(),
        "SessionStart" | "UserPromptSubmit"
    ) || uuid::Uuid::parse_str(&native.session_id).is_err()
    {
        return;
    }
    let Some(pid) = crate::pty::session_leaf_pid(state, sid) else {
        return;
    };
    let binding = CodexBinding {
        session_id: native.session_id,
        transcript_path: native.transcript_path,
        cwd: native.cwd,
        owner_pid: pid,
    };
    // Keep native evidence even if SessionStart precedes the first rollout flush.
    // Chat and lifecycle publication validate it before exposing exactness.
    let changed = if let Some(mut session) = state.session_maps.session_states.get_mut(sid) {
        let changed = session.codex_binding.as_ref() != Some(&binding);
        session.codex_binding = Some(binding);
        changed
    } else {
        false
    };
    if changed {
        state.chat_views.invalidate(sid);
    }
    state.emit_pty_event(AppEvent::PtyActivity {
        session_id: sid.into(),
    });
}

fn validated(state: &AppState, sid: &str, binding: &CodexBinding) -> Option<PathBuf> {
    if crate::pty::session_leaf_pid(state, sid)? != binding.owner_pid
        || crate::pty::process_name_from_pid(binding.owner_pid).is_none()
    {
        return None;
    }
    let cwd = {
        let entry = state.session_maps.sessions.get(sid)?;
        let session = entry.lock();
        PathBuf::from(session.cwd.as_ref()?).canonicalize().ok()?
    };
    if binding.cwd.canonicalize().ok()? != cwd || !binding.transcript_path.is_absolute() {
        return None;
    }
    // Bound the header read: a corrupt/unrelated file cannot allocate unbounded memory.
    let file = std::fs::File::open(&binding.transcript_path).ok()?;
    let mut reader = BufReader::new(file.take(64 * 1024));
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let header: serde_json::Value = serde_json::from_str(&line).ok()?;
    if header["type"] != "session_meta" || header["payload"]["id"] != binding.session_id {
        return None;
    }
    let recorded_cwd = PathBuf::from(header["payload"]["cwd"].as_str()?)
        .canonicalize()
        .ok()?;
    (recorded_cwd == cwd).then(|| binding.transcript_path.clone())
}

pub(crate) fn transcript(state: &AppState, sid: &str) -> Option<PathBuf> {
    let binding = {
        let session = state.session_maps.session_states.get(sid)?;
        if session.agent_type.as_deref() != Some("codex") {
            return None;
        }
        session.codex_binding.clone()?
    };
    validated(state, sid, &binding)
}

/// Only live, validated evidence is serialized to IPC/HTTP consumers.
pub(crate) fn validate_snapshot(
    state: &AppState,
    sid: &str,
    snapshot: &mut crate::state::SessionState,
) {
    if snapshot.agent_type.as_deref() != Some("codex")
        || snapshot
            .codex_binding
            .as_ref()
            .is_some_and(|binding| validated(state, sid, binding).is_none())
    {
        snapshot.codex_binding = None;
    }
}

pub(crate) fn revoke(state: &AppState, sid: &str) {
    if let Some(mut session) = state.session_maps.session_states.get_mut(sid) {
        session.codex_binding = None;
    }
    state.chat_views.invalidate(sid);
}
