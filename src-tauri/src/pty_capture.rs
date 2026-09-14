//! Raw PTY capture tap — turns "it happened again" into a fixture.
//!
//! State recognition (working / idle / awaiting) is decided from bytes an agent
//! writes once and never repeats. When a detection breaks, the evidence is
//! already gone: the per-session output ring holds the last 8 KB, which a single
//! Ink repaint overruns in seconds. Every regression therefore had to be
//! re-diagnosed by reasoning about code instead of by replaying what actually
//! arrived — and each new agent harness broke a detector in a way no test could
//! have caught, because no test had the bytes.
//!
//! This records the raw stream to disk so a failure observed on screen becomes a
//! file that `pty::tests` can replay forever. Off by default; the check when off
//! is one relaxed atomic load per chunk.
//!
//! ```text
//! curl -X POST localhost:9876/diagnostics/capture -H 'content-type: application/json' \
//!      -d '{"enabled":true}'                    # all sessions
//!      -d '{"enabled":true,"session_id":"<id>"}' # one session
//! curl localhost:9876/diagnostics/capture        # state + files written
//! ```
//!
//! Captures land in `<app config dir>/captures/<session-id>.tcap` and stop
//! growing at [`MAX_CAPTURE_BYTES`] each: a fixture is a moment, not a session
//! transcript, and an unattended tap must not fill Boss's disk.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

const CAPTURE_MAGIC: &[u8] = b"TUICCAP1\n";
const RECORD_HEADER_BYTES: usize = 13; // direction:u8 + elapsed_us:u64 + len:u32

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CaptureDirection {
    Output = 0,
    Input = 1,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CaptureRecord {
    pub(crate) direction: CaptureDirection,
    pub(crate) elapsed_us: u64,
    pub(crate) data: Vec<u8>,
}

/// Per-session cap. Comfortably covers a full screen repaint plus the prompt
/// that follows it, which is all a state-detection fixture needs.
pub(crate) const MAX_CAPTURE_BYTES: u64 = 512 * 1024;

static ENABLED: AtomicBool = AtomicBool::new(false);

struct CaptureState {
    /// When set, only this session is recorded. `None` records every session.
    session_filter: Option<String>,
    /// Open capture files and how many bytes each has taken.
    files: HashMap<String, (std::fs::File, u64)>,
    dir: Option<PathBuf>,
    started_at: std::time::Instant,
}

static STATE: Mutex<Option<CaptureState>> = Mutex::new(None);

/// Whether the tap is recording. Cheap enough to call per chunk.
pub(crate) fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Start or stop recording. Starting always begins a fresh set of files:
/// a capture that silently appended to a previous run's bytes would replay as
/// one impossible stream.
pub(crate) fn set_enabled(enabled: bool, session_filter: Option<String>, dir: PathBuf) {
    let mut guard = STATE.lock();
    if enabled {
        *guard = Some(CaptureState {
            session_filter,
            files: HashMap::new(),
            dir: Some(dir),
            started_at: std::time::Instant::now(),
        });
    } else {
        *guard = None;
    }
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// Record one raw chunk. Called from the PTY read path, so it must never panic
/// and never block on anything but its own short-lived lock: a capture that can
/// take a session down is worse than no capture.
pub(crate) fn record(session_id: &str, data: &[u8]) {
    record_direction(session_id, CaptureDirection::Output, data);
}

/// Record bytes written by the user/remote transport to the PTY. Keeping input
/// in the same timeline is what makes bare-Enter and timer/input races
/// reproducible; raw agent output alone cannot encode the missing CLEAR event.
pub(crate) fn record_input(session_id: &str, data: &[u8]) {
    record_direction(session_id, CaptureDirection::Input, data);
}

fn record_direction(session_id: &str, direction: CaptureDirection, data: &[u8]) {
    if !is_enabled() {
        return;
    }
    let mut guard = STATE.lock();
    let Some(state) = guard.as_mut() else {
        return;
    };
    if let Some(filter) = &state.session_filter
        && filter != session_id
    {
        return;
    }
    let Some(dir) = state.dir.clone() else {
        return;
    };
    let elapsed_us = state.started_at.elapsed().as_micros().min(u64::MAX as u128) as u64;
    let entry = match state.files.get_mut(session_id) {
        Some(entry) => entry,
        None => {
            if std::fs::create_dir_all(&dir).is_err() {
                return;
            }
            let path = dir.join(format!("{session_id}.tcap"));
            let Ok(mut file) = std::fs::File::create(&path) else {
                return;
            };
            if file.write_all(CAPTURE_MAGIC).is_err() {
                return;
            }
            tracing::info!("[capture] recording {session_id} to {}", path.display());
            state
                .files
                .entry(session_id.to_string())
                .or_insert((file, CAPTURE_MAGIC.len() as u64))
        }
    };
    if entry.1 >= MAX_CAPTURE_BYTES {
        return;
    }
    let room = (MAX_CAPTURE_BYTES - entry.1) as usize;
    if room <= RECORD_HEADER_BYTES {
        return;
    }
    let payload_len = data.len().min(room - RECORD_HEADER_BYTES);
    let mut header = [0u8; RECORD_HEADER_BYTES];
    header[0] = direction as u8;
    header[1..9].copy_from_slice(&elapsed_us.to_le_bytes());
    header[9..13].copy_from_slice(&(payload_len as u32).to_le_bytes());
    if entry.0.write_all(&header).is_ok() && entry.0.write_all(&data[..payload_len]).is_ok() {
        entry.1 += (RECORD_HEADER_BYTES + payload_len) as u64;
    }
}

/// Decode a framed capture. Legacy `.raw` fixtures are returned as one output
/// record so the existing corpus remains usable while new captures preserve the
/// real read/write boundaries.
#[cfg(test)]
pub(crate) fn decode(bytes: &[u8]) -> Result<Vec<CaptureRecord>, String> {
    if !bytes.starts_with(CAPTURE_MAGIC) {
        return Ok(vec![CaptureRecord {
            direction: CaptureDirection::Output,
            elapsed_us: 0,
            data: bytes.to_vec(),
        }]);
    }
    let mut cursor = CAPTURE_MAGIC.len();
    let mut records = Vec::new();
    while cursor < bytes.len() {
        if bytes.len() - cursor < RECORD_HEADER_BYTES {
            return Err("truncated capture record header".to_string());
        }
        let direction = match bytes[cursor] {
            0 => CaptureDirection::Output,
            1 => CaptureDirection::Input,
            value => return Err(format!("invalid capture direction {value}")),
        };
        let elapsed_us = u64::from_le_bytes(bytes[cursor + 1..cursor + 9].try_into().unwrap());
        let len = u32::from_le_bytes(bytes[cursor + 9..cursor + 13].try_into().unwrap()) as usize;
        cursor += RECORD_HEADER_BYTES;
        let end = cursor
            .checked_add(len)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "truncated capture record payload".to_string())?;
        records.push(CaptureRecord {
            direction,
            elapsed_us,
            data: bytes[cursor..end].to_vec(),
        });
        cursor = end;
    }
    Ok(records)
}

/// Start or stop the tap on the canonical capture directory, and report the new
/// state. Every entry point — `POST /diagnostics/capture` and the desktop tab
/// menu — goes through here, so the two can never disagree about where a
/// capture lands.
pub(crate) fn set_enabled_in_config_dir(
    enabled: bool,
    session_filter: Option<String>,
) -> serde_json::Value {
    set_enabled(
        enabled,
        session_filter,
        crate::config::config_dir().join("captures"),
    );
    status()
}

/// Toggle the tap from the desktop app. The HTTP twin is
/// `mcp_http::log_routes::capture_set`.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn set_pty_capture(enabled: bool, session_id: Option<String>) -> serde_json::Value {
    set_enabled_in_config_dir(enabled, session_id)
}

/// Read the tap state from the desktop app. HTTP twin: `GET /diagnostics/capture`.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn get_pty_capture() -> serde_json::Value {
    status()
}

/// Current tap state, for `GET /diagnostics/capture`.
pub(crate) fn status() -> serde_json::Value {
    let guard = STATE.lock();
    match guard.as_ref() {
        Some(state) => serde_json::json!({
            "enabled": true,
            "session_filter": state.session_filter,
            "dir": state.dir.as_ref().map(|d| d.display().to_string()),
            "sessions": state.files.iter()
                .map(|(id, (_, len))| serde_json::json!({ "session_id": id, "bytes": len }))
                .collect::<Vec<_>>(),
        }),
        None => serde_json::json!({ "enabled": false }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tap is one global switch, so these tests would otherwise disable each
    /// other mid-run under cargo's parallel harness.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Disabled is the default, and a disabled tap writes nothing — the state a
    /// shipped build must be in.
    #[test]
    fn disabled_tap_writes_nothing() {
        let _guard = TEST_LOCK.lock();
        let dir = std::env::temp_dir().join("tuic-capture-test-disabled");
        let _ = std::fs::remove_dir_all(&dir);
        set_enabled(false, None, dir.clone());
        record("session-a", b"hello");
        assert!(!dir.exists());
    }

    #[test]
    fn capture_respects_the_session_filter_and_the_size_cap() {
        let _guard = TEST_LOCK.lock();
        let dir = std::env::temp_dir().join("tuic-capture-test-filter");
        let _ = std::fs::remove_dir_all(&dir);
        set_enabled(true, Some("wanted".into()), dir.clone());

        record("wanted", b"\x1b]777;notify;Claude Code;waiting\x07");
        record("other", b"must not be recorded");
        // Overrun the cap in one oversized chunk.
        record("wanted", &vec![b'x'; (MAX_CAPTURE_BYTES + 1024) as usize]);
        set_enabled(false, None, dir.clone());

        let wanted = std::fs::read(dir.join("wanted.tcap")).expect("filtered session recorded");
        assert!(wanted.starts_with(CAPTURE_MAGIC));
        assert_eq!(
            wanted.len() as u64,
            MAX_CAPTURE_BYTES,
            "capture must stop exactly at the cap"
        );
        assert!(
            !dir.join("other.tcap").exists(),
            "a filtered-out session must not be touched"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Re-enabling starts a new file rather than appending to the previous run:
    /// two runs concatenated replay as a stream that never existed.
    #[test]
    fn restarting_the_tap_truncates() {
        let _guard = TEST_LOCK.lock();
        let dir = std::env::temp_dir().join("tuic-capture-test-restart");
        let _ = std::fs::remove_dir_all(&dir);

        set_enabled(true, None, dir.clone());
        record("s", b"first run");
        set_enabled(false, None, dir.clone());

        set_enabled(true, None, dir.clone());
        record("s", b"second");
        set_enabled(false, None, dir.clone());

        let bytes = std::fs::read(dir.join("s.tcap")).unwrap();
        let records = decode(&bytes).expect("framed capture decodes");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].data, b"second");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn framed_capture_preserves_output_input_order_and_boundaries() {
        let _guard = TEST_LOCK.lock();
        let dir = std::env::temp_dir().join("tuic-capture-test-framed");
        let _ = std::fs::remove_dir_all(&dir);
        set_enabled(true, Some("s".into()), dir.clone());
        record("s", b"question?");
        record_input("s", b"\r");
        record("s", b"working");
        set_enabled(false, None, dir.clone());

        let records = decode(&std::fs::read(dir.join("s.tcap")).unwrap()).unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].direction, CaptureDirection::Output);
        assert_eq!(records[0].data, b"question?");
        assert_eq!(records[1].direction, CaptureDirection::Input);
        assert_eq!(records[1].data, b"\r");
        assert_eq!(records[2].direction, CaptureDirection::Output);
        assert_eq!(records[2].data, b"working");
        assert!(
            records
                .windows(2)
                .all(|pair| pair[0].elapsed_us <= pair[1].elapsed_us)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
