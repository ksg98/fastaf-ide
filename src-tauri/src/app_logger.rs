//! Centralized application log ring buffer.
//!
//! Stores structured log entries (level, source, message) in a fixed-capacity
//! circular buffer. The frontend pushes entries via `push_log` and retrieves
//! them via `get_logs`. This is the Rust source-of-truth for the log store;
//! the TypeScript `appLogger` store delegates to these commands.
//!
//! The `tracing` subscriber is wired to this buffer via [`RingBufferLayer`],
//! so every `tracing::warn!()` / `tracing::error!()` / etc. automatically
//! appears in the ErrorLogPanel and the `/logs` HTTP endpoint.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
#[cfg(feature = "desktop")]
use tauri::{Manager, State};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use crate::AppState;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A single log entry stored in the ring buffer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LogEntry {
    pub id: u64,
    pub timestamp_ms: i64,
    pub level: String,
    pub source: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_json: Option<String>,
    /// Who the entry is for: `"user"` (actionable by the person using TUIC) or
    /// `"diagnostic"` (app-internal telemetry useful only when debugging TUIC
    /// itself). The ErrorLogPanel defaults to the user view so diagnostic spam
    /// never buries user-relevant signal. Defaults to `"user"`.
    #[serde(default = "default_audience")]
    pub audience: String,
    /// How many consecutive duplicate messages were coalesced into this entry.
    /// 0 = first occurrence (no repeats), 1 = seen twice, etc.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub repeat_count: u32,
}

fn is_zero(v: &u32) -> bool {
    *v == 0
}

fn default_audience() -> String {
    "user".to_string()
}

/// Sources whose every entry is app-internal telemetry, classified as
/// `"diagnostic"` automatically so the emitters don't each have to opt in.
const DIAGNOSTIC_SOURCES: &[&str] = &["diagnostics", "perf"];

/// Resolve the audience for an entry: an explicit value wins; otherwise the
/// source decides (known diagnostic sources → `"diagnostic"`, else `"user"`).
fn resolve_audience(explicit: Option<String>, source: &str) -> String {
    if let Some(a) = explicit {
        return a;
    }
    if DIAGNOSTIC_SOURCES.contains(&source) {
        "diagnostic".to_string()
    } else {
        default_audience()
    }
}

/// The target `tracing_log` gives every record it converts from the `log`
/// facade. The bridge emits bridged records against one static callsite per
/// level, and that callsite's target is this literal; the record's real target,
/// module path, file and line travel as fields instead.
const BRIDGED_LOG_TARGET: &str = "log";
const BRIDGED_LOG_TARGET_FIELD: &str = "log.target";
const BRIDGED_LOG_MODULE_FIELD: &str = "log.module_path";

/// Classify an event that arrived over the `log` -> `tracing` bridge, giving
/// the source to file it under and the audience it belongs to.
///
/// TUICommander's own code never calls the `log` facade — every emitter of ours
/// calls `tracing` and names its own `source` — so a bridged record is by
/// definition a dependency's internal telemetry and is `diagnostic` however
/// loud its level. Without this it was neither: the source read as the literal
/// `"log"`, which is useless to filter on, and `resolve_audience` defaulted it
/// to `"user"`. A TLS-intercepting middlebox on the network therefore reached
/// the user as an unbroken flood of "TUICommander errors" from
/// `rustls_platform_verifier`, one per registry retry, naming nothing anyone
/// could act on — while the line that *is* actionable ("Upstream '<x>' request
/// failed") is ours and already carries its own source and audience.
///
/// `tracing_subscriber::fmt` unpacks the same fields before printing, which is
/// why stderr showed the real module all along and the ring buffer did not.
fn bridged_log_classification(
    target: &str,
    extra: Option<&std::collections::BTreeMap<String, String>>,
) -> Option<(String, String)> {
    if target != BRIDGED_LOG_TARGET {
        return None;
    }
    let source = extra
        .and_then(|fields| {
            fields
                .get(BRIDGED_LOG_TARGET_FIELD)
                .or_else(|| fields.get(BRIDGED_LOG_MODULE_FIELD))
        })
        .map(String::as_str)
        .unwrap_or(BRIDGED_LOG_TARGET);
    Some((source.to_string(), "diagnostic".to_string()))
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

pub(crate) const LOG_RING_CAPACITY: usize = 1000;

/// Fixed-capacity circular buffer for structured log entries.
pub(crate) struct LogRingBuffer {
    stall_journal: Option<tracing_appender::non_blocking::NonBlocking>,
    entries: Vec<Option<LogEntry>>,
    capacity: usize,
    /// Write position (wraps around)
    write_pos: usize,
    /// Number of entries currently stored (≤ capacity)
    count: usize,
    /// Monotonically increasing ID for the next entry
    next_id: u64,
}

impl LogRingBuffer {
    pub(crate) fn new(capacity: usize) -> Self {
        let mut entries = Vec::with_capacity(capacity);
        entries.resize_with(capacity, || None);
        Self {
            stall_journal: None,
            entries,
            capacity,
            write_pos: 0,
            count: 0,
            next_id: 1,
        }
    }

    /// Push a new entry into the ring buffer. Returns the assigned entry ID.
    ///
    /// If the most recent entry has the same level+source+message, the new push
    /// is coalesced: the existing entry's timestamp and repeat_count are updated
    /// instead of allocating a new slot. This prevents identical recurring
    /// warnings (e.g. polling failures) from flooding the ring buffer.
    pub(crate) fn push(
        &mut self,
        level: String,
        source: String,
        message: String,
        data_json: Option<String>,
    ) -> u64 {
        self.push_with_audience(level, source, message, data_json, None)
    }

    /// Push with an explicit audience. `audience = None` derives it from the
    /// source (see [`resolve_audience`]); existing callers keep using [`push`].
    pub(crate) fn push_with_audience(
        &mut self,
        level: String,
        source: String,
        message: String,
        data_json: Option<String>,
        audience: Option<String>,
    ) -> u64 {
        if let Some(writer) = &mut self.stall_journal {
            crate::stall_journal::capture(writer, &source, &message, data_json.as_deref());
        }
        let audience = resolve_audience(audience, &source);
        // Dedup: coalesce with the most recent entry if level+source+message+audience match
        if self.count > 0 {
            let last_idx = if self.write_pos == 0 {
                self.capacity - 1
            } else {
                self.write_pos - 1
            };
            if let Some(last) = &mut self.entries[last_idx]
                && last.level == level
                && last.source == source
                && last.message == message
                && last.audience == audience
            {
                last.repeat_count += 1;
                last.timestamp_ms = chrono::Utc::now().timestamp_millis();
                return last.id;
            }
        }

        let id = self.next_id;
        self.next_id += 1;

        let timestamp_ms = chrono::Utc::now().timestamp_millis();

        let entry = LogEntry {
            id,
            timestamp_ms,
            level,
            source,
            message,
            data_json,
            audience,
            repeat_count: 0,
        };

        self.entries[self.write_pos] = Some(entry);
        self.write_pos = (self.write_pos + 1) % self.capacity;
        if self.count < self.capacity {
            self.count += 1;
        }

        id
    }

    /// Return entries in chronological order (oldest first), up to `limit`.
    /// If `limit` is 0, returns all entries.
    pub(crate) fn get_entries(&self, limit: usize) -> Vec<LogEntry> {
        if self.count == 0 {
            return Vec::new();
        }

        let effective_limit = if limit == 0 {
            self.count
        } else {
            limit.min(self.count)
        };

        // Start index: oldest entry in the buffer
        let start = if self.count < self.capacity {
            0
        } else {
            self.write_pos // write_pos points to the oldest when buffer is full
        };

        // We want the *last* `effective_limit` entries (most recent)
        let skip = self.count - effective_limit;
        let mut result = Vec::with_capacity(effective_limit);
        for i in skip..self.count {
            let idx = (start + i) % self.capacity;
            if let Some(entry) = &self.entries[idx] {
                result.push(entry.clone());
            }
        }

        result
    }

    /// Remove all entries.
    pub(crate) fn clear(&mut self) {
        for slot in self.entries.iter_mut() {
            *slot = None;
        }
        self.write_pos = 0;
        self.count = 0;
        // Keep next_id monotonic — don't reset
    }

    /// Current number of entries in the buffer.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.count
    }
}

// ---------------------------------------------------------------------------
// Tracing → ring buffer layer
// ---------------------------------------------------------------------------

/// A `tracing_subscriber::Layer` that forwards events into the [`LogRingBuffer`].
///
/// It extracts the first `source` field from the event's span/fields (falling
/// back to the event target) and maps the tracing level to the ring buffer's
/// `level` string (`"error"`, `"warn"`, `"info"`, `"debug"`).
struct RingBufferLayer {
    buffer: Arc<Mutex<LogRingBuffer>>,
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for RingBufferLayer {
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        // Extract the message and optional `source` field.
        let mut visitor = LogVisitor::default();
        event.record(&mut visitor);

        let level = match *event.metadata().level() {
            tracing::Level::ERROR => "error",
            tracing::Level::WARN => "warn",
            tracing::Level::INFO => "info",
            _ => "debug",
        };

        let bridged = bridged_log_classification(event.metadata().target(), visitor.extra.as_ref());
        let (bridged_source, bridged_audience) = match bridged {
            Some((source, audience)) => (Some(source), Some(audience)),
            None => (None, None),
        };

        let source = visitor
            .source
            .take()
            .or(bridged_source)
            .unwrap_or_else(|| event.metadata().target().to_string());

        let message = visitor.message.take().unwrap_or_default();
        if message.is_empty() {
            return;
        }

        let data_json = visitor.data_json();
        let audience = visitor.audience.take().or(bridged_audience);
        let mut buf = self.buffer.lock();
        buf.push_with_audience(level.to_string(), source, message, data_json, audience);
    }
}

/// Visitor that extracts `message`, `source`, and extra fields from a tracing event.
#[derive(Default)]
struct LogVisitor {
    message: Option<String>,
    source: Option<String>,
    audience: Option<String>,
    extra: Option<std::collections::BTreeMap<String, String>>,
}

impl LogVisitor {
    fn data_json(&self) -> Option<String> {
        let extra = self.extra.as_ref()?;
        if extra.is_empty() {
            return None;
        }
        serde_json::to_string(extra).ok()
    }

    fn extra_mut(&mut self) -> &mut std::collections::BTreeMap<String, String> {
        self.extra
            .get_or_insert_with(std::collections::BTreeMap::new)
    }
}

impl tracing::field::Visit for LogVisitor {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        match field.name() {
            "message" => self.message = Some(value.to_string()),
            "source" => self.source = Some(value.to_string()),
            "audience" => self.audience = Some(value.to_string()),
            _ => {
                self.extra_mut()
                    .insert(field.name().to_string(), value.to_string());
            }
        }
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        match field.name() {
            "message" => self.message = Some(format!("{value:?}")),
            "source" => self.source = Some(format!("{value:?}")),
            "audience" => self.audience = Some(format!("{value:?}")),
            _ => {
                self.extra_mut()
                    .insert(field.name().to_string(), format!("{value:?}"));
            }
        }
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.extra_mut()
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.extra_mut()
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.extra_mut()
            .insert(field.name().to_string(), value.to_string());
    }
}

/// Max age for rotated log files before cleanup.
const LOG_RETENTION_DAYS: u64 = 5;

/// Initialise the global `tracing` subscriber.
///
/// Sets up three layers:
/// 1. **fmt** — writes structured logs to stderr (visible in `tauri dev`),
///    through a lossy non-blocking writer so a stalled console never blocks
///    the thread that logs.
/// 2. **RingBufferLayer** — forwards events into the shared [`LogRingBuffer`]
///    so they appear in the ErrorLogPanel and the `/logs` HTTP endpoint.
/// 3. **file** — daily-rotated log files in the config dir's `logs/` folder,
///    surviving WebView crashes. Old files (> 5 days) are cleaned up at init.
///
/// The default level is `info`; override with `RUST_LOG=debug` etc.
/// Must be called exactly once, early in `run()`.
pub(crate) fn init_tracing(buffer: Arc<Mutex<LogRingBuffer>>) {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let log_dir = crate::config::config_dir().join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    cleanup_old_logs(&log_dir);

    let (subscriber, guards) = build_subscriber(env_filter, std::io::stderr(), buffer, &log_dir);
    // Held in LOG_GUARD, not leaked: `flush_logs_on_exit` takes and drops it
    // on every graceful shutdown path (desktop `RunEvent::Exit`, or the end
    // of a headless/remote entry point) so the last buffered log lines — the
    // ones a shutdown bug needs most — are flushed to disk instead of lost
    // (story #672-c1a3: the un-wrapped RollingFileAppender did blocking file
    // I/O on every log call, including from async tokio tasks; wrapping it in
    // `non_blocking` moved that I/O off the caller, but its buffered writes
    // are silently dropped unless the guard is flushed before exit).
    *LOG_GUARD.lock() = guards;

    #[cfg(feature = "tokio-console")]
    {
        let console_layer = console_subscriber::spawn();
        subscriber.with(console_layer).init();
    }
    #[cfg(not(feature = "tokio-console"))]
    {
        subscriber.init();
    }
}

/// The layered subscriber `init_tracing` installs, writing its console output
/// to `console`. Split out so a test can drive the real layer stack against a
/// console it controls. The guards must outlive every log call.
fn build_subscriber(
    env_filter: tracing_subscriber::EnvFilter,
    console: impl std::io::Write + Send + 'static,
    buffer: Arc<Mutex<LogRingBuffer>>,
    log_dir: &std::path::Path,
) -> (
    impl tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a> + Send + Sync,
    Vec<tracing_appender::non_blocking::WorkerGuard>,
) {
    // The console goes through `non_blocking` too, never written from the
    // calling thread. Under `make dev` stderr is a 64 KiB pipe drained by the
    // Tauri CLI; an unread full pipe blocks synchronous writes from any thread
    // that logs, including the AppKit main thread that serves Tauri IPC.
    // The 2026-10-09 log silence, burst, and delayed events support this as a
    // historical stall hypothesis, not a proven cause. The console writer is
    // lossy: a saturated queue drops lines instead of stalling the process.
    // File retention remains unchanged with its existing lossy writer, as does
    // the ring's LOG_RING_CAPACITY limit (1000 events).
    let (console_writer, console_guard) = tracing_appender::non_blocking(console);
    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_writer(console_writer);

    let (journal_writer, journal_guard) = crate::stall_journal::writer(log_dir);
    buffer.lock().stall_journal = Some(journal_writer);
    let ring_layer = RingBufferLayer { buffer };

    let (file_writer, file_guard) = non_blocking_file_writer(log_dir);
    let file_layer = tracing_subscriber::fmt::layer()
        .with_target(true)
        .with_thread_ids(true)
        .with_ansi(false)
        .with_writer(file_writer);

    let subscriber = tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt_layer)
        .with(ring_layer)
        .with(file_layer);
    (subscriber, vec![console_guard, file_guard, journal_guard])
}

/// Holds the non-blocking writers' flush guards for the process lifetime.
/// Populated once by `init_tracing`, taken and dropped exactly once by
/// `flush_logs_on_exit` — whichever shutdown path runs first wins; the rest
/// find it empty and no-op.
static LOG_GUARD: Mutex<Vec<tracing_appender::non_blocking::WorkerGuard>> = Mutex::new(Vec::new());

/// Flush and drop the file appender's `WorkerGuard`, forcing
/// `tracing_appender::non_blocking`'s buffered writes to disk before the
/// process exits. Idempotent — call from every graceful shutdown path
/// (desktop `RunEvent::Exit`, the end of
/// `run_remote`); a call after the guard was already taken is a no-op
/// (story #672-c1a3).
pub(crate) fn flush_logs_on_exit() {
    drop(std::mem::take(&mut *LOG_GUARD.lock()));
}

/// Build a daily-rotated file writer that never blocks the calling thread.
/// `tracing_appender::rolling::daily` writes synchronously; wrapping it in
/// `non_blocking` moves the actual file I/O onto a dedicated worker thread.
/// The returned `WorkerGuard` must be kept alive for logs to be flushed —
/// dropping it (or never leaking it) silently drops buffered log lines.
fn non_blocking_file_writer(
    log_dir: &std::path::Path,
) -> (
    tracing_appender::non_blocking::NonBlocking,
    tracing_appender::non_blocking::WorkerGuard,
) {
    let file_appender = tracing_appender::rolling::daily(log_dir, "tuic.log");
    tracing_appender::non_blocking(file_appender)
}

/// Remove log files older than [`LOG_RETENTION_DAYS`].
fn cleanup_old_logs(log_dir: &std::path::Path) {
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(LOG_RETENTION_DAYS * 24 * 3600);
    let Ok(entries) = std::fs::read_dir(log_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("tuic.log."))
        {
            continue;
        }
        let Ok(meta) = path.metadata() else { continue };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if modified < cutoff {
            let _ = std::fs::remove_file(&path);
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Push a log entry from the frontend into the Rust ring buffer.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn push_log(
    state: State<'_, Arc<AppState>>,
    level: String,
    source: String,
    message: String,
    data_json: Option<String>,
    audience: Option<String>,
) {
    let mut buf = state.log_buffer.lock();
    buf.push_with_audience(level, source, message, data_json, audience);
}

/// Retrieve log entries. Returns up to `limit` most recent entries (0 = all).
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn get_logs(state: State<'_, Arc<AppState>>, limit: Option<usize>) -> Vec<LogEntry> {
    let buf = state.log_buffer.lock();
    buf.get_entries(limit.unwrap_or(0))
}

/// Clear all log entries.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn clear_logs(state: State<'_, Arc<AppState>>) {
    let mut buf = state.log_buffer.lock();
    buf.clear();
}

#[cfg(feature = "desktop")]
/// Push a log entry from internal Rust code using an AppHandle.
///
/// Use this in contexts where you have an `AppHandle` but not a `State<>` extractor
/// (e.g. watcher callbacks, plugin lifecycle hooks). Falls back silently if state
/// is not yet initialised.
pub(crate) fn log_via_handle(handle: &tauri::AppHandle, level: &str, source: &str, message: &str) {
    let state = handle.state::<Arc<AppState>>();
    let mut buf = state.log_buffer.lock();
    buf.push(
        level.to_string(),
        source.to_string(),
        message.to_string(),
        None,
    );
}

/// Push a log entry from internal Rust code using an AppState reference directly.
pub(crate) fn log_via_state(state: &Arc<AppState>, level: &str, source: &str, message: &str) {
    let mut buf = state.log_buffer.lock();
    buf.push(
        level.to_string(),
        source.to_string(),
        message.to_string(),
        None,
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stall_entries_survive_ring_overflow_and_restart() {
        // Catches: frontend stall evidence lives only in the wrapping in-memory ring.
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let buffer = Arc::new(Mutex::new(LogRingBuffer::new(2)));
        let (subscriber, guards) = build_subscriber(
            tracing_subscriber::EnvFilter::new("info"),
            std::io::sink(),
            buffer.clone(),
            dir.path(),
        );
        tracing::subscriber::with_default(subscriber, || {
            buffer.lock().push("warn".into(), "app".into(),
                "SLOW git.refreshBatch:/private/repo: 5500ms (body 20ms + flush 5480ms)".into(),
                Some(r#"{"total_ms":5500,"body_ms":20,"flush_ms":5480,"repo_count":16,"worktree_count":40,"response_bytes":12345}"#.into()));
            tracing::warn!(
                source = "diagnostics",
                silent_secs = 31_u64,
                last_heartbeat_received_ms = 1234_i64,
                "Frontend unresponsive: no heartbeat"
            );
            for i in 0..10 {
                buffer.lock().push(
                    "info".into(),
                    "noise".into(),
                    format!("unrelated {i}"),
                    None,
                );
            }
        });
        assert!(
            buffer
                .lock()
                .get_entries(0)
                .iter()
                .all(|e| e.source == "noise")
        );
        drop(guards); // The production graceful-exit flush.
        // Reopen the real subscriber at the same directory, as the next process does.
        let (_, guards) = build_subscriber(
            tracing_subscriber::EnvFilter::new("info"),
            std::io::sink(),
            Arc::new(Mutex::new(LogRingBuffer::new(2))),
            dir.path(),
        );
        drop(guards);
        let journal = std::fs::read_to_string(dir.path().join("stall-journal.jsonl"))
            .expect("stall evidence must survive ring overflow and app restart");
        let rows: Vec<serde_json::Value> = journal
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["kind"], "git_refresh");
        assert_eq!(rows[0]["metrics"]["flush_ms"], 5480);
        assert_eq!(rows[1]["kind"], "heartbeat_gap");
        assert_eq!(rows[1]["metrics"]["last_heartbeat_received_ms"], 1234);
        assert!(!journal.contains("/private/repo"));
        assert!(!journal.contains("unrelated"));
    }

    #[test]
    fn cleanup_old_logs_removes_all_stale_rotated_files() {
        let dir = tempfile::tempdir().expect("temp log dir");
        let stale = std::time::SystemTime::now()
            - std::time::Duration::from_secs((LOG_RETENTION_DAYS + 1) * 24 * 3600);

        for index in 0..112 {
            let path = dir.path().join(format!("tuic.log.2025-01-{index:03}"));
            let file = std::fs::File::create(path).expect("create stale rotated log");
            file.set_times(std::fs::FileTimes::new().set_modified(stale))
                .expect("age stale rotated log");
        }

        let recent = dir.path().join("tuic.log.2026-08-18");
        std::fs::File::create(&recent).expect("create recent rotated log");
        let unrelated = dir.path().join("other.log.2025-01-01");
        let unrelated_file = std::fs::File::create(&unrelated).expect("create unrelated log");
        unrelated_file
            .set_times(std::fs::FileTimes::new().set_modified(stale))
            .expect("age unrelated log");

        cleanup_old_logs(dir.path());

        let remaining: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read cleaned log dir")
            .map(|entry| entry.expect("read log entry").file_name())
            .collect();
        assert_eq!(
            remaining.len(),
            2,
            "all 112 stale TUIC logs must be removed"
        );
        assert!(recent.exists(), "recent rotated log must be retained");
        assert!(unrelated.exists(), "unrelated files must be retained");
    }

    #[test]
    fn non_blocking_file_writer_flushes_buffered_writes_on_guard_drop() {
        use std::io::Write;

        let dir = tempfile::tempdir().expect("temp log dir");
        let (mut writer, guard) = non_blocking_file_writer(dir.path());
        writer
            .write_all(b"story672-non-blocking-marker\n")
            .expect("write through non-blocking writer");
        LOG_GUARD.lock().push(guard);

        // WorkerGuard::drop (triggered by flush_logs_on_exit taking the
        // Option) sends a Shutdown message and waits (bounded, up to 1.1s)
        // for the worker thread to drain and flush before returning —
        // deterministic, not a sleep-and-hope poll.
        flush_logs_on_exit();

        let found = std::fs::read_dir(dir.path())
            .expect("read log dir")
            .filter_map(|entry| entry.ok())
            .any(|entry| {
                std::fs::read_to_string(entry.path())
                    .is_ok_and(|contents| contents.contains("story672-non-blocking-marker"))
            });
        assert!(
            found,
            "expected the write to reach a rotated log file after flush_logs_on_exit"
        );

        // A second call must be a no-op: the guard was already taken, so
        // there is nothing left to flush or drop twice.
        flush_logs_on_exit();
        assert!(
            LOG_GUARD.lock().is_empty(),
            "flush_logs_on_exit must be idempotent — guard stays taken"
        );
    }

    /// Log `lines` events through the production layer stack while nobody
    /// reads its console: a real OS pipe, which accepts writes only until its
    /// kernel buffer (64 KiB on macOS) is full — the state `make dev` reaches
    /// when the Tauri CLI stops draining the backend's stderr.
    ///
    /// Returns whether the logging thread finished within the bound, the ring
    /// buffer, and the log directory (after every writer was flushed).
    fn log_with_an_unread_console(
        lines: usize,
    ) -> (bool, Arc<Mutex<LogRingBuffer>>, tempfile::TempDir) {
        let (reader, writer) = std::io::pipe().expect("console pipe");
        let dir = tempfile::tempdir().expect("temp log dir");
        let buffer = Arc::new(Mutex::new(LogRingBuffer::new(LOG_RING_CAPACITY)));
        let (subscriber, guards) = build_subscriber(
            tracing_subscriber::EnvFilter::new("info"),
            writer,
            buffer.clone(),
            dir.path(),
        );

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let logger = std::thread::spawn(move || {
            tracing::subscriber::with_default(subscriber, || {
                for i in 0..lines {
                    tracing::info!(
                        source = "stall-test",
                        "console stall line {i:05} {}",
                        "x".repeat(120)
                    );
                }
            });
            let _ = done_tx.send(());
        });
        // The behaviour under test: 1000+ short log calls take milliseconds,
        // so ten seconds only expires when a log call is blocked.
        let finished = done_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .is_ok();
        // Closing the read end turns a blocked write into EPIPE, so a logger
        // stuck on the pre-fix code still exits and the assertion can report.
        drop(reader);
        logger.join().expect("logging thread panicked");
        drop(guards);
        (finished, buffer, dir)
    }

    /// Catches: the console layer writing to stderr synchronously from the
    /// calling thread. Once the console consumer stops reading, every thread
    /// that logs blocks in write(2) — the AppKit main thread included, which
    /// then serves no Tauri IPC. This proves the unread-pipe mechanism, not
    /// the cause of the 2026-10-09 18:22Z heartbeat gap. The 73s log silence,
    /// 218-line burst within half a second, and delayed events support that
    /// historical attribution as a hypothesis.
    #[test]
    fn a_console_that_stops_reading_does_not_block_logging() {
        // ~150 bytes a line: 2000 lines are ~300 KiB, far past a 64 KiB pipe.
        let (finished, _buffer, _dir) = log_with_an_unread_console(2_000);
        assert!(
            finished,
            "logging blocked on a console nobody reads — every thread that logs stalls with it"
        );
    }

    /// Catches: console backpressure preventing file delivery or the newest
    /// ring event. This workload fits the existing lossy file writer's queue;
    /// the ring retains only its newest LOG_RING_CAPACITY events (1000).
    #[test]
    fn a_stalled_console_still_delivers_file_lines_and_the_newest_ring_event() {
        let (finished, buffer, dir) = log_with_an_unread_console(2_000);
        assert!(finished, "logging blocked on a console nobody reads");

        let file_lines: usize = std::fs::read_dir(dir.path())
            .expect("read log dir")
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
            .map(|contents| contents.matches("console stall line").count())
            .sum();
        assert_eq!(file_lines, 2_000, "the file log must receive this workload");

        let ring = buffer.lock().get_entries(0);
        let last = ring.last().expect("ring buffer received the events");
        assert!(
            last.message.starts_with("console stall line 01999"),
            "the ring must hold the newest line, got {:?}",
            last.message
        );
    }

    /// Catches: console output that silently stops — a flush guard dropped
    /// early, or a writer that never reaches the pipe — so `make dev` shows
    /// nothing while everything else looks healthy.
    #[test]
    fn a_console_that_reads_receives_every_line_in_order() {
        use std::io::Read;

        let (mut reader, writer) = std::io::pipe().expect("console pipe");
        let dir = tempfile::tempdir().expect("temp log dir");
        let buffer = Arc::new(Mutex::new(LogRingBuffer::new(LOG_RING_CAPACITY)));
        let (subscriber, guards) = build_subscriber(
            tracing_subscriber::EnvFilter::new("info"),
            writer,
            buffer,
            dir.path(),
        );
        let drain = std::thread::spawn(move || {
            let mut out = String::new();
            reader.read_to_string(&mut out).expect("read console");
            out
        });

        tracing::subscriber::with_default(subscriber, || {
            for i in 0..500 {
                tracing::info!(source = "console-test", "console line {i:03}");
            }
        });
        // Dropping the guards flushes and closes the console's write end,
        // which ends `read_to_string`.
        drop(guards);
        let out = drain.join().expect("drain thread panicked");

        let seen: Vec<&str> = out
            .lines()
            .filter_map(|line| line.split("console line ").nth(1))
            .filter_map(|rest| rest.get(..3))
            .collect();
        let expected: Vec<String> = (0..500).map(|i| format!("{i:03}")).collect();
        assert_eq!(
            seen, expected,
            "the console must receive every line, in order"
        );
    }

    #[test]
    fn push_assigns_monotonic_ids() {
        let mut buf = LogRingBuffer::new(10);
        let id1 = buf.push("info".into(), "app".into(), "first".into(), None);
        let id2 = buf.push("warn".into(), "git".into(), "second".into(), None);
        let id3 = buf.push("error".into(), "app".into(), "third".into(), None);

        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
        assert_eq!(id3, 3);
    }

    #[test]
    fn get_entries_returns_chronological_order() {
        let mut buf = LogRingBuffer::new(10);
        buf.push("info".into(), "app".into(), "first".into(), None);
        buf.push("warn".into(), "app".into(), "second".into(), None);
        buf.push("error".into(), "app".into(), "third".into(), None);

        let entries = buf.get_entries(0);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].message, "first");
        assert_eq!(entries[1].message, "second");
        assert_eq!(entries[2].message, "third");
    }

    #[test]
    fn get_entries_with_limit() {
        let mut buf = LogRingBuffer::new(10);
        buf.push("info".into(), "app".into(), "a".into(), None);
        buf.push("info".into(), "app".into(), "b".into(), None);
        buf.push("info".into(), "app".into(), "c".into(), None);

        let entries = buf.get_entries(2);
        assert_eq!(entries.len(), 2);
        // Should return the 2 most recent
        assert_eq!(entries[0].message, "b");
        assert_eq!(entries[1].message, "c");
    }

    #[test]
    fn ring_buffer_wraps_and_drops_oldest() {
        let mut buf = LogRingBuffer::new(3);
        buf.push("info".into(), "app".into(), "a".into(), None);
        buf.push("info".into(), "app".into(), "b".into(), None);
        buf.push("info".into(), "app".into(), "c".into(), None);
        // Buffer is full, next push drops "a"
        buf.push("info".into(), "app".into(), "d".into(), None);

        assert_eq!(buf.len(), 3);
        let entries = buf.get_entries(0);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].message, "b");
        assert_eq!(entries[1].message, "c");
        assert_eq!(entries[2].message, "d");
    }

    #[test]
    fn ring_buffer_wraps_multiple_times() {
        let mut buf = LogRingBuffer::new(3);
        for i in 0..10 {
            buf.push("info".into(), "app".into(), format!("msg-{}", i), None);
        }

        assert_eq!(buf.len(), 3);
        let entries = buf.get_entries(0);
        assert_eq!(entries[0].message, "msg-7");
        assert_eq!(entries[1].message, "msg-8");
        assert_eq!(entries[2].message, "msg-9");
    }

    #[test]
    fn clear_removes_all_entries_but_keeps_next_id() {
        let mut buf = LogRingBuffer::new(10);
        buf.push("info".into(), "app".into(), "a".into(), None);
        buf.push("info".into(), "app".into(), "b".into(), None);
        assert_eq!(buf.len(), 2);

        buf.clear();
        assert_eq!(buf.len(), 0);
        assert_eq!(buf.get_entries(0).len(), 0);

        // Next push should get id=3 (not 1)
        let id = buf.push("info".into(), "app".into(), "after-clear".into(), None);
        assert_eq!(id, 3);
    }

    #[test]
    fn empty_buffer_returns_empty() {
        let buf = LogRingBuffer::new(10);
        assert_eq!(buf.len(), 0);
        assert_eq!(buf.get_entries(0).len(), 0);
        assert_eq!(buf.get_entries(5).len(), 0);
    }

    #[test]
    fn data_json_is_preserved() {
        let mut buf = LogRingBuffer::new(10);
        buf.push(
            "error".into(),
            "network".into(),
            "request failed".into(),
            Some(r#"{"status":500}"#.into()),
        );

        let entries = buf.get_entries(0);
        assert_eq!(entries[0].data_json.as_deref(), Some(r#"{"status":500}"#));
    }

    #[test]
    fn limit_larger_than_count() {
        let mut buf = LogRingBuffer::new(10);
        buf.push("info".into(), "app".into(), "only-one".into(), None);

        let entries = buf.get_entries(100);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].message, "only-one");
    }

    #[test]
    fn entry_fields_are_correct() {
        let mut buf = LogRingBuffer::new(10);
        buf.push("warn".into(), "github".into(), "rate limited".into(), None);

        let entry = &buf.get_entries(0)[0];
        assert_eq!(entry.id, 1);
        assert_eq!(entry.level, "warn");
        assert_eq!(entry.source, "github");
        assert_eq!(entry.message, "rate limited");
        assert!(entry.timestamp_ms > 0);
        assert!(entry.data_json.is_none());
    }

    // ---- Deduplication tests ----

    #[test]
    fn dedup_identical_consecutive_messages() {
        let mut buf = LogRingBuffer::new(10);
        buf.push("warn".into(), "github".into(), "poll failed".into(), None);
        buf.push("warn".into(), "github".into(), "poll failed".into(), None);
        buf.push("warn".into(), "github".into(), "poll failed".into(), None);

        // Should coalesce into a single entry with repeat_count=2
        assert_eq!(buf.len(), 1);
        let entries = buf.get_entries(0);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].message, "poll failed");
        assert_eq!(entries[0].repeat_count, 2);
    }

    #[test]
    fn dedup_resets_on_different_message() {
        let mut buf = LogRingBuffer::new(10);
        buf.push("warn".into(), "github".into(), "poll failed".into(), None);
        buf.push("warn".into(), "github".into(), "poll failed".into(), None);
        buf.push("info".into(), "app".into(), "something else".into(), None);
        buf.push("warn".into(), "github".into(), "poll failed".into(), None);

        // 3 entries: first (repeat_count=1), different, second occurrence
        assert_eq!(buf.len(), 3);
        let entries = buf.get_entries(0);
        assert_eq!(entries[0].repeat_count, 1);
        assert_eq!(entries[1].repeat_count, 0);
        assert_eq!(entries[2].repeat_count, 0);
    }

    #[test]
    fn dedup_requires_matching_level_source_message() {
        let mut buf = LogRingBuffer::new(10);
        buf.push("warn".into(), "github".into(), "poll failed".into(), None);
        // Same message but different source — no dedup
        buf.push("warn".into(), "git".into(), "poll failed".into(), None);
        // Same source+message but different level — no dedup
        buf.push("error".into(), "github".into(), "poll failed".into(), None);

        assert_eq!(buf.len(), 3);
    }

    #[test]
    fn dedup_updates_timestamp() {
        let mut buf = LogRingBuffer::new(10);
        buf.push("warn".into(), "github".into(), "poll failed".into(), None);
        let ts1 = buf.get_entries(0)[0].timestamp_ms;

        // Small delay to ensure different timestamp
        std::thread::sleep(std::time::Duration::from_millis(2));
        buf.push("warn".into(), "github".into(), "poll failed".into(), None);

        let entries = buf.get_entries(0);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].timestamp_ms >= ts1);
    }

    #[test]
    fn dedup_preserves_original_id() {
        let mut buf = LogRingBuffer::new(10);
        let id1 = buf.push("warn".into(), "github".into(), "poll failed".into(), None);
        let id2 = buf.push("warn".into(), "github".into(), "poll failed".into(), None);

        // Both return same id since it's coalesced
        assert_eq!(id1, id2);
        let entries = buf.get_entries(0);
        assert_eq!(entries[0].id, id1);
    }

    // ---- Audience classification ----

    #[test]
    fn audience_defaults_to_user() {
        let mut buf = LogRingBuffer::new(10);
        buf.push("warn".into(), "app".into(), "ui freeze".into(), None);
        assert_eq!(buf.get_entries(0)[0].audience, "user");
    }

    #[test]
    fn audience_derived_from_diagnostic_source() {
        let mut buf = LogRingBuffer::new(10);
        buf.push(
            "info".into(),
            "diagnostics".into(),
            "health snapshot".into(),
            None,
        );
        assert_eq!(buf.get_entries(0)[0].audience, "diagnostic");
    }

    #[test]
    fn explicit_audience_overrides_source_derivation() {
        let mut buf = LogRingBuffer::new(10);
        // App-sourced but explicitly diagnostic (e.g. the freeze detector).
        buf.push_with_audience(
            "warn".into(),
            "app".into(),
            "UI freeze: 1000ms".into(),
            None,
            Some("diagnostic".into()),
        );
        assert_eq!(buf.get_entries(0)[0].audience, "diagnostic");
    }

    // ---- The `log` -> `tracing` bridge ----

    /// The fields `tracing_log` attaches to the record below, verbatim from a
    /// `rustls_platform_verifier` rejection observed on 2026-09-19 — a TLS
    /// middlebox on the network serving a self-signed certificate. One ERROR
    /// per retry, forever, and none of it is about TUICommander.
    fn tls_verifier_record() -> std::collections::BTreeMap<String, String> {
        [
            (
                "log.target",
                "rustls_platform_verifier::verification::apple",
            ),
            (
                "log.module_path",
                "rustls_platform_verifier::verification::apple",
            ),
            ("log.file", "src/verification/apple.rs"),
            ("log.line", "199"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    #[test]
    fn a_bridged_log_record_is_filed_under_its_real_module_as_diagnostic() {
        let extra = tls_verifier_record();
        let (source, audience) = bridged_log_classification(BRIDGED_LOG_TARGET, Some(&extra))
            .expect("a record on the bridge target is bridged");

        assert_eq!(source, "rustls_platform_verifier::verification::apple");
        assert_eq!(audience, "diagnostic");
        // And the audience survives the push: it is explicit, so the source
        // (not a DIAGNOSTIC_SOURCES member) cannot pull it back to "user".
        let mut buf = LogRingBuffer::new(10);
        buf.push_with_audience(
            "error".into(),
            source,
            "failed to verify TLS certificate".into(),
            None,
            Some(audience),
        );
        assert_eq!(buf.get_entries(0)[0].audience, "diagnostic");
    }

    #[test]
    fn a_bridged_record_without_a_target_field_falls_back_to_its_module_path() {
        let extra: std::collections::BTreeMap<String, String> = [(
            "log.module_path".to_string(),
            "some_crate::inner".to_string(),
        )]
        .into_iter()
        .collect();

        let (source, audience) = bridged_log_classification(BRIDGED_LOG_TARGET, Some(&extra))
            .expect("a record on the bridge target is bridged");
        assert_eq!(source, "some_crate::inner");
        assert_eq!(audience, "diagnostic");
    }

    #[test]
    fn a_bridged_record_with_no_fields_at_all_is_still_diagnostic() {
        let (source, audience) = bridged_log_classification(BRIDGED_LOG_TARGET, None)
            .expect("a record on the bridge target is bridged");
        // Nothing better to call it, but the audience is the load-bearing half.
        assert_eq!(source, BRIDGED_LOG_TARGET);
        assert_eq!(audience, "diagnostic");
    }

    #[test]
    fn our_own_events_are_never_reclassified_by_the_bridge() {
        // The line the user CAN act on when the TLS flood happens. It is ours,
        // it names its own source, and it must keep the audience it chose.
        let extra: std::collections::BTreeMap<String, String> =
            [("upstream".to_string(), "slack".to_string())]
                .into_iter()
                .collect();
        assert!(bridged_log_classification("mcp_registry", Some(&extra)).is_none());
        // Not even a crate whose own target happens to start with "log".
        assert!(bridged_log_classification("logging_utils", Some(&extra)).is_none());
    }

    #[test]
    fn dedup_does_not_coalesce_across_audiences() {
        let mut buf = LogRingBuffer::new(10);
        buf.push_with_audience(
            "warn".into(),
            "app".into(),
            "x".into(),
            None,
            Some("user".into()),
        );
        buf.push_with_audience(
            "warn".into(),
            "app".into(),
            "x".into(),
            None,
            Some("diagnostic".into()),
        );
        // Same level+source+message but different audience → two distinct entries.
        assert_eq!(buf.len(), 2);
    }

    #[test]
    fn dedup_works_at_buffer_boundary() {
        let mut buf = LogRingBuffer::new(3);
        buf.push("info".into(), "app".into(), "a".into(), None);
        buf.push("info".into(), "app".into(), "b".into(), None);
        buf.push("info".into(), "app".into(), "c".into(), None);
        // Buffer full. Now push duplicate of last — should dedup, not wrap
        buf.push("info".into(), "app".into(), "c".into(), None);

        assert_eq!(buf.len(), 3);
        let entries = buf.get_entries(0);
        assert_eq!(entries[2].message, "c");
        assert_eq!(entries[2].repeat_count, 1);
    }
}
