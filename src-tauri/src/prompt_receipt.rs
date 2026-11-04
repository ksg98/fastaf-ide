//! Launch-time observations, owned by the live PTY/MCP metadata, never settings.
use crate::AppState;
use serde::Serialize;

pub const SECTION_BYTE_CAP: usize = 32 * 1024;
pub const RECEIPT_BYTE_CAP: usize = 64 * 1024;
pub const SECTION_COUNT_CAP: usize = 16;
const FILE_READ_CAP: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptSection {
    pub label: String,
    pub source: String,
    pub bytes: Option<u64>,
    pub text: String,
    pub status: String,
    pub truncated: bool,
    /// Observations folded into this row; a served row absorbs every reconnect.
    pub count: u32,
    pub first_seen_ms: u64,
    pub last_seen_ms: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptReceipt {
    pub sections: Vec<PromptSection>,
    pub capture_limited: bool,
}

impl PromptSection {
    fn captured(label: &str, source: &str, text: &str, status: &str) -> Self {
        let mut redacted = crate::redaction::redact_secrets(text);
        let truncated = redacted.len() > SECTION_BYTE_CAP;
        truncate_utf8(&mut redacted, SECTION_BYTE_CAP);
        let mut source = crate::redaction::redact_secrets(source);
        truncate_utf8(&mut source, 1024);
        let now_ms = now_ms();
        Self {
            label: label.into(),
            source,
            bytes: Some(text.len() as u64),
            text: redacted,
            status: status.into(),
            truncated,
            count: 1,
            first_seen_ms: now_ms,
            last_seen_ms: now_ms,
        }
    }

    fn unavailable(label: &str, source: &str) -> Self {
        let mut section = Self::captured(label, source, "Not observable by TUIC", "not_observable");
        section.bytes = None;
        section
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn truncate_utf8(text: &mut String, cap: usize) {
    let mut end = text.len().min(cap);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
}

/// Keep initialize responses in protocol metadata even when they race PTY
/// registration. Copy into the owning PTY so protocol reaping loses no receipt.
pub fn record_mcp_instructions(state: &AppState, mcp_id: &str, text: &str) {
    let Some(peer) = state.mcp.to_session.get(mcp_id).map(|p| p.value().clone()) else {
        return;
    };
    if let Some(mut meta) = state.mcp.sessions.get_mut(mcp_id) {
        let receipt = meta
            .prompt_instructions
            .get_or_insert_with(PromptReceipt::default);
        let source = format!("TUIC MCP initialize ({mcp_id})");
        receipt.push(PromptSection::captured(
            "MCP initialize instructions",
            &source,
            text,
            "served",
        ));
    }
    let pty_id = state
        .session_maps
        .live_pty_by_tuic_session
        .get(&peer)
        .map(|p| p.value().clone())
        .unwrap_or(peer);
    adopt_mcp_instructions(state, &pty_id);
}

/// Move the protocol-side observations into the owning PTY. Draining keeps
/// every observation counted once however often the receipt is read; a peer
/// that has no live PTY yet keeps its rows until it has one.
pub fn adopt_mcp_instructions(state: &AppState, session_id: &str) {
    let Some(session) = state.session_maps.sessions.get(session_id) else {
        return;
    };
    let mut sections = Vec::new();
    let mut limited = false;
    for entry in &state.mcp.to_session {
        let peer = entry.value();
        let owner = state
            .session_maps
            .live_pty_by_tuic_session
            .get(peer)
            .map(|p| p.value().clone());
        if (peer == session_id || owner.as_deref() == Some(session_id))
            && let Some(mut meta) = state.mcp.sessions.get_mut(entry.key())
            && let Some(receipt) = meta.prompt_instructions.take()
        {
            sections.extend(receipt.sections);
            limited |= receipt.capture_limited;
        }
    }
    if sections.is_empty() {
        return;
    }
    // Capture order, not source text: ties fall back to label and source so
    // two reads of the same data always list rows alike.
    sections.sort_by(|a, b| {
        (a.first_seen_ms, &a.label, &a.source).cmp(&(b.first_seen_ms, &b.label, &b.source))
    });
    let mut session = session.lock();
    let receipt = session.launch_receipt.get_or_insert_with(|| {
        let mut receipt = PromptReceipt::default();
        receipt.push(PromptSection::unavailable(
            "Launch receipt unavailable",
            "Session predates capture or was launched outside the managed spawn path",
        ));
        receipt
    });
    for section in sections {
        receipt.push(section);
    }
    receipt.capture_limited |= limited;
}

pub fn read_receipt(state: &AppState, session_id: &str) -> Result<PromptReceipt, String> {
    adopt_mcp_instructions(state, session_id);
    let session = state
        .session_maps
        .sessions
        .get(session_id)
        .ok_or("Session not found")?;
    let mut receipt = session.lock().launch_receipt.clone().unwrap_or_default();
    if receipt.sections.is_empty() {
        receipt.push(PromptSection::unavailable(
            "Launch receipt unavailable",
            "Session predates capture or was launched outside the managed spawn path",
        ));
    }
    if !receipt.sections.iter().any(|s| s.status == "served") {
        receipt.sections.push(PromptSection::unavailable(
            "MCP initialize instructions",
            "No captured initialize response for this session",
        ));
    }
    // This row is intentionally outside the capture cap: even a full receipt
    // must disclose the boundary of TUIC's observations.
    receipt.sections.push(PromptSection::unavailable(
        "Agent-loaded instructions",
        "Files read independently by the agent; not observable by TUIC",
    ));
    Ok(receipt)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn get_prompt_receipt(
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    session_id: String,
) -> Result<PromptReceipt, String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || read_receipt(&state, &session_id))
        .await
        .map_err(|error| format!("Read launch receipt: {error}"))?
}

mod capture;

#[cfg(test)]
mod tests;
