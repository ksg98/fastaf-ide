//! PTY read API for plugins.
//!
//! Exposes read-only access to VT100 buffer contents (visible screen + recent
//! scrollback) for plugins that need to react to terminal state — e.g. reading
//! the agent's last reply to verify its content.
//!
//! Gated by the `pty:read` capability.

use crate::AppState;
use std::sync::Arc;

/// Maximum lines requestable via `plugin_read_session_output`.
const MAX_LINES: usize = 2000;
/// Default lines returned when `max_lines` is omitted.
const DEFAULT_LINES: usize = 200;

/// Read the VT100-decoded contents of a PTY session.
///
/// Returns the last `max_lines` of scrollback concatenated with the current
/// visible screen rows, joined by newlines. Alternate-screen agents (Claude
/// Code, Codex, Ink-based TUIs) only produce screen rows — scrollback is
/// empty for those sessions.
///
/// Requires the `pty:read` capability. Returns an error if the session does
/// not exist (closed or never created).
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn plugin_read_session_output(
    session_id: String,
    max_lines: Option<usize>,
    plugin_id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    plugin_read_session_output_impl(&state, session_id, max_lines, plugin_id)
}

pub(crate) fn plugin_read_session_output_impl(
    state: &Arc<AppState>,
    session_id: String,
    max_lines: Option<usize>,
    plugin_id: String,
) -> Result<String, String> {
    crate::plugins::check_plugin_capability(state, &plugin_id, "pty:read")?;

    let vt_log = state
        .vt_log_buffers
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;

    let buf = vt_log.lock();
    let limit = max_lines.unwrap_or(DEFAULT_LINES).min(MAX_LINES);

    let total = buf.total_lines();
    let offset = total.saturating_sub(limit);
    let (log_lines, _) = buf.lines_since_owned(offset, limit);

    let screen: Vec<String> = buf
        .screen_rows()
        .into_iter()
        .filter(|r| !r.is_empty())
        .collect();

    let mut all: Vec<String> = log_lines.iter().map(|ll| ll.text()).collect();
    all.extend(screen);
    Ok(all.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::VtLogBuffer;

    fn state() -> Arc<AppState> {
        Arc::new(crate::state::tests_support::make_test_app_state())
    }

    fn grant(state: &AppState, plugin_id: &str, caps: &[&str]) {
        state.loaded_plugins.insert(
            plugin_id.to_string(),
            caps.iter().map(|c| c.to_string()).collect(),
        );
    }

    /// Insert a session buffer, feeding `bytes` through the VT100 grid so
    /// scrolled-off lines accumulate in the log. A 2-row grid keeps the visible
    /// screen tiny so tests can reason about log vs screen line counts.
    fn insert_session(state: &AppState, sid: &str, bytes: &[u8]) {
        let mut vt = VtLogBuffer::new(2, 80, 5000);
        vt.process(bytes);
        state
            .vt_log_buffers
            .insert(sid.to_string(), parking_lot::Mutex::new(vt));
    }

    #[test]
    fn read_requires_pty_read_capability() {
        let st = state();
        // Unregistered plugin → capabilities cannot be verified at all.
        let err =
            plugin_read_session_output_impl(&st, "s".into(), None, "ghost".into()).unwrap_err();
        assert!(err.contains("not registered"), "got: {err}");
        // Registered but WITHOUT pty:read → rejected before any buffer access.
        grant(&st, "reader", &["fs:read"]);
        let err =
            plugin_read_session_output_impl(&st, "s".into(), None, "reader".into()).unwrap_err();
        assert!(
            err.contains("pty:read") && err.contains("did not declare"),
            "got: {err}"
        );
    }

    #[test]
    fn read_errors_when_session_missing() {
        let st = state();
        grant(&st, "reader", &["pty:read"]);
        // Capability granted, but the session buffer does not exist.
        let err =
            plugin_read_session_output_impl(&st, "nope".into(), None, "reader".into()).unwrap_err();
        assert_eq!(err, "Session not found: nope");
    }

    #[test]
    fn read_returns_tail_and_clamps_line_count() {
        let st = state();
        grant(&st, "reader", &["pty:read"]);

        // Feed 2100 numbered lines so ~2099 scroll into the log (capacity 5000
        // retains them all) — comfortably above the MAX_LINES clamp.
        let mut feed = String::new();
        for i in 0..2100 {
            feed.push_str(&format!("L{i:04}\r\n"));
        }
        insert_session(&st, "s", feed.as_bytes());
        let total = st.vt_log_buffers.get("s").unwrap().lock().total_lines();
        assert!(
            total > MAX_LINES,
            "fixture must exceed the clamp, got {total}"
        );

        // A request far above MAX_LINES is clamped to at most MAX_LINES log lines
        // (plus the ≤2 visible screen rows), never the full ~2100.
        let out =
            plugin_read_session_output_impl(&st, "s".into(), Some(1_000_000), "reader".into())
                .unwrap();
        let log_count = out.lines().filter(|l| l.starts_with('L')).count();
        assert!(
            (MAX_LINES - 50..=MAX_LINES + 5).contains(&log_count),
            "huge request must clamp to ~MAX_LINES, got {log_count}"
        );
        // The clamp keeps the TAIL: newest line present, oldest dropped.
        assert!(out.contains("L2099"), "newest line must survive");
        assert!(!out.contains("L0000"), "oldest line must be clamped out");

        // Omitting max_lines falls back to DEFAULT_LINES, not the whole buffer.
        let out_default =
            plugin_read_session_output_impl(&st, "s".into(), None, "reader".into()).unwrap();
        let default_count = out_default.lines().filter(|l| l.starts_with('L')).count();
        assert!(
            (0..=DEFAULT_LINES + 5).contains(&default_count),
            "default must clamp to DEFAULT_LINES, got {default_count}"
        );
        assert!(
            out_default.contains("L2099"),
            "default read is still the tail"
        );
    }
}
