//! Filesystem API for plugins.
//!
//! Provides sandboxed read, list, and watch operations restricted to paths
//! within the user's home directory. Plugins declare `fs:read`, `fs:list`,
//! or `fs:watch` capabilities in their manifest to use these commands.

use crate::AppState;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::Arc;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter, State};

/// Maximum file size readable via plugin_read_file (10 MB).
const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/// Test-only serialization lock for tests that use filesystem operations.
/// Tests that set a home dir override acquire this lock first to prevent
/// parallel interference with tests that use the real home dir.
#[cfg(test)]
static FS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Test-only override for the home directory used by path validation.
/// Uses RwLock to avoid deadlock (write tests set it, effective_home_dir reads it).
#[cfg(test)]
static HOME_DIR_OVERRIDE: std::sync::RwLock<Option<PathBuf>> = std::sync::RwLock::new(None);

/// Set home dir override. Returns a guard that clears the override on drop
/// and holds the serialization lock.
#[cfg(test)]
fn set_home_dir_override(dir: PathBuf) -> impl Drop {
    let fs_guard = FS_TEST_LOCK.lock().unwrap();
    *HOME_DIR_OVERRIDE.write().unwrap() = Some(dir);
    struct Guard(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);
    impl Drop for Guard {
        fn drop(&mut self) {
            *HOME_DIR_OVERRIDE.write().unwrap() = None;
        }
    }
    Guard(fs_guard)
}

fn effective_home_dir() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(dir) = HOME_DIR_OVERRIDE.read().unwrap().clone() {
        return dir
            .canonicalize()
            .map_err(|e| format!("Failed to resolve home override: {e}"));
    }
    dirs::home_dir().ok_or("Cannot determine home directory".into())
}

/// Resolve and validate that a path is within $HOME.
/// Returns the canonicalized path on success.
fn validate_within_home(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("Path is empty".into());
    }

    let path = PathBuf::from(crate::cli::expand_tilde(raw));
    if !path.is_absolute() {
        return Err("Path must be absolute".into());
    }

    // Canonicalize resolves symlinks and .. components
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {e}"))?;

    let home = effective_home_dir()?;

    if !canonical.starts_with(&home) {
        return Err("Path must be within the user's home directory".into());
    }

    Ok(canonical)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Read a file's content as UTF-8 text.
/// Validates the path is within $HOME, enforces a 10 MB size limit.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn plugin_read_file(
    path: String,
    plugin_id: String,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<String, String> {
    plugin_read_file_impl(&state, path, plugin_id).await
}

/// Run a blocking filesystem closure on Tokio's blocking pool, flattening the
/// JoinError into the closure's own `Result<T, String>`. Keeps the synchronous
/// `std::fs` calls off the async worker threads.
async fn spawn_blocking_fs<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("fs task failed: {e}"))?
}

pub(crate) async fn plugin_read_file_impl(
    state: &std::sync::Arc<crate::AppState>,
    path: String,
    plugin_id: String,
) -> Result<String, String> {
    crate::plugins::check_plugin_capability(state, &plugin_id, "fs:read")?;
    spawn_blocking_fs(move || {
        let canonical = validate_within_home(&path)?;

        // Check file size before reading
        let metadata =
            std::fs::metadata(&canonical).map_err(|e| format!("Failed to stat file: {e}"))?;

        if !metadata.is_file() {
            return Err("Path is not a file".into());
        }

        if metadata.len() > MAX_FILE_SIZE {
            return Err(format!(
                "File exceeds maximum size ({} bytes > {} bytes)",
                metadata.len(),
                MAX_FILE_SIZE
            ));
        }

        std::fs::read_to_string(&canonical).map_err(|e| format!("Failed to read file: {e}"))
    })
    .await
}

/// List filenames in a directory, optionally filtered by a glob pattern.
/// Returns filenames only (not full paths). Validates path is within $HOME.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn plugin_list_directory(
    path: String,
    pattern: Option<String>,
    sort_by: Option<String>,
    plugin_id: String,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<Vec<String>, String> {
    plugin_list_directory_impl(&state, path, pattern, sort_by, plugin_id).await
}

pub(crate) async fn plugin_list_directory_impl(
    state: &std::sync::Arc<crate::AppState>,
    path: String,
    pattern: Option<String>,
    sort_by: Option<String>,
    plugin_id: String,
) -> Result<Vec<String>, String> {
    crate::plugins::check_plugin_capability(state, &plugin_id, "fs:list")?;
    plugin_list_directory_inner(path, pattern, sort_by).await
}

async fn plugin_list_directory_inner(
    path: String,
    pattern: Option<String>,
    sort_by: Option<String>,
) -> Result<Vec<String>, String> {
    spawn_blocking_fs(move || {
        let canonical = validate_within_home(&path)?;

        if !canonical.is_dir() {
            return Err("Path is not a directory".into());
        }

        let glob_pattern = pattern
            .as_deref()
            .map(|p| glob::Pattern::new(p).map_err(|e| format!("Invalid glob pattern: {e}")))
            .transpose()?;

        let entries =
            std::fs::read_dir(&canonical).map_err(|e| format!("Failed to read directory: {e}"))?;

        // Sort mode: "name" (default, alphabetical) or "mtime" (newest first).
        // mtime mode enables plugins to efficiently find recently-modified files
        // without scanning every entry (e.g. cache-keepalive picking the active JSONL).
        let sort_mode = sort_by.as_deref().unwrap_or("name");
        let mut items: Vec<(String, std::time::SystemTime)> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(ref pat) = glob_pattern
                && !pat.matches(&name)
            {
                continue;
            }
            let mtime = if sort_mode == "mtime" {
                entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH)
            } else {
                std::time::UNIX_EPOCH
            };
            items.push((name, mtime));
        }

        match sort_mode {
            "mtime" => items.sort_by_key(|a| std::cmp::Reverse(a.1)),
            _ => items.sort_by(|a, b| a.0.cmp(&b.0)),
        }
        Ok(items.into_iter().map(|(n, _)| n).collect())
    })
    .await
}

/// Read the last `max_bytes` of a file as UTF-8 text.
/// Seeks to `file_size - max_bytes`, then skips to the next newline to avoid
/// partial lines. If the file is smaller than `max_bytes`, reads the entire file.
/// Validates path is within $HOME, same as plugin_read_file.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn plugin_read_file_tail(
    path: String,
    max_bytes: u64,
    plugin_id: String,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<String, String> {
    plugin_read_file_tail_impl(&state, path, max_bytes, plugin_id).await
}

pub(crate) async fn plugin_read_file_tail_impl(
    state: &std::sync::Arc<crate::AppState>,
    path: String,
    max_bytes: u64,
    plugin_id: String,
) -> Result<String, String> {
    crate::plugins::check_plugin_capability(state, &plugin_id, "fs:read")?;
    plugin_read_file_tail_inner(path, max_bytes).await
}

async fn plugin_read_file_tail_inner(path: String, max_bytes: u64) -> Result<String, String> {
    // Clamp the tail window so a caller can't force a huge heap reservation
    // (the HTTP route exposes this without plugin-JS bounds). Matches the 10 MB
    // whole-file ceiling in `plugin_read_file_impl`.
    const MAX_TAIL_BYTES: u64 = 10 * 1024 * 1024;
    let max_bytes = max_bytes.min(MAX_TAIL_BYTES);

    spawn_blocking_fs(move || {
        use std::io::{Read, Seek, SeekFrom};

        let canonical = validate_within_home(&path)?;

        let metadata =
            std::fs::metadata(&canonical).map_err(|e| format!("Failed to stat file: {e}"))?;

        if !metadata.is_file() {
            return Err("Path is not a file".into());
        }

        let file_size = metadata.len();

        // If the file fits within max_bytes, read the whole thing
        if file_size <= max_bytes {
            return std::fs::read_to_string(&canonical)
                .map_err(|e| format!("Failed to read file: {e}"));
        }

        let mut file =
            std::fs::File::open(&canonical).map_err(|e| format!("Failed to open file: {e}"))?;

        let seek_pos = file_size - max_bytes;
        file.seek(SeekFrom::Start(seek_pos))
            .map_err(|e| format!("Failed to seek: {e}"))?;

        let mut buf = Vec::with_capacity(max_bytes as usize);
        file.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read file tail: {e}"))?;

        let text = String::from_utf8_lossy(&buf);

        // Skip partial first line (find first newline and skip past it)
        match text.find('\n') {
            Some(idx) => Ok(text[idx + 1..].to_string()),
            None => Ok(text.to_string()),
        }
    })
    .await
}

/// Start watching a path for filesystem changes.
/// Returns a watch_id (UUID) that can be used with plugin_unwatch.
/// Emits `plugin-fs-change-{plugin_id}` Tauri events on changes.
// DESKTOP-ONLY (HTTP parity): event delivery to plugins needs AppHandle/WS — out of scope
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn plugin_watch_path(
    path: String,
    plugin_id: String,
    recursive: Option<bool>,
    debounce_ms: Option<u64>,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<String, String> {
    crate::plugins::check_plugin_capability(&state, &plugin_id, "fs:watch")?;
    let canonical = validate_within_home(&path)?;

    let watch_id = uuid::Uuid::new_v4().to_string();
    let event_name = format!("plugin-fs-change-{plugin_id}");
    let debounce = std::time::Duration::from_millis(debounce_ms.unwrap_or(300));
    let mode = if recursive.unwrap_or(false) {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };

    // Channel for debouncing: collect events, emit after quiet period
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();

    let mut watcher = RecommendedWatcher::new(tx, notify::Config::default())
        .map_err(|e| format!("Failed to create watcher: {e}"))?;

    watcher
        .watch(&canonical, mode)
        .map_err(|e| format!("Failed to watch path: {e}"))?;

    // Store watcher in AppState for cleanup
    let wid = watch_id.clone();
    state
        .plugin_watchers
        .insert(wid.clone(), (plugin_id.clone(), watcher));

    // Spawn debounce thread that emits Tauri events
    let app_handle = app.clone();
    std::thread::spawn(move || {
        debounce_loop(rx, debounce, &event_name, &app_handle);
    });

    Ok(watch_id)
}

/// Stop watching a previously registered path.
// DESKTOP-ONLY (HTTP parity): event delivery to plugins needs AppHandle/WS — out of scope
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn plugin_unwatch(
    watch_id: String,
    _plugin_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    // Remove drops the watcher, which stops the notify thread
    match state.plugin_watchers.remove(&watch_id) {
        Some(_) => Ok(()),
        None => Err(format!("Watch ID not found: {watch_id}")),
    }
}

// ---------------------------------------------------------------------------
// Debounce loop
// ---------------------------------------------------------------------------

#[cfg(feature = "desktop")]
/// Collect notify events and emit batched Tauri events after a quiet period.
fn debounce_loop(
    rx: std::sync::mpsc::Receiver<notify::Result<Event>>,
    debounce: std::time::Duration,
    event_name: &str,
    app: &AppHandle,
) {
    use std::collections::HashMap;

    loop {
        // Block until first event (or channel close)
        let first = match rx.recv() {
            Ok(Ok(event)) => event,
            Ok(Err(e)) => {
                crate::app_logger::log_via_handle(
                    app,
                    "warn",
                    "plugin",
                    &format!("[plugin_fs] Watcher error: {e}"),
                );
                continue;
            }
            Err(_) => break, // Channel closed — watcher was dropped
        };

        // Collect events during the debounce window
        let mut events_by_path: HashMap<PathBuf, String> = HashMap::new();
        classify_event(&first, &mut events_by_path);

        let deadline = std::time::Instant::now() + debounce;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(Ok(event)) => classify_event(&event, &mut events_by_path),
                Ok(Err(e)) => crate::app_logger::log_via_handle(
                    app,
                    "warn",
                    "plugin",
                    &format!("[plugin_fs] Watcher error: {e}"),
                ),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }

        // Emit batched changes
        let changes: Vec<serde_json::Value> = events_by_path
            .into_iter()
            .map(|(path, kind)| {
                serde_json::json!({
                    "type": kind,
                    "path": path.to_string_lossy(),
                })
            })
            .collect();

        if !changes.is_empty() {
            let _ = app.emit(event_name, changes);
        }
    }
}

/// Map a notify event to a simplified type string and collect by path.
fn classify_event(event: &Event, map: &mut std::collections::HashMap<PathBuf, String>) {
    let kind = match event.kind {
        notify::EventKind::Create(_) => "create",
        notify::EventKind::Modify(_) => "modify",
        notify::EventKind::Remove(_) => "delete",
        _ => return,
    };

    for path in &event.paths {
        map.insert(path.clone(), kind.to_string());
    }
}

// ---------------------------------------------------------------------------
// Write & Rename (capability-gated: fs:write, fs:rename)
// ---------------------------------------------------------------------------

/// Maximum content size writable via plugin_write_file (10 MB).
const MAX_WRITE_SIZE: usize = 10 * 1024 * 1024;

/// Write content to a file within $HOME.
/// Creates parent directories if needed. Refuses to overwrite directories.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn plugin_write_file(
    path: String,
    content: String,
    plugin_id: String,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<(), String> {
    plugin_write_file_impl(&state, path, content, plugin_id).await
}

pub(crate) async fn plugin_write_file_impl(
    state: &std::sync::Arc<crate::AppState>,
    path: String,
    content: String,
    plugin_id: String,
) -> Result<(), String> {
    crate::plugins::check_plugin_capability(state, &plugin_id, "fs:write")?;
    plugin_write_file_inner(path, content).await
}

/// Core write logic, separated from the Tauri command wrapper for testability.
async fn plugin_write_file_inner(path: String, content: String) -> Result<(), String> {
    if content.len() > MAX_WRITE_SIZE {
        return Err(format!(
            "Content exceeds maximum size ({} bytes > {} bytes)",
            content.len(),
            MAX_WRITE_SIZE
        ));
    }

    let file_path = PathBuf::from(&path);
    if !file_path.is_absolute() {
        return Err("Path must be absolute".into());
    }

    let home = effective_home_dir()?;

    if file_path.exists() {
        let canonical = file_path
            .canonicalize()
            .map_err(|e| format!("Failed to resolve path: {e}"))?;
        if !canonical.starts_with(&home) {
            return Err("Path must be within the user's home directory".into());
        }
        if canonical.is_dir() {
            return Err("Cannot overwrite a directory".into());
        }
    } else {
        let parent = file_path
            .parent()
            .ok_or("Cannot determine parent directory")?;
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent directories: {e}"))?;
        }
        let canonical_parent = parent
            .canonicalize()
            .map_err(|e| format!("Failed to resolve parent path: {e}"))?;
        if !canonical_parent.starts_with(&home) {
            return Err("Path must be within the user's home directory".into());
        }
    }

    std::fs::write(&file_path, &content).map_err(|e| format!("Failed to write file: {e}"))
}

/// Rename/move a file within $HOME.
/// Both source and destination must be within $HOME. Source must exist.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn plugin_rename_path(
    from: String,
    to: String,
    plugin_id: String,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<(), String> {
    plugin_rename_path_impl(&state, from, to, plugin_id).await
}

pub(crate) async fn plugin_rename_path_impl(
    state: &std::sync::Arc<crate::AppState>,
    from: String,
    to: String,
    plugin_id: String,
) -> Result<(), String> {
    crate::plugins::check_plugin_capability(state, &plugin_id, "fs:rename")?;
    plugin_rename_path_inner(from, to).await
}

async fn plugin_rename_path_inner(from: String, to: String) -> Result<(), String> {
    let from_path = validate_within_home(&from)?;

    let to_path = PathBuf::from(&to);
    if !to_path.is_absolute() {
        return Err("Destination path must be absolute".into());
    }

    let home = effective_home_dir()?;

    let to_parent = to_path
        .parent()
        .ok_or("Cannot determine destination parent directory")?;
    if !to_parent.exists() {
        std::fs::create_dir_all(to_parent)
            .map_err(|e| format!("Failed to create destination parent directories: {e}"))?;
    }
    let canonical_parent = to_parent
        .canonicalize()
        .map_err(|e| format!("Failed to resolve destination parent: {e}"))?;
    if !canonical_parent.starts_with(&home) {
        return Err("Destination must be within the user's home directory".into());
    }

    std::fs::rename(&from_path, &to_path).map_err(|e| format!("Failed to rename: {e}"))
}

// ---------------------------------------------------------------------------
// Build-artifact scan (capability-gated: fs:scan)
//
// Wired to IPC (`scan_build_artifacts` in the invoke_handler, `lib.rs`) and to
// HTTP parity (`/api/plugins/{id}/build-artifacts/scan`, `plugin_routes.rs`).
// The `fs:scan`/`fs:delete` capability strings are registered in
// `KNOWN_CAPABILITIES` (`plugins.rs`); the PluginHost exposes `scanBuildArtifacts`
// / `deleteBuildArtifact`.
// ---------------------------------------------------------------------------

/// Known build-artifact directory names mapped to a language/tool kind.
/// Shared by the scanner (which dirs to measure) and the delete guard (which
/// names are removable). Generic names like `bin`/`obj` are .NET conventions;
/// the delete guard's other conditions (inside a registered repo, not the repo
/// root, `$HOME`-scoped) keep them from being a footgun.
pub(crate) const ARTIFACT_DIRS: &[(&str, &str)] = &[
    ("target", "rust"),
    ("node_modules", "node"),
    (".venv", "python"),
    ("__pycache__", "python"),
    ("obj", "dotnet"),
    ("bin", "dotnet"),
    (".gradle", "gradle"),
];

/// Cap on scan-walk recursion into a repo (runaway backstop; real source trees
/// are far shallower). Symlinked dirs are never followed, so cycles are impossible.
const MAX_SCAN_DEPTH: u8 = 8;

/// Cap on size-measurement recursion within a matched artifact dir. Deeper than
/// MAX_SCAN_DEPTH because `node_modules` nests heavily; symlinks are not followed.
const MAX_SIZE_DEPTH: u8 = 64;

/// One matched build-artifact directory: its absolute path, tool kind, total
/// on-disk size, last-build age (max mtime of direct children, as Unix secs),
/// and the repo root it was found under.
#[derive(serde::Serialize)]
pub struct ArtifactEntry {
    pub path: String,
    pub kind: String,
    pub size_bytes: u64,
    pub last_modified_secs: u64,
    pub repo: String,
}

/// Recursively sum sizes of regular files under `dir`. Does not follow symlinks
/// (uses `DirEntry` file types / non-traversing metadata), so it can't escape
/// the tree or loop. Per-dir read errors are non-fatal — a macOS TCC-protected
/// subdir is skipped, not counted, and never aborts the sum.
fn dir_size_bytes(dir: &std::path::Path, depth: u8) -> u64 {
    if depth == 0 {
        return 0;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            total += dir_size_bytes(&e.path(), depth - 1);
        } else if ft.is_file()
            && let Ok(m) = e.metadata()
        {
            total += m.len();
        }
    }
    total
}

/// Max mtime (Unix secs) among the direct children of `dir`. Dir mtime is
/// unreliable as a "last build" signal; the newest direct child is cheap and
/// closer to the truth. Returns 0 if the dir is unreadable or empty.
fn max_child_mtime_secs(dir: &std::path::Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut max = 0u64;
    for e in rd.flatten() {
        if let Ok(m) = e.metadata()
            && let Ok(mt) = m.modified()
            && let Ok(d) = mt.duration_since(std::time::UNIX_EPOCH)
        {
            max = max.max(d.as_secs());
        }
    }
    max
}

/// Measure a matched artifact dir into an `ArtifactEntry` (summed whole).
fn measure(dir: &std::path::Path, kind: &str, repo: &str) -> ArtifactEntry {
    ArtifactEntry {
        path: dir.to_string_lossy().to_string(),
        kind: kind.to_string(),
        size_bytes: dir_size_bytes(dir, MAX_SIZE_DEPTH),
        last_modified_secs: max_child_mtime_secs(dir),
        repo: repo.to_string(),
    }
}

/// Recursively find build-artifact directories under `dir`. On a match, the dir
/// is summed whole and NOT descended into (stop-at-match), so a `node_modules`
/// nested inside another is folded into the outer entry — never double counted.
/// Skips `.git` and symlinked dirs; per-dir read errors are non-fatal.
fn walk_artifacts(dir: &std::path::Path, repo: &str, depth: u8, out: &mut Vec<ArtifactEntry>) {
    if depth == 0 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if !ft.is_dir() || ft.is_symlink() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let p = e.path();
        if let Some((_, kind)) = ARTIFACT_DIRS.iter().find(|(n, _)| *n == name) {
            out.push(measure(&p, kind, repo));
        } else {
            walk_artifacts(&p, repo, depth - 1, out);
        }
    }
}

/// Scan registered repo roots for build-artifact directories. Read-only; gated
/// by `fs:scan`. Each repo path is `validate_within_home`'d; a repo that fails
/// validation (moved, unmounted, outside `$HOME`) is skipped, not fatal.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn scan_build_artifacts(
    repo_paths: Vec<String>,
    plugin_id: String,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<Vec<ArtifactEntry>, String> {
    scan_build_artifacts_impl(&state, repo_paths, plugin_id).await
}

pub(crate) async fn scan_build_artifacts_impl(
    state: &std::sync::Arc<crate::AppState>,
    repo_paths: Vec<String>,
    plugin_id: String,
) -> Result<Vec<ArtifactEntry>, String> {
    crate::plugins::check_plugin_capability(state, &plugin_id, "fs:scan")?;
    scan_build_artifacts_inner(repo_paths).await
}

async fn scan_build_artifacts_inner(repo_paths: Vec<String>) -> Result<Vec<ArtifactEntry>, String> {
    spawn_blocking_fs(move || {
        let mut out = Vec::new();
        for raw in &repo_paths {
            let Ok(root) = validate_within_home(raw) else {
                continue;
            };
            let repo = root.to_string_lossy().to_string();
            walk_artifacts(&root, &repo, MAX_SCAN_DEPTH, &mut out);
        }
        Ok(out)
    })
    .await
}

// ---------------------------------------------------------------------------
// Build-artifact delete (capability-gated: fs:delete)
//
// Wired to IPC (`delete_build_artifact`) and HTTP parity
// (`/api/plugins/{id}/build-artifacts/delete`). Destructive; the guard below is
// the sharp edge.
// ---------------------------------------------------------------------------

/// Guard for a destructive `remove_dir_all`. ALL conditions must hold, or the
/// path is refused. Canonicalizes first so a symlink pointing outside a repo
/// resolves to its real location and fails containment:
///   1. basename is a known artifact dir name (`ARTIFACT_DIRS`);
///   2. strictly inside one of the caller-supplied registered repo roots
///      (`starts_with` a root AND not equal to it — never delete a repo root).
///
/// `$HOME` scoping is enforced separately by `validate_within_home` on both the
/// target and each repo root before this runs (defense in depth).
fn assert_deletable(path: &std::path::Path, repo_roots: &[PathBuf]) -> Result<(), String> {
    let c = path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {e}"))?;

    let name = c.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if !ARTIFACT_DIRS.iter().any(|(n, _)| *n == name) {
        return Err(format!(
            "Refusing to delete: '{name}' is not a build-artifact dir"
        ));
    }

    let inside = repo_roots.iter().any(|r| c.starts_with(r) && c != *r);
    if !inside {
        return Err("Refusing to delete: path is outside all registered repos".into());
    }

    Ok(())
}

/// Delete a build-artifact directory. Destructive; gated by `fs:delete`. The
/// target and every repo root are `validate_within_home`'d, then `assert_deletable`
/// enforces the artifact-name + strict-containment guard before `remove_dir_all`.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn delete_build_artifact(
    path: String,
    repo_paths: Vec<String>,
    plugin_id: String,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<(), String> {
    delete_build_artifact_impl(&state, path, repo_paths, plugin_id).await
}

pub(crate) async fn delete_build_artifact_impl(
    state: &std::sync::Arc<crate::AppState>,
    path: String,
    repo_paths: Vec<String>,
    plugin_id: String,
) -> Result<(), String> {
    crate::plugins::check_plugin_capability(state, &plugin_id, "fs:delete")?;
    delete_build_artifact_inner(path, repo_paths).await
}

async fn delete_build_artifact_inner(path: String, repo_paths: Vec<String>) -> Result<(), String> {
    spawn_blocking_fs(move || {
        // $HOME scope + canonicalization of the target.
        let canonical = validate_within_home(&path)?;

        // Canonicalize each registered repo root (resolves symlinks so
        // containment is compared apples-to-apples). Roots that fail validation
        // are dropped, not fatal — a stale repo entry can't widen the guard.
        let mut roots = Vec::new();
        for r in &repo_paths {
            if let Ok(rc) = validate_within_home(r) {
                roots.push(rc);
            }
        }

        assert_deletable(&canonical, &roots)?;

        std::fs::remove_dir_all(&canonical).map_err(|e| format!("Failed to remove: {e}"))
    })
    .await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn validate_rejects_empty_path() {
        assert!(validate_within_home("").is_err());
    }

    #[test]
    fn validate_rejects_relative_path() {
        assert!(validate_within_home("relative/path").is_err());
    }

    #[test]
    fn validate_rejects_outside_home() {
        let _guard = FS_TEST_LOCK.lock().unwrap();
        let home = dirs::home_dir().unwrap();
        if !Path::new("/tmp").starts_with(&home) {
            assert!(validate_within_home("/tmp").is_err());
        }
    }

    #[test]
    fn validate_accepts_home_dir() {
        let _guard = FS_TEST_LOCK.lock().unwrap();
        let home = dirs::home_dir().unwrap();
        let result = validate_within_home(home.to_str().unwrap());
        assert!(result.is_ok());
    }

    #[test]
    fn validate_rejects_traversal() {
        let _guard = FS_TEST_LOCK.lock().unwrap();
        let home = dirs::home_dir().unwrap();
        let traversal = format!("{}/../../../etc/passwd", home.display());
        assert!(validate_within_home(&traversal).is_err());
    }

    #[test]
    fn classify_create_event() {
        let mut map = std::collections::HashMap::new();
        let event = Event {
            kind: notify::EventKind::Create(notify::event::CreateKind::File),
            paths: vec![PathBuf::from("/test/file.txt")],
            attrs: Default::default(),
        };
        classify_event(&event, &mut map);
        assert_eq!(map.get(Path::new("/test/file.txt")).unwrap(), "create");
    }

    #[test]
    fn classify_modify_event() {
        let mut map = std::collections::HashMap::new();
        let event = Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            paths: vec![PathBuf::from("/test/file.txt")],
            attrs: Default::default(),
        };
        classify_event(&event, &mut map);
        assert_eq!(map.get(Path::new("/test/file.txt")).unwrap(), "modify");
    }

    #[test]
    fn classify_remove_event() {
        let mut map = std::collections::HashMap::new();
        let event = Event {
            kind: notify::EventKind::Remove(notify::event::RemoveKind::File),
            paths: vec![PathBuf::from("/test/file.txt")],
            attrs: Default::default(),
        };
        classify_event(&event, &mut map);
        assert_eq!(map.get(Path::new("/test/file.txt")).unwrap(), "delete");
    }

    #[test]
    fn classify_ignores_access_event() {
        let mut map = std::collections::HashMap::new();
        let event = Event {
            kind: notify::EventKind::Access(notify::event::AccessKind::Read),
            paths: vec![PathBuf::from("/test/file.txt")],
            attrs: Default::default(),
        };
        classify_event(&event, &mut map);
        assert!(map.is_empty());
    }

    #[test]
    fn tail_reads_entire_small_file() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = set_home_dir_override(tmp.path().to_path_buf());
        let test_file = tmp.path().join("tail-small.txt");
        std::fs::write(&test_file, "line1\nline2\nline3\n").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(plugin_read_file_tail_inner(
            test_file.to_string_lossy().to_string(),
            1024,
        ));
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "line1\nline2\nline3\n");
    }

    #[test]
    fn tail_reads_last_bytes_skipping_partial_line() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = set_home_dir_override(tmp.path().to_path_buf());
        let test_file = tmp.path().join("tail-large.txt");
        let content = "line1\nline2\nline3\nline4\nline5\n";
        std::fs::write(&test_file, content).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(plugin_read_file_tail_inner(
            test_file.to_string_lossy().to_string(),
            12,
        ));
        assert!(result.is_ok());
        let text = result.unwrap();
        assert_eq!(text, "line5\n");
    }

    #[test]
    fn tail_rejects_non_file() {
        let _guard = FS_TEST_LOCK.lock().unwrap();
        let home = dirs::home_dir().unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(plugin_read_file_tail_inner(
            home.to_string_lossy().to_string(),
            1024,
        ));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not a file"));
    }

    #[test]
    fn classify_last_event_wins() {
        let mut map = std::collections::HashMap::new();
        let create = Event {
            kind: notify::EventKind::Create(notify::event::CreateKind::File),
            paths: vec![PathBuf::from("/test/file.txt")],
            attrs: Default::default(),
        };
        let modify = Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            paths: vec![PathBuf::from("/test/file.txt")],
            attrs: Default::default(),
        };
        classify_event(&create, &mut map);
        classify_event(&modify, &mut map);
        assert_eq!(map.get(Path::new("/test/file.txt")).unwrap(), "modify");
    }

    // -- plugin_write_file tests --

    #[test]
    fn write_file_creates_new_file() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = set_home_dir_override(tmp.path().to_path_buf());
        let test_file = tmp.path().join("write-new.txt");

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(plugin_write_file_inner(
            test_file.to_string_lossy().to_string(),
            "hello write".to_string(),
        ));
        let content = std::fs::read_to_string(&test_file).unwrap_or_default();

        assert!(result.is_ok(), "write failed: {:?}", result);
        assert_eq!(content, "hello write");
    }

    #[test]
    fn write_file_overwrites_existing() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = set_home_dir_override(tmp.path().to_path_buf());
        let test_file = tmp.path().join("write-overwrite.txt");
        let _ = std::fs::write(&test_file, "old content");

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(plugin_write_file_inner(
            test_file.to_string_lossy().to_string(),
            "new content".to_string(),
        ));
        let content = std::fs::read_to_string(&test_file).unwrap_or_default();

        assert!(result.is_ok());
        assert_eq!(content, "new content");
    }

    #[test]
    fn write_file_rejects_relative_path() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(plugin_write_file_inner(
            "relative/file.txt".to_string(),
            "content".to_string(),
        ));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("absolute"));
    }

    #[test]
    fn write_file_rejects_outside_home() {
        let _guard = FS_TEST_LOCK.lock().unwrap();
        let home = dirs::home_dir().unwrap();
        if !Path::new("/tmp").starts_with(&home) {
            let rt = tokio::runtime::Runtime::new().unwrap();
            let result = rt.block_on(plugin_write_file_inner(
                "/tmp/.tuic-test-write-outside.txt".to_string(),
                "content".to_string(),
            ));
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("home directory"));
        }
    }

    #[test]
    fn write_file_rejects_directory_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = set_home_dir_override(tmp.path().to_path_buf());
        let test_dir = tmp.path().join("write-dir");
        let _ = std::fs::create_dir_all(&test_dir);

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(plugin_write_file_inner(
            test_dir.to_string_lossy().to_string(),
            "content".to_string(),
        ));

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("directory"));
    }

    // -- plugin_rename_path tests --

    #[test]
    fn rename_moves_file() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = set_home_dir_override(tmp.path().to_path_buf());
        let from = tmp.path().join("rename-from.txt");
        let to = tmp.path().join("rename-to.txt");
        let _ = std::fs::write(&from, "rename me");

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(plugin_rename_path_inner(
            from.to_string_lossy().to_string(),
            to.to_string_lossy().to_string(),
        ));
        let content = std::fs::read_to_string(&to).unwrap_or_default();
        let from_exists = from.exists();

        assert!(result.is_ok(), "rename failed: {:?}", result);
        assert_eq!(content, "rename me");
        assert!(!from_exists);
    }

    #[test]
    fn rename_rejects_source_outside_home() {
        let _guard = FS_TEST_LOCK.lock().unwrap();
        let home = dirs::home_dir().unwrap();
        if !Path::new("/tmp").starts_with(&home) {
            let rt = tokio::runtime::Runtime::new().unwrap();
            let result = rt.block_on(plugin_rename_path_inner(
                "/tmp/.tuic-test-rename.txt".to_string(),
                home.join(".tuic-test-rename-dest.txt")
                    .to_string_lossy()
                    .to_string(),
            ));
            assert!(result.is_err());
        }
    }

    #[test]
    fn rename_rejects_relative_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = set_home_dir_override(tmp.path().to_path_buf());
        let from = tmp.path().join("rename-rel.txt");
        let _ = std::fs::write(&from, "test");

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(plugin_rename_path_inner(
            from.to_string_lossy().to_string(),
            "relative/dest.txt".to_string(),
        ));

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("absolute"));
    }

    // -- scan_build_artifacts tests --

    #[test]
    fn scan_build_artifacts_finds_known_dirs_only() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::write(root.join("target/a.o"), vec![0u8; 100]).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/pkg.js"), vec![0u8; 50]).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/HEAD"), vec![0u8; 20]).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), vec![0u8; 30]).unwrap();

        let mut out = Vec::new();
        walk_artifacts(root, "repo", MAX_SCAN_DEPTH, &mut out);

        assert_eq!(
            out.len(),
            2,
            "expected target+node_modules only, got {:?}",
            out.iter().map(|e| &e.path).collect::<Vec<_>>()
        );
        assert!(
            out.iter()
                .any(|e| e.path.ends_with("target") && e.kind == "rust")
        );
        assert!(
            out.iter()
                .any(|e| e.path.ends_with("node_modules") && e.kind == "node")
        );
        assert!(!out.iter().any(|e| e.path.contains(".git")));
    }

    #[test]
    fn scan_build_artifacts_no_double_count_nested() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let nm = root.join("node_modules");
        std::fs::create_dir_all(nm.join("dep/node_modules")).unwrap();
        std::fs::write(nm.join("outer.js"), vec![0u8; 100]).unwrap();
        std::fs::write(nm.join("dep/node_modules/inner.js"), vec![0u8; 200]).unwrap();

        let mut out = Vec::new();
        walk_artifacts(root, "repo", MAX_SCAN_DEPTH, &mut out);

        assert_eq!(
            out.len(),
            1,
            "nested node_modules must not be a separate entry"
        );
        // Outer dir is summed whole (300 bytes = outer.js + nested inner.js),
        // proving stop-at-match measures the tree but does not re-emit the nested dir.
        assert_eq!(out[0].size_bytes, 300);
    }

    #[test]
    fn scan_build_artifacts_sums_sizes_recursively() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let t = root.join("target");
        std::fs::create_dir_all(t.join("debug/deps")).unwrap();
        std::fs::write(t.join("f1"), vec![0u8; 10]).unwrap();
        std::fs::write(t.join("debug/f2"), vec![0u8; 20]).unwrap();
        std::fs::write(t.join("debug/deps/f3"), vec![0u8; 30]).unwrap();

        let mut out = Vec::new();
        walk_artifacts(root, "repo", MAX_SCAN_DEPTH, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].size_bytes, 60);
    }

    #[test]
    fn scan_build_artifacts_missing_dir_is_non_fatal() {
        let mut out = Vec::new();
        walk_artifacts(
            Path::new("/nonexistent/path/xyz-tuic-test"),
            "repo",
            MAX_SCAN_DEPTH,
            &mut out,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn scan_build_artifacts_inner_validates_within_home() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = set_home_dir_override(tmp.path().to_path_buf());
        let repo = tmp.path().join("myrepo");
        std::fs::create_dir_all(repo.join("target")).unwrap();
        std::fs::write(repo.join("target/x"), vec![0u8; 42]).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let out = rt
            .block_on(scan_build_artifacts_inner(vec![
                repo.to_string_lossy().to_string(),
                "/outside/home/repo".to_string(), // invalid → skipped, not fatal
            ]))
            .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].size_bytes, 42);
        assert_eq!(out[0].kind, "rust");
    }

    // -- delete_build_artifact tests --

    #[test]
    fn delete_build_artifact_accepts_target_inside_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let target = repo.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let roots = vec![repo.canonicalize().unwrap()];

        assert!(assert_deletable(&target, &roots).is_ok());
    }

    #[test]
    fn delete_build_artifact_rejects_outside_all_repos() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        // A real `target` dir that lives OUTSIDE the registered repo root.
        let stray = tmp.path().join("elsewhere/target");
        std::fs::create_dir_all(&stray).unwrap();
        let roots = vec![repo.canonicalize().unwrap()];

        let err = assert_deletable(&stray, &roots).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
    }

    #[test]
    fn delete_build_artifact_rejects_non_artifact_name() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let src = repo.join("src"); // not a known artifact dir
        std::fs::create_dir_all(&src).unwrap();
        let roots = vec![repo.canonicalize().unwrap()];

        let err = assert_deletable(&src, &roots).unwrap_err();
        assert!(err.contains("artifact"), "got: {err}");
    }

    #[test]
    fn delete_build_artifact_rejects_repo_root_itself() {
        let tmp = tempfile::tempdir().unwrap();
        // Repo root whose own name happens to be a known artifact name — the
        // guard must still refuse to delete the registered root (c == root).
        let repo = tmp.path().join("target");
        std::fs::create_dir_all(&repo).unwrap();
        let root = repo.canonicalize().unwrap();

        let err = assert_deletable(&root, &[root.clone()]).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn delete_build_artifact_rejects_symlink_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        // Real `target` outside the repo; a symlink inside the repo points to it.
        let outside = tmp.path().join("outside/target");
        std::fs::create_dir_all(&outside).unwrap();
        let link = repo.join("target");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let roots = vec![repo.canonicalize().unwrap()];

        // canonicalize() resolves the symlink to `outside`, which is not inside
        // the repo root → rejected despite the artifact-name basename matching.
        let err = assert_deletable(&link, &roots).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
    }

    #[test]
    fn delete_build_artifact_inner_removes_real_target() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = set_home_dir_override(tmp.path().to_path_buf());
        let repo = tmp.path().join("repo");
        let target = repo.join("target");
        std::fs::create_dir_all(target.join("debug")).unwrap();
        std::fs::write(target.join("debug/artifact.o"), vec![0u8; 10]).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(delete_build_artifact_inner(
            target.to_string_lossy().to_string(),
            vec![repo.to_string_lossy().to_string()],
        ));
        assert!(result.is_ok(), "delete failed: {:?}", result);
        assert!(!target.exists(), "target should be removed");
        assert!(repo.exists(), "repo root must survive");
    }

    #[test]
    fn delete_build_artifact_inner_rejects_outside_home() {
        let _guard = FS_TEST_LOCK.lock().unwrap();
        let home = dirs::home_dir().unwrap();
        if !Path::new("/tmp").starts_with(&home) {
            let rt = tokio::runtime::Runtime::new().unwrap();
            let result = rt.block_on(delete_build_artifact_inner(
                "/tmp/.tuic-test-delete/target".to_string(),
                vec!["/tmp/.tuic-test-delete".to_string()],
            ));
            assert!(result.is_err());
        }
    }
}
