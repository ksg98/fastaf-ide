//! Bounded, numeric-only stall evidence. Disk I/O runs on a non-blocking writer's worker.

use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tracing_appender::non_blocking::{NonBlocking, NonBlockingBuilder, WorkerGuard};

const FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const METRICS: &[&str] = &[
    "total_ms",
    "body_ms",
    "flush_ms",
    "repo_count",
    "worktree_count",
    "store_worktree_count",
    "response_bytes",
    "gap_ms",
    "silent_secs",
    "last_heartbeat_received_ms",
    "backend_observed_ms",
];

#[derive(Debug, Serialize)]
struct Record {
    schema_version: u8,
    timestamp_ms: i64,
    kind: &'static str,
    metrics: BTreeMap<&'static str, u64>,
}

/// Classify by fixed producer prefixes, but never persist a message or arbitrary data.
fn record(source: &str, message: &str, data: Option<&str>) -> Option<Record> {
    let kind = match source {
        "app" if message.starts_with("SLOW git.refreshBatch:") => "git_refresh",
        "app" if message.starts_with("SLOW git.statsBatch:") => "git_stats",
        "app" if message.starts_with("UI freeze:") => "ui_freeze",
        "diagnostics" if message.starts_with("Frontend unresponsive:") => "heartbeat_gap",
        _ => return None,
    };
    let mut metrics = BTreeMap::new();
    // Avoid parsing an arbitrary large log payload on the producer's thread.
    if let Some(data) = data.filter(|s| s.len() <= 4096)
        && let Ok(serde_json::Value::Object(values)) = serde_json::from_str(data)
    {
        for &key in METRICS {
            let Some(value) = values.get(key) else {
                continue;
            };
            // tracing's visitor encodes numbers as strings; frontend JSON uses numbers.
            let number = value.as_u64().or_else(|| value.as_str()?.parse().ok());
            if let Some(number) = number.filter(|n| *n <= MAX_SAFE_INTEGER) {
                metrics.insert(key, number);
            }
        }
    }
    Some(Record {
        schema_version: 1,
        timestamp_ms: chrono::Utc::now().timestamp_millis(),
        kind,
        metrics,
    })
}

pub(crate) fn capture(writer: &mut NonBlocking, source: &str, message: &str, data: Option<&str>) {
    let Some(record) = record(source, message, data) else {
        return;
    };
    if let Ok(mut bytes) = serde_json::to_vec(&record) {
        bytes.push(b'\n');
        // One queue item per record, never one item per serde serialization fragment.
        let _ = writer.write_all(&bytes);
    }
}

pub(crate) fn writer(directory: &Path) -> (NonBlocking, WorkerGuard) {
    NonBlockingBuilder::default()
        .buffered_lines_limit(128)
        .lossy(true)
        .thread_name("stall-journal")
        .finish(RotatingWriter {
            directory: directory.to_owned(),
            limit: FILE_BYTES,
        })
}

/// Open/close on each selected event: no file access on the logging thread, and no
/// buffered file handle that can hide the last flushed record across a restart.
struct RotatingWriter {
    directory: PathBuf,
    limit: u64,
}

impl Write for RotatingWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "journal record exceeds file limit",
            ));
        }
        let path = self.directory.join("stall-journal.jsonl");
        let size = match std::fs::metadata(&path) {
            Ok(meta) => meta.len(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error),
        };
        if size + bytes.len() as u64 > self.limit {
            let previous = self.directory.join("stall-journal.previous.jsonl");
            match std::fs::remove_file(&previous) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            std::fs::rename(&path, previous)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        file.write_all(bytes)?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(()) // Each write closes its unbuffered File.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allowlisted_numeric_metadata_reaches_disk() {
        // Catches: arbitrary messages, paths, breadcrumbs or nested payloads leaking to disk.
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let (mut writer, guard) = writer(dir.path());
        capture(
            &mut writer,
            "app",
            "UI freeze: secret/path",
            Some(
                r#"{"gap_ms":1234,"label":"secret","payload":{"secret":42},"repo_count":-1,"body_ms":1.5,"response_bytes":9007199254740992}"#,
            ),
        );
        capture(&mut writer, "unrelated", "UI freeze: secret", None);
        drop(guard);
        let text = std::fs::read_to_string(dir.path().join("stall-journal.jsonl")).unwrap();
        let row: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(row["kind"], "ui_freeze");
        assert_eq!(row["metrics"], serde_json::json!({"gap_ms":1234}));
        assert!(!text.contains("secret"));
    }

    #[test]
    fn rotation_bounds_both_files_and_reopen_keeps_complete_records() {
        // Catches: append-only evidence growing without limit, or startup truncating it.
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let line = b"{\"schema_version\":1}\n";
        let limit = (line.len() * 2) as u64;
        let mut writer = RotatingWriter {
            directory: dir.path().to_owned(),
            limit,
        };
        for _ in 0..7 {
            writer.write_all(line).unwrap();
        }
        drop(writer);
        let mut reopened = RotatingWriter {
            directory: dir.path().to_owned(),
            limit,
        };
        reopened.write_all(line).unwrap();
        for name in ["stall-journal.jsonl", "stall-journal.previous.jsonl"] {
            let bytes = std::fs::read(dir.path().join(name)).unwrap();
            assert_eq!(bytes.len() as u64, limit);
            for row in bytes.split(|b| *b == b'\n').filter(|row| !row.is_empty()) {
                assert!(serde_json::from_slice::<serde_json::Value>(row).is_ok());
            }
        }
        assert!(reopened.write(&vec![b'x'; limit as usize + 1]).is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn repeated_reports_and_tracing_number_strings_are_not_lost_to_ring_dedup() {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let (mut writer, guard) = writer(dir.path());
        for _ in 0..2 {
            capture(
                &mut writer,
                "diagnostics",
                "Frontend unresponsive: 31s",
                Some(
                    r#"{"silent_secs":"31","last_heartbeat_received_ms":"1234","backend_observed_ms":"3234"}"#,
                ),
            );
        }
        drop(guard);
        let text = std::fs::read_to_string(dir.path().join("stall-journal.jsonl")).unwrap();
        let rows: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["metrics"]["silent_secs"], 31);
        assert_eq!(rows[0]["metrics"]["last_heartbeat_received_ms"], 1234);
    }
}
