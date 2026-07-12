//! Migration import: discover existing Claude Code / Codex CLI / Cursor / superset.sh
//! projects and their chat sessions on disk so a user moving to TUICommander doesn't
//! have to re-add every repo and lose their history.
//!
//! Claude Code stores sessions at `~/.claude/projects/<encoded-path>/<uuid>.jsonl`.
//! The encoded directory name is lossy, so the real project path is recovered from
//! the `cwd` field embedded in each session line instead.
//!
//! Codex stores rollout logs at `~/.codex/sessions/**/rollout-*.jsonl`; the project
//! path and session id come from the leading `session_meta` record.
//!
//! Cursor keeps its recently-opened folder list in a SQLite key/value store
//! (`state.vscdb`); superset.sh keeps repo paths in `~/.superset/local.db`. Both
//! contribute project paths only — no chat transcripts.
//!
//! This module only *reads* — it returns what it found. The frontend owns adding
//! the repositories (it is the single writer for the repositories store), which
//! keeps the on-disk state consistent with the app's in-memory state.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Cap how many lines we read per session file while probing for the cwd + first
/// prompt. Both normally appear near the top; this keeps a multi-MB session cheap.
const MAX_PROBE_LINES: usize = 400;

/// Max characters kept for a session title preview.
const TITLE_MAX_CHARS: usize = 100;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSession {
    /// Session id — Claude UUID (file stem) or Codex rollout id. Enables `--resume <id>`.
    pub id: String,
    pub path: String,
    pub title: String,
    /// "claude" or "codex".
    pub agent: String,
    pub modified_ms: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredProject {
    pub path: String,
    pub name: String,
    /// Agents that have sessions for this project ("claude", "codex", "cursor", "superset").
    pub agents: Vec<String>,
    pub session_count: usize,
    pub last_active_ms: i64,
    /// True if a repo already points at this path (frontend default-unchecks these).
    pub already_imported: bool,
    pub sessions: Vec<DiscoveredSession>,
}

fn modified_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn project_name_from_path(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

fn truncate_title(s: &str) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    if trimmed.chars().count() <= TITLE_MAX_CHARS {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(TITLE_MAX_CHARS).collect();
    out.push('…');
    out
}

/// Pull the first human-typed text out of a Claude `user` message value.
/// Skips meta/system injected turns (`isMeta`, command stdout, local-command tags).
fn claude_user_text(value: &serde_json::Value) -> Option<String> {
    if value.get("isMeta").and_then(|v| v.as_bool()) == Some(true) {
        return None;
    }
    let content = value.get("message")?.get("content")?;
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                    b.get("text").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty()
        || text.starts_with("<command-name>")
        || text.starts_with("<local-command-stdout>")
        || text.starts_with("Caveat:")
    {
        return None;
    }
    Some(text.to_string())
}

/// Probe a Claude session file for its cwd and a title (first real user prompt).
fn probe_claude_session(path: &Path) -> Option<(String, String)> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut cwd: Option<String> = None;
    let mut title: Option<String> = None;

    for line in reader.lines().map_while(Result::ok).take(MAX_PROBE_LINES) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if cwd.is_none()
            && let Some(c) = value.get("cwd").and_then(|v| v.as_str())
            && !c.is_empty()
        {
            cwd = Some(c.to_string());
        }
        if title.is_none()
            && value.get("type").and_then(|v| v.as_str()) == Some("user")
            && let Some(text) = claude_user_text(&value)
        {
            title = Some(truncate_title(&text));
        }
        if cwd.is_some() && title.is_some() {
            break;
        }
    }

    cwd.map(|c| (c, title.unwrap_or_default()))
}

/// Probe a Codex rollout file for its cwd, session id, and a title.
fn probe_codex_session(path: &Path) -> Option<(String, String, String)> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut cwd: Option<String> = None;
    let mut id: Option<String> = None;
    let mut title: Option<String> = None;

    for line in reader.lines().map_while(Result::ok).take(MAX_PROBE_LINES) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let payload = value.get("payload");

        if event_type == "session_meta" {
            if let Some(p) = payload {
                if cwd.is_none()
                    && let Some(c) = p.get("cwd").and_then(|v| v.as_str())
                    && !c.is_empty()
                {
                    cwd = Some(c.to_string());
                }
                if id.is_none()
                    && let Some(i) = p.get("id").and_then(|v| v.as_str())
                {
                    id = Some(i.to_string());
                }
            }
        } else if title.is_none() && event_type == "event_msg" {
            let ptype = payload
                .and_then(|p| p.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if ptype == "user_message"
                && let Some(msg) = payload
                    .and_then(|p| p.get("message"))
                    .and_then(|v| v.as_str())
                && !msg.trim().is_empty()
            {
                title = Some(truncate_title(msg));
            }
        }

        if cwd.is_some() && id.is_some() && title.is_some() {
            break;
        }
    }

    // Fall back to the UUID embedded in the filename (rollout-<ts>-<uuid>.jsonl).
    let id = id.or_else(|| {
        path.file_name()
            .and_then(|n| n.to_str())
            .and_then(crate::agent_session::extract_codex_uuid)
    });

    match (cwd, id) {
        (Some(c), Some(i)) => Some((c, i, title.unwrap_or_default())),
        _ => None,
    }
}

fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

/// Accumulates discovered sessions keyed by project path.
#[derive(Default)]
struct Grouped {
    by_path: HashMap<String, Vec<DiscoveredSession>>,
}

impl Grouped {
    fn add(&mut self, cwd: String, session: DiscoveredSession) {
        self.by_path.entry(cwd).or_default().push(session);
    }
}

fn scan_claude(grouped: &mut Grouped) {
    let Some(root) = crate::agent_session::claude_projects_dir(None) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        collect_jsonl_files(&dir, &mut files);
        for file in files {
            let Some(id) = file.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Some((cwd, title)) = probe_claude_session(&file) else {
                continue;
            };
            grouped.add(
                cwd,
                DiscoveredSession {
                    id: id.to_string(),
                    path: file.to_string_lossy().into_owned(),
                    title,
                    agent: "claude".to_string(),
                    modified_ms: modified_ms(&file),
                },
            );
        }
    }
}

fn scan_codex(grouped: &mut Grouped) {
    let Some(root) = crate::agent_session::codex_sessions_dir(None) else {
        return;
    };
    let mut files = Vec::new();
    collect_jsonl_files(&root, &mut files);
    for file in files {
        let is_rollout = file
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
            .unwrap_or(false);
        if !is_rollout {
            continue;
        }
        let Some((cwd, id, title)) = probe_codex_session(&file) else {
            continue;
        };
        grouped.add(
            cwd,
            DiscoveredSession {
                id,
                path: file.to_string_lossy().into_owned(),
                title,
                agent: "codex".to_string(),
                modified_ms: modified_ms(&file),
            },
        );
    }
}

/// Read superset.sh projects from its local SQLite store (`~/.superset/local.db`, table `projects`).
/// superset stores each repo's absolute path in `main_repo_path`; it does not keep chat transcripts
/// itself (those live in the underlying agent's dir, which scan_claude/scan_codex already cover), so
/// this only contributes repo paths. Opened read-only; any failure (no install, locked, schema drift)
/// yields an empty list rather than an error.
fn scan_superset() -> Vec<(String, i64)> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let db_path = home.join(".superset").join("local.db");
    if !db_path.is_file() {
        return Vec::new();
    }
    let conn = match rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    // last_opened_at may be stored as a number (ms) or a textual timestamp; read it leniently and
    // fall back to 0 when it isn't a plain integer.
    let mut stmt =
        match conn.prepare("SELECT main_repo_path, COALESCE(last_opened_at, 0) FROM projects") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
    let rows = stmt.query_map([], |row| {
        let path: String = row.get(0)?;
        let last_opened: i64 = row.get::<_, i64>(1).unwrap_or(0);
        Ok((path, last_opened))
    });
    match rows {
        Ok(iter) => iter
            .filter_map(Result::ok)
            .filter(|(path, _)| !path.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Decode Cursor's `history.recentlyOpenedPathsList` JSON into folder paths
/// (most-recent-first). Only `folderUri` entries count — `fileUri` entries are
/// single files, not projects. URIs are percent-encoded `file://` URLs.
fn cursor_paths_from_json(value: &str) -> Vec<String> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(value) else {
        return Vec::new();
    };
    let Some(entries) = parsed.get("entries").and_then(|e| e.as_array()) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let uri = entry.get("folderUri")?.as_str()?;
            let path = url::Url::parse(uri).ok()?.to_file_path().ok()?;
            path.to_str().map(|s| s.to_string())
        })
        .collect()
}

/// Read Cursor's recently-opened folders from its `state.vscdb` SQLite store.
/// The DB uses WAL and may be locked by a live Cursor instance: open read-only,
/// and on failure retry via an `immutable=1` URI (reads without taking locks).
/// NEVER opened read-write; any error yields an empty list rather than an error.
fn scan_cursor(db_path: &Path) -> Vec<String> {
    if !db_path.is_file() {
        return Vec::new();
    }
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI;
    let conn = match rusqlite::Connection::open_with_flags(db_path, flags) {
        Ok(c) => c,
        Err(_) => {
            let uri = format!("file:{}?immutable=1", db_path.display());
            match rusqlite::Connection::open_with_flags(uri, flags) {
                Ok(c) => c,
                Err(_) => return Vec::new(),
            }
        }
    };
    let value: String = match conn.query_row(
        "SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'",
        [],
        |row| row.get(0),
    ) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    cursor_paths_from_json(&value)
}

/// Default location of Cursor's global state DB
/// (macOS: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`).
fn cursor_state_db_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| {
        d.join("Cursor")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb")
    })
}

/// Scan Claude Code, Codex, Cursor, and superset.sh for projects + chat sessions
/// that can be imported. Sessions are grouped by their real working directory;
/// directories that no longer exist on disk are dropped (a stale path can't be
/// opened as a project).
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) fn discover_importable_projects(
    existing_paths: Vec<String>,
) -> Result<Vec<DiscoveredProject>, String> {
    let mut grouped = Grouped::default();
    scan_claude(&mut grouped);
    scan_codex(&mut grouped);

    // superset.sh and Cursor contribute project paths only (no chat sessions of their own).
    let superset: HashMap<String, i64> = scan_superset().into_iter().collect();
    let cursor: std::collections::HashSet<String> = cursor_state_db_path()
        .map(|p| scan_cursor(&p))
        .unwrap_or_default()
        .into_iter()
        .collect();

    let existing_paths: std::collections::HashSet<String> = existing_paths.into_iter().collect();

    // Union of every discovered path: those with agent sessions plus tool-only repo paths.
    let mut all_paths: std::collections::HashSet<String> =
        grouped.by_path.keys().cloned().collect();
    all_paths.extend(superset.keys().cloned());
    all_paths.extend(cursor.iter().cloned());

    let mut projects: Vec<DiscoveredProject> = all_paths
        .into_iter()
        .filter(|path| Path::new(path).is_dir())
        .map(|path| {
            let mut sessions = grouped.by_path.remove(&path).unwrap_or_default();
            // Newest sessions first.
            sessions.sort_by_key(|s| std::cmp::Reverse(s.modified_ms));
            let mut agents: Vec<String> = sessions.iter().map(|s| s.agent.clone()).collect();
            if superset.contains_key(&path) {
                agents.push("superset".to_string());
            }
            if cursor.contains(&path) {
                agents.push("cursor".to_string());
            }
            agents.sort();
            agents.dedup();
            let last_active_ms = sessions
                .first()
                .map(|s| s.modified_ms)
                .unwrap_or_else(|| superset.get(&path).copied().unwrap_or(0));
            DiscoveredProject {
                name: project_name_from_path(&path),
                already_imported: existing_paths.contains(&path),
                session_count: sessions.len(),
                last_active_ms,
                agents,
                sessions,
                path,
            }
        })
        .collect();

    // Most-recently-active projects first; importable (not-yet-added) ones win ties.
    projects.sort_by(|a, b| {
        a.already_imported
            .cmp(&b.already_imported)
            .then(b.last_active_ms.cmp(&a.last_active_ms))
    });

    Ok(projects)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ── truncate_title ──

    #[test]
    fn test_truncate_title_collapses_whitespace() {
        assert_eq!(truncate_title("  fix   the\n\tbug  "), "fix the bug");
    }

    #[test]
    fn test_truncate_title_caps_at_100_chars_with_ellipsis() {
        let long = "x".repeat(150);
        let out = truncate_title(&long);
        assert_eq!(out.chars().count(), 101); // 100 chars + ellipsis
        assert!(out.ends_with('…'));
    }

    #[test]
    fn test_truncate_title_short_untouched() {
        assert_eq!(truncate_title("hello"), "hello");
    }

    // ── claude_user_text ──

    #[test]
    fn test_claude_user_text_string_content() {
        let v = serde_json::json!({"message": {"content": "fix the bug"}});
        assert_eq!(claude_user_text(&v), Some("fix the bug".to_string()));
    }

    #[test]
    fn test_claude_user_text_array_content() {
        let v = serde_json::json!({"message": {"content": [
            {"type": "text", "text": "part one"},
            {"type": "image", "source": {}},
            {"type": "text", "text": "part two"}
        ]}});
        assert_eq!(claude_user_text(&v), Some("part one part two".to_string()));
    }

    #[test]
    fn test_claude_user_text_skips_meta_and_injected() {
        let meta = serde_json::json!({"isMeta": true, "message": {"content": "hi"}});
        assert_eq!(claude_user_text(&meta), None);
        let cmd =
            serde_json::json!({"message": {"content": "<command-name>/clear</command-name>"}});
        assert_eq!(claude_user_text(&cmd), None);
        let stdout = serde_json::json!({"message": {"content": "<local-command-stdout>ok</local-command-stdout>"}});
        assert_eq!(claude_user_text(&stdout), None);
        let caveat = serde_json::json!({"message": {"content": "Caveat: injected context"}});
        assert_eq!(claude_user_text(&caveat), None);
        let empty = serde_json::json!({"message": {"content": "   "}});
        assert_eq!(claude_user_text(&empty), None);
    }

    // ── probe_claude_session ──

    #[test]
    fn test_probe_claude_session_skips_meta_and_command_lines() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("session.jsonl");
        let lines = [
            r#"{"type":"user","isMeta":true,"cwd":"/Users/k/proj","message":{"content":"meta line"}}"#,
            r#"{"type":"user","cwd":"/Users/k/proj","message":{"content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"user","cwd":"/Users/k/proj","message":{"content":"real string prompt"}}"#,
        ];
        fs::write(&file, lines.join("\n")).unwrap();
        assert_eq!(
            probe_claude_session(&file),
            Some((
                "/Users/k/proj".to_string(),
                "real string prompt".to_string()
            ))
        );
    }

    #[test]
    fn test_probe_claude_session_array_content() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("session.jsonl");
        let lines = [
            r#"{"type":"summary","cwd":"/Users/k/proj"}"#,
            r#"{"type":"user","message":{"content":[{"type":"text","text":"array prompt"}]}}"#,
        ];
        fs::write(&file, lines.join("\n")).unwrap();
        assert_eq!(
            probe_claude_session(&file),
            Some(("/Users/k/proj".to_string(), "array prompt".to_string()))
        );
    }

    #[test]
    fn test_probe_claude_session_empty_file_returns_none() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("empty.jsonl");
        fs::write(&file, "").unwrap();
        assert_eq!(probe_claude_session(&file), None);
    }

    // ── probe_codex_session ──

    #[test]
    fn test_probe_codex_session_meta_and_user_message() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("rollout-2026-01-01T00-00-00-x.jsonl");
        let lines = [
            r#"{"type":"session_meta","payload":{"id":"af467730-5e79-49d9-8a17-ebd94c99f262","cwd":"/Users/k/proj"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"do the thing"}}"#,
        ];
        fs::write(&file, lines.join("\n")).unwrap();
        assert_eq!(
            probe_codex_session(&file),
            Some((
                "/Users/k/proj".to_string(),
                "af467730-5e79-49d9-8a17-ebd94c99f262".to_string(),
                "do the thing".to_string()
            ))
        );
    }

    #[test]
    fn test_probe_codex_session_filename_uuid_fallback() {
        let dir = TempDir::new().unwrap();
        let uuid = "af467730-5e79-49d9-8a17-ebd94c99f262";
        let file = dir
            .path()
            .join(format!("rollout-2026-01-01T00-00-00-{uuid}.jsonl"));
        // session_meta without an id — the id must come from the filename, and it
        // must be the FULL uuid, not just the last dash-separated segment.
        let lines = [
            r#"{"type":"session_meta","payload":{"cwd":"/Users/k/proj"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}"#,
        ];
        fs::write(&file, lines.join("\n")).unwrap();
        assert_eq!(
            probe_codex_session(&file),
            Some((
                "/Users/k/proj".to_string(),
                uuid.to_string(),
                "hi".to_string()
            ))
        );
    }

    // ── cursor_paths_from_json ──

    #[test]
    fn test_cursor_paths_from_json_folder_uris_only_percent_decoded() {
        let json = r#"{"entries":[{"folderUri":"file:///Users/k/Desktop/personal%20project/x"},{"fileUri":"file:///Users/k/a.txt"},{"folderUri":"file:///Users/k/repo2"}]}"#;
        assert_eq!(
            cursor_paths_from_json(json),
            vec![
                "/Users/k/Desktop/personal project/x".to_string(),
                "/Users/k/repo2".to_string()
            ]
        );
    }

    #[test]
    fn test_cursor_paths_from_json_garbage_returns_empty() {
        assert!(cursor_paths_from_json("not json").is_empty());
        assert!(cursor_paths_from_json(r#"{"entries": 42}"#).is_empty());
        assert!(cursor_paths_from_json(r#"{}"#).is_empty());
    }

    // ── scan_cursor ──

    #[test]
    fn test_scan_cursor_reads_state_db() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("state.vscdb");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute("CREATE TABLE ItemTable (key TEXT, value TEXT)", [])
            .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES ('history.recentlyOpenedPathsList', ?1)",
            [r#"{"entries":[{"folderUri":"file:///Users/k/repo1"}]}"#],
        )
        .unwrap();
        drop(conn);
        assert_eq!(scan_cursor(&db_path), vec!["/Users/k/repo1".to_string()]);
    }

    #[test]
    fn test_scan_cursor_missing_db_returns_empty() {
        assert!(scan_cursor(Path::new("/nonexistent/state.vscdb")).is_empty());
    }

    // ── scan_superset ──

    #[test]
    fn test_superset_query_shape() {
        // scan_superset() reads a fixed ~/.superset path; exercise the same query
        // against a fixture DB to lock the expected schema.
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("local.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE projects (main_repo_path TEXT, last_opened_at INTEGER)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projects (main_repo_path, last_opened_at) VALUES ('/Users/k/repo', 1234), ('', 5)",
            [],
        )
        .unwrap();
        let mut stmt = conn
            .prepare("SELECT main_repo_path, COALESCE(last_opened_at, 0) FROM projects")
            .unwrap();
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1).unwrap_or(0)))
            })
            .unwrap()
            .filter_map(Result::ok)
            .filter(|(path, _)| !path.is_empty())
            .collect();
        assert_eq!(rows, vec![("/Users/k/repo".to_string(), 1234)]);
    }

    // ── project_name_from_path ──

    #[test]
    fn test_project_name_from_path() {
        assert_eq!(project_name_from_path("/Users/k/repo"), "repo");
        assert_eq!(project_name_from_path("/Users/k/repo/"), "repo");
        assert_eq!(project_name_from_path("C:\\Users\\k\\repo"), "repo");
    }
}
