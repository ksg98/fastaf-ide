use chrono::{DateTime, Utc};
use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelEvent {
    pub id: i64,
    pub timestamp: DateTime<Utc>,
    pub tunnel_id: String,
    pub kind: EventKind,
    pub detail: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Started,
    Connected,
    Disconnected,
    Error,
    Retry,
    Stopped,
}

pub struct AuditLog {
    conn: Connection,
}

impl AuditLog {
    /// Open (or create) the audit database at `db_path`, enable WAL mode, and
    /// ensure the schema exists.
    pub fn open(db_path: &Path) -> Result<Self> {
        let conn = Connection::open(db_path)?;

        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tunnel_events (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                tunnel_id TEXT    NOT NULL,
                kind      TEXT    NOT NULL,
                detail    TEXT    NOT NULL DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS idx_tunnel_events_tunnel_id
                ON tunnel_events(tunnel_id);
            CREATE INDEX IF NOT EXISTS idx_tunnel_events_timestamp
                ON tunnel_events(timestamp);",
        )?;

        Ok(Self { conn })
    }

    /// Insert a new event and return the `rowid` of the inserted row.
    pub fn insert(
        &self,
        tunnel_id: &str,
        kind: EventKind,
        detail: serde_json::Value,
    ) -> Result<i64> {
        let kind_str = serde_json::to_string(&kind)
            .map(|s| s.trim_matches('"').to_owned())
            .unwrap_or_else(|_| "unknown".to_owned());
        let detail_str = detail.to_string();

        self.conn.execute(
            "INSERT INTO tunnel_events (tunnel_id, kind, detail) VALUES (?1, ?2, ?3)",
            params![tunnel_id, kind_str, detail_str],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Return the most recent `limit` events for `tunnel_id`, newest first.
    pub fn query_by_tunnel(&self, tunnel_id: &str, limit: usize) -> Result<Vec<TunnelEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, timestamp, tunnel_id, kind, detail
             FROM tunnel_events
             WHERE tunnel_id = ?1
             ORDER BY id DESC
             LIMIT ?2",
        )?;

        let rows = stmt.query_map(params![tunnel_id, limit as i64], row_to_event)?;
        rows.collect()
    }

    /// Return all events whose timestamp falls within `[from, to]`.
    pub fn query_by_time_range(
        &self,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
    ) -> Result<Vec<TunnelEvent>> {
        let from_str = from.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let to_str = to.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

        let mut stmt = self.conn.prepare(
            "SELECT id, timestamp, tunnel_id, kind, detail
             FROM tunnel_events
             WHERE timestamp >= ?1 AND timestamp <= ?2
             ORDER BY id ASC",
        )?;

        let rows = stmt.query_map(params![from_str, to_str], row_to_event)?;
        rows.collect()
    }

    /// Delete events older than `max_age_days` days and return the number deleted.
    pub fn rotate(&self, max_age_days: u32) -> Result<usize> {
        let age_spec = format!("-{max_age_days} days");
        let count = self.conn.execute(
            "DELETE FROM tunnel_events WHERE timestamp < datetime('now', ?1)",
            params![age_spec],
        )?;
        Ok(count)
    }
}

/// Map a SQLite row to a [`TunnelEvent`].
fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<TunnelEvent> {
    let id: i64 = row.get(0)?;
    let timestamp_str: String = row.get(1)?;
    let tunnel_id: String = row.get(2)?;
    let kind_str: String = row.get(3)?;
    let detail_str: String = row.get(4)?;

    let timestamp = DateTime::parse_from_rfc3339(&timestamp_str)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|e| {
            tracing::warn!(source = "audit", row_id = id, raw = %timestamp_str, error = %e, "Corrupt audit timestamp, substituting now()");
            Utc::now()
        });

    let kind: EventKind =
        serde_json::from_value(serde_json::Value::String(kind_str.clone())).unwrap_or_else(|e| {
            tracing::warn!(source = "audit", row_id = id, raw = %kind_str, error = %e, "Unknown audit event kind, substituting Error");
            EventKind::Error
        });

    let detail: serde_json::Value =
        serde_json::from_str(&detail_str).unwrap_or_else(|e| {
            tracing::warn!(source = "audit", row_id = id, raw = %detail_str, error = %e, "Corrupt audit detail JSON, substituting null");
            serde_json::Value::Null
        });

    Ok(TunnelEvent {
        id,
        timestamp,
        tunnel_id,
        kind,
        detail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use std::env;

    fn temp_db() -> (AuditLog, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = AuditLog::open(&dir.path().join("audit.db")).expect("open");
        (db, dir)
    }

    // Fallback when tempfile crate is somehow unavailable — unused in practice
    // because Cargo.toml includes tempfile = "3".
    #[allow(dead_code)]
    fn temp_db_fallback() -> AuditLog {
        let path = env::temp_dir().join(format!("tuic_audit_test_{}.db", std::process::id()));
        AuditLog::open(&path).expect("open")
    }

    #[test]
    fn insert_and_query_by_tunnel() {
        let (log, _dir) = temp_db();
        let id = log
            .insert("t1", EventKind::Started, serde_json::json!({"port": 22}))
            .expect("insert");
        assert!(id > 0);

        let events = log.query_by_tunnel("t1", 10).expect("query");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tunnel_id, "t1");
        assert_eq!(events[0].kind, EventKind::Started);
        assert_eq!(events[0].detail["port"], 22);
    }

    #[test]
    fn query_by_time_range_filters_correctly() {
        let (log, _dir) = temp_db();

        // Insert an event (uses DB default timestamp = now).
        log.insert("t2", EventKind::Connected, serde_json::json!({}))
            .expect("insert");

        let now = Utc::now();
        let from = now - Duration::minutes(1);
        let to = now + Duration::minutes(1);

        let events = log.query_by_time_range(from, to).expect("query");
        assert!(
            !events.is_empty(),
            "should find the recently inserted event"
        );

        // Range entirely in the past should return nothing.
        let old_from = now - Duration::days(10);
        let old_to = now - Duration::days(9);
        let old_events = log.query_by_time_range(old_from, old_to).expect("query");
        assert!(old_events.is_empty(), "should be empty for old range");
    }

    #[test]
    fn query_limit_returns_most_recent() {
        let (log, _dir) = temp_db();

        for i in 0..10_i64 {
            log.insert("t3", EventKind::Retry, serde_json::json!({"seq": i}))
                .expect("insert");
        }

        let events = log.query_by_tunnel("t3", 5).expect("query");
        assert_eq!(events.len(), 5, "should return exactly 5 events");

        // Newest first — seq 9 should be first.
        assert_eq!(events[0].detail["seq"], 9);
    }

    #[test]
    fn rotation_deletes_old_events() {
        let (log, _dir) = temp_db();

        // Insert an "old" event by manipulating the timestamp directly.
        log.conn
            .execute(
                "INSERT INTO tunnel_events (timestamp, tunnel_id, kind, detail)
                 VALUES (datetime('now', '-40 days'), 't4', 'started', '{}')",
                [],
            )
            .expect("insert old");

        // Insert a recent event.
        log.insert("t4", EventKind::Stopped, serde_json::json!({}))
            .expect("insert recent");

        let deleted = log.rotate(30).expect("rotate");
        assert_eq!(deleted, 1, "should delete exactly the one old event");

        let remaining = log.query_by_tunnel("t4", 10).expect("query");
        assert_eq!(remaining.len(), 1, "one recent event should remain");
    }

    /// Performance test: 10 000 inserts must complete in under 500 ms.
    /// Marked #[ignore] to avoid flakiness in slow CI environments.
    #[test]
    #[ignore = "performance test — run explicitly with `cargo test -- --ignored`"]
    fn bulk_insert_performance() {
        let (log, _dir) = temp_db();
        let start = std::time::Instant::now();

        for i in 0..10_000_i64 {
            log.insert("perf", EventKind::Connected, serde_json::json!({"i": i}))
                .expect("insert");
        }

        let elapsed = start.elapsed();
        assert!(
            elapsed.as_millis() < 500,
            "10 000 inserts took {elapsed:?}, expected < 500 ms"
        );
    }

    #[test]
    fn wal_mode_is_active() {
        let (log, _dir) = temp_db();
        let mode: String = log
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .expect("pragma");
        assert_eq!(mode, "wal");
    }

    #[test]
    fn empty_query_returns_empty_vec() {
        let (log, _dir) = temp_db();
        let events = log
            .query_by_tunnel("nonexistent", 10)
            .expect("query should not panic");
        assert!(events.is_empty());

        let now = Utc::now();
        let range = log
            .query_by_time_range(now - Duration::hours(1), now)
            .expect("time range query should not panic");
        assert!(range.is_empty());
    }
}
