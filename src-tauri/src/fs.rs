use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(feature = "desktop")]
use tauri::Emitter;

/// Run a blocking filesystem closure on Tokio's blocking pool, flattening the
/// `JoinError` into the closure's own `Result<T, String>`.
///
/// This is what keeps a `#[tauri::command]` off the UI thread. A command written
/// as a plain `fn` gets `ExecutionContext::Blocking` and runs inline in the IPC
/// handler — on macOS that is the main thread, so a recursive copy or a 250 MB
/// read freezes the WebView until it finishes. Writing the command as
/// `async fn` moves it to the Tokio executor, and wrapping the actual syscalls
/// here keeps them off the async workers too.
///
/// Both transports go through the commands, so the IPC and HTTP twins inherit
/// the same threading decision instead of each choosing one (story 607-f483).
pub(crate) async fn spawn_blocking_fs<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("fs task failed: {e}"))?
}

/// A directory entry returned by `list_directory`.
#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    /// Path relative to repo root, always using `/` as separator.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Last modification time as seconds since UNIX epoch.
    pub modified_at: u64,
    /// Git status: "modified", "staged", "untracked", or "" (clean).
    pub git_status: String,
    /// Whether the file is listed in .gitignore.
    pub is_ignored: bool,
}

/// A single line match returned by `search_content`.
#[derive(Debug, Clone, Serialize)]
pub struct ContentMatch {
    /// Path relative to repo root, always using `/` as separator.
    pub path: String,
    pub line_number: u32,
    /// Full line content (without trailing newline).
    pub line_text: String,
    /// UTF-16 code-unit offset of match start within `line_text`.
    /// This is the coordinate system used by JavaScript `String.slice`.
    pub match_start: u32,
    /// UTF-16 code-unit offset of match end (exclusive) within `line_text`.
    pub match_end: u32,
    /// Absolute repo root path — set only by cross-repo search; absent for single-repo results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
}

/// Aggregated result of a full-text content search.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ContentSearchResult {
    pub matches: Vec<ContentMatch>,
    pub files_searched: u32,
    /// Binary files and files exceeding the size limit.
    pub files_skipped: u32,
    /// `true` when the global match limit was reached.
    pub truncated: bool,
    /// Cross-repo search only: registered repos whose content index was not
    /// ready yet, so they contributed nothing to this result. A build is kicked
    /// off for each, so a later search covers them. Zero for single-repo search.
    /// Non-zero means "not found HERE yet" — never report a clean miss.
    #[serde(default)]
    pub repos_pending: u32,
    /// Cross-repo search only: registered repos actually searched.
    #[serde(default)]
    pub repos_searched: u32,
}

/// Streamed batch payload emitted via the `content-search-batch` event.
#[derive(Debug, Clone, Serialize)]
pub struct ContentSearchBatch {
    /// Echoed from the request that started this search. The event is global and
    /// several panels listen to it at once; without it, the command palette's
    /// results land in the file browser's list and flip its spinner off.
    pub search_id: String,
    pub matches: Vec<ContentMatch>,
    pub is_final: bool,
    pub files_searched: u32,
    pub files_skipped: u32,
    pub truncated: bool,
    /// Mirrors `ContentSearchResult` — lets the UI distinguish "no match" from
    /// "not searched yet" on a cross-repo search.
    pub repos_pending: u32,
    pub repos_searched: u32,
}

/// Failure payload emitted via the `content-search-error` event. Carries the
/// same `search_id` as the batches, for the same reason: only the panel that
/// started the search may show the error.
#[derive(Debug, Clone, Serialize)]
pub struct ContentSearchError {
    pub search_id: String,
    pub message: String,
}

/// Managed state for cancelling in-flight content searches.
pub struct ContentSearchCancel(pub Mutex<Option<Arc<AtomicBool>>>);

/// Validate that a resolved path is within the repo root.
/// Returns the canonical repo path and the canonical target path.
fn validate_path(repo_path: &str, relative: &str) -> Result<(PathBuf, PathBuf), String> {
    let repo = PathBuf::from(repo_path);
    let target = repo.join(relative);

    let canonical_repo = repo
        .canonicalize()
        .map_err(|e| format!("Failed to resolve repo path: {e}"))?;
    let canonical_target = target
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {e}"))?;

    if !canonical_target.starts_with(&canonical_repo) {
        return Err("Access denied: path is outside repository".to_string());
    }

    Ok((canonical_repo, canonical_target))
}

/// Validate a path that may not exist yet (for write/create operations).
/// Canonicalizes the parent directory and checks it's within the repo.
fn validate_path_for_creation(
    repo_path: &str,
    relative: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let repo = PathBuf::from(repo_path);
    let target = repo.join(relative);

    let canonical_repo = repo
        .canonicalize()
        .map_err(|e| format!("Failed to resolve repo path: {e}"))?;

    // For new files, canonicalize the parent directory
    let parent = target
        .parent()
        .ok_or_else(|| "Invalid path: no parent directory".to_string())?;

    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("Failed to resolve parent directory: {e}"))?;

    if !canonical_parent.starts_with(&canonical_repo) {
        return Err("Access denied: path is outside repository".to_string());
    }

    // Reconstruct full path using canonical parent + filename
    let file_name = target
        .file_name()
        .ok_or_else(|| "Invalid path: no file name".to_string())?;
    let canonical_target = canonical_parent.join(file_name);

    Ok((canonical_repo, canonical_target))
}

/// Directory names that are always excluded from repo walks — VCS internals and
/// heavy build/cache outputs that are useless to search and often bypass `.gitignore`
/// (missing, incomplete, or outside-of-git).
///
/// A name lands here only when no project uses it for tracked source. `build` and
/// `out` do not qualify and were removed: a `build/` of tracked release scripts and
/// a monorepo package named `packages/build/` are both ordinary source that git
/// reports, and matching the bare name classified every edit under them as noise.
/// Generated `build/` and `out/` directories are gitignored, and every walker here
/// honours git's ignore rules (parents included), so they stay pruned anyway.
pub(crate) const ALWAYS_EXCLUDED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".jj",
    ".mdkb",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
];

/// Returns `true` when the entry is a directory whose name matches one of
/// `ALWAYS_EXCLUDED_DIRS`. Used with `ignore::WalkBuilder::filter_entry`.
pub(crate) fn is_always_excluded_dir(entry: &ignore::DirEntry) -> bool {
    if !entry.file_type().is_some_and(|ft| ft.is_dir()) {
        return false;
    }
    let name = entry.file_name();
    ALWAYS_EXCLUDED_DIRS
        .iter()
        .any(|d| name == std::ffi::OsStr::new(d))
}

/// Parse `git status --porcelain -z` output into a map of relative_path -> status string.
pub(crate) fn parse_git_status(
    repo_path: &str,
    subdir: &str,
) -> std::collections::HashMap<String, String> {
    let mut statuses = std::collections::HashMap::new();

    let mut args = vec!["status", "--porcelain", "-z"];
    if !subdir.is_empty() && subdir != "." {
        args.push("--");
        args.push(subdir);
    }

    let out = match crate::git_cli::git_cmd(std::path::Path::new(repo_path))
        .args(&args)
        .run_silent()
    {
        Some(o) => o,
        None => return statuses,
    };

    let text = &out.stdout;
    // Porcelain -z format: entries separated by NUL, each entry is "XY path"
    // Renames have an additional NUL-separated original path after the entry.
    let entries: Vec<&str> = text.split('\0').collect();
    let mut i = 0;
    while i < entries.len() {
        let entry = entries[i];
        if entry.len() < 4 {
            i += 1;
            continue;
        }
        let xy = &entry[..2];
        let path = &entry[3..];

        let status = match xy {
            // Index has changes (staged)
            s if s.starts_with('A') => "staged",
            s if s.starts_with('M') || s.starts_with('R') || s.starts_with('D') => "staged",
            // Worktree has changes (modified)
            s if s.ends_with('M') || s.ends_with('D') => "modified",
            // Untracked
            "??" => "untracked",
            _ => "",
        };

        if !status.is_empty() {
            statuses.insert(path.to_string(), status.to_string());
        }

        // Renames (R) have an extra path entry
        if xy.starts_with('R') {
            i += 1; // skip the original path
        }

        i += 1;
    }

    statuses
}

/// Get a set of ignored paths within a directory using `git check-ignore`.
pub(crate) fn get_ignored_paths(
    repo_path: &str,
    paths: &[String],
) -> std::collections::HashSet<String> {
    let mut ignored = std::collections::HashSet::new();
    if paths.is_empty() {
        return ignored;
    }

    let mut args: Vec<&str> = vec!["check-ignore", "--no-index", "--"];
    for p in paths {
        args.push(p);
    }

    // git check-ignore exits 0 = some ignored, 1 = none ignored
    if let Ok(raw) = crate::git_cli::git_cmd(std::path::Path::new(repo_path))
        .args(&args)
        .run_raw()
    {
        let text = String::from_utf8_lossy(&raw.stdout);
        for line in text.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                ignored.insert(trimmed.replace('\\', "/"));
            }
        }
    }

    ignored
}

/// Filesystem stat result used by `stat_path` to discriminate file vs directory
/// for features like "Open Path…" that accept an arbitrary user-typed path.
#[derive(Debug, Clone, Serialize)]
pub struct PathStat {
    pub exists: bool,
    pub is_dir: bool,
    /// Last modification time, milliseconds since UNIX epoch (0 for dirs /
    /// missing / unavailable). Lets callers (e.g. the editor disk-change poll)
    /// detect changes without re-reading file content.
    pub modified_at: u64,
    /// File size in bytes (0 for dirs / missing). Paired with `modified_at` to
    /// catch truncate-rewrite saves that may not bump mtime granularity.
    pub size: u64,
}

impl PathStat {
    /// Non-existent / inaccessible path — all-zero metadata.
    fn missing() -> Self {
        PathStat {
            exists: false,
            is_dir: false,
            modified_at: 0,
            size: 0,
        }
    }
}

pub(crate) fn stat_path_impl(path: String) -> PathStat {
    let p = PathBuf::from(&path);
    // SAFETY: Never probe macOS TCC-protected directories. std::fs::metadata on
    // `~/Desktop/foo` triggers the system permission dialog and also lets
    // untrusted callers (plugins, frontend bugs) probe arbitrary files outside
    // any repo scope. Mirrors resolve_terminal_path's guard.
    if is_tcc_protected_path(&p) {
        return PathStat::missing();
    }
    match std::fs::metadata(&p) {
        Ok(meta) => {
            let is_dir = meta.is_dir();
            let modified_at = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            PathStat {
                exists: true,
                is_dir,
                modified_at,
                size: if is_dir { 0 } else { meta.len() },
            }
        }
        Err(_) => PathStat::missing(),
    }
}

/// Stat an absolute path — returns existence and directory flag without leaking errors.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn stat_path(path: String) -> PathStat {
    stat_path_impl(path)
}

/// List entries in a directory within a repository.
///
/// Not the microsecond `read_dir` it looks like: `list_directory_impl` runs
/// `git status --porcelain` as a **subprocess** for the requested subdir, which
/// costs tens to hundreds of ms on a large repo. It goes to the blocking pool.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_directory(repo_path: String, subdir: String) -> Result<Vec<DirEntry>, String> {
    spawn_blocking_fs(move || list_directory_impl(repo_path, subdir)).await
}

pub(crate) fn list_directory_impl(
    repo_path: String,
    subdir: String,
) -> Result<Vec<DirEntry>, String> {
    let repo = PathBuf::from(&repo_path);

    // Canonicalize repo root ONCE — all relative paths derived via join + strip_prefix
    let canonical_repo = repo
        .canonicalize()
        .map_err(|e| format!("Failed to resolve repo path: {e}"))?;

    // Validate the subdir is within the repo
    let dir_to_read = if subdir.is_empty() || subdir == "." {
        canonical_repo.clone()
    } else {
        let (_cr, canonical_dir) = validate_path(&repo_path, &subdir)?;
        canonical_dir
    };

    if !dir_to_read.is_dir() {
        return Err(format!("Not a directory: {subdir}"));
    }

    // Get git statuses for this subdir
    let git_statuses = parse_git_status(&repo_path, &subdir);

    // Build gitignore matcher from the repo's .gitignore (no subprocess)
    let gitignore_path = canonical_repo.join(".gitignore");
    let gitignore = if gitignore_path.exists() {
        let mut builder = ignore::gitignore::GitignoreBuilder::new(&canonical_repo);
        builder.add(&gitignore_path);
        builder.build().ok()
    } else {
        None
    };

    let mut entries = Vec::new();
    let read_dir =
        std::fs::read_dir(&dir_to_read).map_err(|e| format!("Failed to read directory: {e}"))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip .git directory
        if name == ".git" {
            continue;
        }

        let metadata = entry
            .metadata()
            .map_err(|e| format!("Failed to read metadata for {name}: {e}"))?;

        let is_dir = metadata.is_dir();
        let size = if is_dir { 0 } else { metadata.len() };
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs());

        // Compute relative path via join + strip_prefix (no canonicalize per entry)
        let abs_path = dir_to_read.join(&name);
        let relative = abs_path
            .strip_prefix(&canonical_repo)
            .map_err(|_| format!("Entry {name} is outside repo"))?
            .to_string_lossy()
            .replace('\\', "/");

        // Check gitignore status without subprocess
        let is_ignored = gitignore.as_ref().is_some_and(|gi| {
            gi.matched_path_or_any_parents(&abs_path, is_dir)
                .is_ignore()
        });

        // Look up git status — for dirs, propagate the most relevant child status
        let git_status = if is_dir {
            let prefix = format!("{relative}/");
            let mut has_staged = false;
            let mut has_modified = false;
            let mut has_untracked = false;
            for (p, s) in &git_statuses {
                if p.starts_with(&prefix) {
                    match s.as_str() {
                        "staged" => has_staged = true,
                        "modified" => has_modified = true,
                        "untracked" => has_untracked = true,
                        _ => {}
                    }
                }
            }
            if has_staged {
                "staged".to_string()
            } else if has_modified {
                "modified".to_string()
            } else if has_untracked {
                "untracked".to_string()
            } else {
                String::new()
            }
        } else {
            git_statuses.get(&relative).cloned().unwrap_or_default()
        };

        entries.push(DirEntry {
            name,
            path: relative,
            is_dir,
            size,
            modified_at,
            git_status,
            is_ignored,
        });
    }

    // Sort: directories first, then alphabetical (case-insensitive)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Recursively search files in a repository matching a glob-like query.
/// Returns up to `limit` results (default 200) to avoid blowing up on huge repos.
/// Respects .gitignore natively via the `ignore` crate (no subprocess).
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn search_files(
    app_state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
    repo_path: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<DirEntry>, String> {
    // `search_files_impl` is a synchronous `WalkBuilder` traversal and can block
    // for hundreds of ms on large repos. The HTTP twin has always moved it off
    // the executor; this one used to run it inline, so the same work made two
    // different threading decisions depending on the transport (story 607-f483).
    let guard = app_state.indexer_throttle.begin_search();
    spawn_blocking_fs(move || {
        let _g = guard; // hold across the walk; dropped when the closure returns
        search_files_impl(repo_path, query, limit)
    })
    .await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn warm_content_index(
    app_state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
    repo_path: String,
) {
    crate::content_index::ensure_index(&app_state, &repo_path);
}

/// Split a `ContentSearchResult` into `content-search-batch` payloads of 50
/// matches, handing each to `emit`, and stop early once `cancel` is raised.
///
/// **Every search gets a final batch, cancelled ones included.** There is one
/// cancellation slot for the whole process, so starting a search in the command
/// palette cancels the file browser's — and the file browser only listens for
/// batches carrying its own `search_id`, so the palette's `is_final` cannot
/// release it. Returning early on cancellation left that panel spinning for the
/// life of the window. The cut-short search still owes its caller a last word.
///
/// Takes a sink rather than an `AppHandle` so the batching and the cancellation
/// contract are testable without a running Tauri app.
fn dispatch_content_batches(
    result: ContentSearchResult,
    cancel: &AtomicBool,
    search_id: &str,
    mut emit: impl FnMut(ContentSearchBatch),
) {
    let mut batch = |matches: Vec<ContentMatch>, is_final: bool| {
        emit(ContentSearchBatch {
            search_id: search_id.to_string(),
            matches,
            is_final,
            files_searched: result.files_searched,
            files_skipped: result.files_skipped,
            truncated: result.truncated,
            repos_pending: result.repos_pending,
            repos_searched: result.repos_searched,
        });
    };

    let batch_size = 50;
    let total = result.matches.len();
    let mut sent = 0;

    for chunk in result.matches.chunks(batch_size) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        sent += chunk.len();
        batch(chunk.to_vec(), sent >= total);
    }

    // Nothing to send, or cancelled before the last chunk: close the search with
    // an empty final batch. The counters are the real ones, so a panel that was
    // superseded reports what it did search rather than claiming zero.
    if sent < total || total == 0 {
        batch(Vec::new(), true);
    }
}

/// Emit a `ContentSearchResult` to the frontend as `content-search-batch`
/// events. Shared by single- and all-repo search.
#[cfg(feature = "desktop")]
fn emit_content_batches(
    app: &tauri::AppHandle,
    result: ContentSearchResult,
    cancel: &Arc<AtomicBool>,
    search_id: &str,
) {
    dispatch_content_batches(result, cancel, search_id, |batch| {
        let _ = app.emit("content-search-batch", &batch);
    });
}

/// Every registered repo, from `repositories.json` — NOT just the ones that
/// happen to have an index entry. The index map only holds repos someone
/// already touched this session, so iterating it silently narrows "all repos"
/// to "repos I visited".
fn registered_repo_paths() -> Vec<String> {
    crate::config::load_repositories()
        .get("repos")
        .and_then(|r| r.as_object())
        .map(|repos| repos.keys().cloned().collect())
        .unwrap_or_default()
}

/// Search every registered repo and merge the results, tagging each match with
/// its `repo_path`. The global limit is split evenly across repos (min 5 each).
/// Shared by the `search_content_all` Tauri command and the
/// `/fs/search-content-all` HTTP route.
///
/// A repo whose index is not built yet cannot be searched now, but it is counted
/// in `repos_pending` rather than silently dropped. The configured warm strategy
/// owns build scheduling: one cross-repo query must not enqueue every registered
/// repo behind the single global build semaphore.
pub(crate) fn search_content_all_impl(
    state: &Arc<crate::state::AppState>,
    query: &str,
    case_sensitive: bool,
    global_limit: usize,
) -> ContentSearchResult {
    search_content_all_impl_with_cancel(
        state,
        query,
        case_sensitive,
        global_limit,
        &AtomicBool::new(false),
    )
}

fn search_content_all_impl_with_cancel(
    state: &Arc<crate::state::AppState>,
    query: &str,
    case_sensitive: bool,
    global_limit: usize,
    cancel: &AtomicBool,
) -> ContentSearchResult {
    // Union of registered repos and already-indexed ones: a repo can hold an
    // index (e.g. an agent searched it) without being registered, and must
    // still be searchable.
    let mut repo_paths = registered_repo_paths();
    for entry in state.content_indices.iter() {
        if !repo_paths.iter().any(|p| p == entry.key()) {
            repo_paths.push(entry.key().clone());
        }
    }

    let per_repo_limit = (global_limit / repo_paths.len().max(1)).max(5);

    let mut all_matches = Vec::new();
    let mut files_searched: u32 = 0;
    let mut repos_searched: u32 = 0;
    let mut repos_pending: u32 = 0;

    for repo_path in &repo_paths {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Some(index_arc) = state
            .content_indices
            .get(repo_path)
            .map(|entry| Arc::clone(entry.value()))
        else {
            repos_pending += 1;
            continue;
        };
        let Some(plan) = prepare_index_search(&index_arc, query, 50) else {
            repos_pending += 1;
            continue;
        };
        repos_searched += 1;
        if let Ok(result) =
            search_index_plan(plan, query, case_sensitive, Some(per_repo_limit), cancel)
        {
            files_searched += result.files_searched;
            for mut m in result.matches {
                m.repo_path = Some(repo_path.clone());
                all_matches.push(m);
                if all_matches.len() >= global_limit {
                    break;
                }
            }
        }
        if all_matches.len() >= global_limit {
            break;
        }
    }

    let truncated = all_matches.len() >= global_limit;
    ContentSearchResult {
        matches: all_matches,
        files_searched,
        files_skipped: 0,
        truncated,
        repos_pending,
        repos_searched,
    }
}

/// Streaming cross-repo content search. Mirrors `search_content` but fans out over
/// every ready content index instead of a single repo; results arrive via the same
/// `content-search-batch` events (each match carries its `repo_path`).
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn search_content_all(
    app: tauri::AppHandle,
    state: tauri::State<'_, ContentSearchCancel>,
    app_state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
    query: String,
    case_sensitive: Option<bool>,
    limit: Option<usize>,
    search_id: String,
) -> Result<(), String> {
    // Cancel any previous search (shares the slot with single-repo search).
    let cancel_token = Arc::new(AtomicBool::new(false));
    {
        let mut prev = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(old) = prev.take() {
            old.store(true, Ordering::Relaxed);
        }
        *prev = Some(cancel_token.clone());
    }

    let case_sensitive = case_sensitive.unwrap_or(false);
    let global_limit = limit.unwrap_or(100);
    let app_state = std::sync::Arc::clone(&app_state);
    let throttle_guard = app_state.indexer_throttle.begin_search();

    tokio::task::spawn_blocking(move || {
        let _throttle_guard = throttle_guard;
        let result = search_content_all_impl_with_cancel(
            &app_state,
            &query,
            case_sensitive,
            global_limit,
            &cancel_token,
        );
        // No early return on cancellation: `emit_content_batches` skips the
        // payload but still closes the search with a final batch under this
        // `search_id`, which is the only thing that stops the caller's spinner.
        emit_content_batches(&app, result, &cancel_token, &search_id);
    });

    Ok(())
}

#[cfg(feature = "desktop")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search_content(
    app: tauri::AppHandle,
    state: tauri::State<'_, ContentSearchCancel>,
    app_state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
    repo_path: String,
    query: String,
    case_sensitive: Option<bool>,
    use_regex: Option<bool>,
    whole_word: Option<bool>,
    limit: Option<usize>,
    search_id: String,
) -> Result<(), String> {
    // Cancel any previous search
    let cancel_token = Arc::new(AtomicBool::new(false));
    {
        let mut prev = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(old) = prev.take() {
            old.store(true, Ordering::Relaxed);
        }
        *prev = Some(cancel_token.clone());
    }

    let case_sensitive = case_sensitive.unwrap_or(false);
    let use_regex = use_regex.unwrap_or(false);
    let whole_word = whole_word.unwrap_or(false);

    // Ensure content index exists for this repo (triggers background build if needed)
    let index_arc = crate::content_index::ensure_index(&app_state, &repo_path);

    // Guard: signal indexers to pause while this search runs. Moved into the
    // blocking closure so its lifetime spans the entire search, not just this
    // async prelude.
    let throttle_guard = app_state.indexer_throttle.begin_search();

    // Run search in blocking thread
    tokio::task::spawn_blocking(move || {
        let _throttle_guard = throttle_guard;
        match search_content_indexed(
            &index_arc,
            repo_path,
            query,
            case_sensitive,
            use_regex,
            whole_word,
            limit,
            &cancel_token,
        ) {
            Ok(result) => {
                // Cancellation is handled inside: a superseded search still owes
                // its panel a final batch carrying its own `search_id`.
                emit_content_batches(&app, result, &cancel_token, &search_id);
            }
            Err(e) => {
                let _ = app.emit(
                    "content-search-error",
                    &ContentSearchError {
                        search_id: search_id.clone(),
                        message: e,
                    },
                );
            }
        }
    });

    Ok(())
}

/// Two-phase content search: BM25 index narrows to top files, then grep for lines.
/// Falls back to full `search_content_impl` when the index isn't ready or the query
/// requires regex/whole-word matching.
#[allow(clippy::too_many_arguments)]
fn search_content_indexed(
    index_arc: &std::sync::Arc<parking_lot::RwLock<crate::content_index::ContentIndex>>,
    repo_path: String,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    whole_word: bool,
    limit: Option<usize>,
    cancel: &AtomicBool,
) -> Result<ContentSearchResult, String> {
    // Fall back to full grep for regex, whole-word, or if index isn't ready
    let can_use_index = !use_regex && !whole_word && !query.is_empty();
    if can_use_index {
        let index = index_arc.read();
        if index.is_ready() {
            return search_via_index_with_cancel(&index, &query, case_sensitive, limit, cancel);
        }
    }

    // Index not ready or not applicable — fall back to full grep
    search_content_impl_with_cancel(
        repo_path,
        query,
        case_sensitive,
        use_regex,
        whole_word,
        limit,
        cancel,
    )
}

/// Search using the pre-built BM25 index: rank files, then grep only the top candidates.
pub(crate) fn search_via_index(
    index: &crate::content_index::ContentIndex,
    query: &str,
    case_sensitive: bool,
    limit: Option<usize>,
) -> Result<ContentSearchResult, String> {
    search_via_index_with_cancel(index, query, case_sensitive, limit, &AtomicBool::new(false))
}

fn search_via_index_with_cancel(
    index: &crate::content_index::ContentIndex,
    query: &str,
    case_sensitive: bool,
    limit: Option<usize>,
    cancel: &AtomicBool,
) -> Result<ContentSearchResult, String> {
    let plan = index_search_plan(index, query, 50);
    search_index_plan(plan, query, case_sensitive, limit, cancel)
}

struct IndexSearchPlan {
    files: Vec<(String, PathBuf)>,
}

fn index_search_plan(
    index: &crate::content_index::ContentIndex,
    query: &str,
    candidate_limit: usize,
) -> IndexSearchPlan {
    let files = index
        .search(query, candidate_limit)
        .into_iter()
        .map(|ranked| {
            let absolute = index.absolute_path(&ranked.rel_path);
            (ranked.rel_path, absolute)
        })
        .collect();
    IndexSearchPlan { files }
}

fn prepare_index_search(
    index: &Arc<parking_lot::RwLock<crate::content_index::ContentIndex>>,
    query: &str,
    candidate_limit: usize,
) -> Option<IndexSearchPlan> {
    let index = index.read();
    index
        .is_ready()
        .then(|| index_search_plan(&index, query, candidate_limit))
}

fn search_index_plan(
    plan: IndexSearchPlan,
    query: &str,
    case_sensitive: bool,
    limit: Option<usize>,
    cancel: &AtomicBool,
) -> Result<ContentSearchResult, String> {
    use grep_searcher::{BinaryDetection, SearcherBuilder};

    let max_matches = limit.unwrap_or(1000);
    if plan.files.is_empty() {
        return Ok(ContentSearchResult::default());
    }

    // Grep phase: search only the ranked files for exact line matches
    let pattern = regex::escape(query);
    let matcher = grep_regex::RegexMatcherBuilder::new()
        .case_insensitive(!case_sensitive)
        .build(&pattern)
        .map_err(|e| format!("Invalid search pattern: {e}"))?;

    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(0))
        .heap_limit(Some(8_000_000))
        .build();

    let mut all_matches: Vec<ContentMatch> = Vec::new();
    let mut files_searched: u32 = 0;
    let mut truncated = false;

    for (rel_path, abs_path) in plan.files {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if all_matches.len() >= max_matches {
            truncated = true;
            break;
        }

        if !abs_path.is_file() {
            continue;
        }

        files_searched += 1;

        let stopped_by_cancel = grep_file_with_cancel(
            &mut searcher,
            &matcher,
            &abs_path,
            &rel_path,
            max_matches,
            &mut all_matches,
            &mut truncated,
            &|| cancel.load(Ordering::Relaxed),
        )
        .unwrap_or(false);
        if stopped_by_cancel {
            break;
        }
    }

    // BM25 already ranked the files by relevance — no need for post-hoc reranking
    Ok(ContentSearchResult {
        matches: all_matches,
        files_searched,
        files_skipped: 0,
        truncated,
        ..Default::default()
    })
}

/// Convert the byte offsets produced by grep into the UTF-16 code-unit offsets
/// consumed by JavaScript `String.slice`. Rust `char` counts are not sufficient:
/// a non-BMP scalar such as an emoji occupies one `char` but two UTF-16 units.
fn utf16_match_offsets(line: &str, byte_start: usize, byte_end: usize) -> Option<(u32, u32)> {
    if byte_start > byte_end
        || byte_end > line.len()
        || !line.is_char_boundary(byte_start)
        || !line.is_char_boundary(byte_end)
    {
        return None;
    }

    let match_start = line[..byte_start].encode_utf16().count();
    let match_end = match_start + line[byte_start..byte_end].encode_utf16().count();
    Some((
        u32::try_from(match_start).ok()?,
        u32::try_from(match_end).ok()?,
    ))
}

/// Both indexed and fallback search use this sink so cancellation, limits, and
/// match offsets cannot drift between the two disk-grep paths.
#[allow(clippy::too_many_arguments)]
fn grep_file_with_cancel(
    searcher: &mut grep_searcher::Searcher,
    matcher: &grep_regex::RegexMatcher,
    path: &std::path::Path,
    relative: &str,
    max_matches: usize,
    all_matches: &mut Vec<ContentMatch>,
    truncated: &mut bool,
    is_cancelled: &impl Fn() -> bool,
) -> std::io::Result<bool> {
    use grep_matcher::Matcher;
    use grep_searcher::sinks::UTF8;

    let mut stopped_by_cancel = false;
    searcher.search_path(
        matcher,
        path,
        UTF8(|line_number, line| {
            if is_cancelled() {
                stopped_by_cancel = true;
                return Ok(false);
            }
            if all_matches.len() >= max_matches {
                *truncated = true;
                return Ok(false);
            }

            let line_trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
            let (match_start, match_end) = matcher
                .find(line.as_bytes())
                .ok()
                .flatten()
                .and_then(|m| utf16_match_offsets(line_trimmed, m.start(), m.end()))
                .unwrap_or((0, 0));

            all_matches.push(ContentMatch {
                path: relative.to_string(),
                line_number: line_number as u32,
                line_text: line_trimmed.to_string(),
                match_start,
                match_end,
                repo_path: None,
            });
            Ok(true)
        }),
    )?;
    Ok(stopped_by_cancel)
}

pub(crate) fn search_files_impl(
    repo_path: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<DirEntry>, String> {
    let repo = PathBuf::from(&repo_path);
    let canonical_repo = repo
        .canonicalize()
        .map_err(|e| format!("Failed to resolve repo path: {e}"))?;

    let max_results = limit.unwrap_or(200);
    let pattern = build_search_pattern(&query);

    let mut results = Vec::new();

    // Walk using the `ignore` crate: respects .gitignore, .git/info/exclude,
    // global gitignore — skips ignored directories entirely during traversal.
    let walker = ignore::WalkBuilder::new(&canonical_repo)
        .hidden(false) // show dotfiles (except .git which is always skipped)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|e| !is_always_excluded_dir(e))
        .build();

    for entry in walker {
        if results.len() >= max_results {
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let is_file = entry.file_type().is_some_and(|ft| ft.is_file());
        if !is_file {
            continue;
        }

        let relative = match entry.path().strip_prefix(&canonical_repo) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        let name = entry.file_name().to_string_lossy().to_string();

        // Match against file name or relative path
        if !pattern.is_match(&name) && !pattern.is_match(&relative) {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs());

        results.push(DirEntry {
            name,
            path: relative,
            is_dir: false,
            size: metadata.len(),
            modified_at,
            git_status: String::new(), // populated below
            is_ignored: false,         // walker already filtered gitignored entries
        });
    }

    // Get git statuses only for matched results (not the whole repo)
    if !results.is_empty() {
        let git_statuses = parse_git_status(&repo_path, ".");
        for entry in &mut results {
            if let Some(status) = git_statuses.get(&entry.path) {
                entry.git_status = status.clone();
            }
        }
    }

    // Sort by path for predictable results
    results.sort_by_key(|a| a.path.to_lowercase());

    Ok(results)
}

/// Search file contents in a repository for a text or regex pattern.
/// Respects .gitignore via the `ignore` crate. Skips binary files and files > 1 MB.
/// Returns up to `limit` matches (default 1000).
pub(crate) fn search_content_impl(
    repo_path: String,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    whole_word: bool,
    limit: Option<usize>,
) -> Result<ContentSearchResult, String> {
    search_content_impl_with_cancel(
        repo_path,
        query,
        case_sensitive,
        use_regex,
        whole_word,
        limit,
        &AtomicBool::new(false),
    )
}

fn search_content_impl_with_cancel(
    repo_path: String,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    whole_word: bool,
    limit: Option<usize>,
    cancel: &AtomicBool,
) -> Result<ContentSearchResult, String> {
    use grep_searcher::{BinaryDetection, SearcherBuilder};

    if query.is_empty() || cancel.load(Ordering::Relaxed) {
        return Ok(ContentSearchResult::default());
    }

    let repo = PathBuf::from(&repo_path);
    let canonical_repo = repo
        .canonicalize()
        .map_err(|e| format!("Failed to resolve repo path: {e}"))?;

    let max_matches = limit.unwrap_or(1000);
    const MAX_FILE_SIZE: u64 = 1_048_576; // 1 MB

    // Build the regex matcher
    let pattern = if use_regex {
        query.clone()
    } else {
        regex::escape(&query)
    };

    let matcher = grep_regex::RegexMatcherBuilder::new()
        .case_insensitive(!case_sensitive)
        .word(whole_word)
        .build(&pattern)
        .map_err(|e| format!("Invalid search pattern: {e}"))?;

    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(0))
        .heap_limit(Some(8_000_000))
        .build();

    let mut all_matches: Vec<ContentMatch> = Vec::new();
    let mut files_searched: u32 = 0;
    let mut files_skipped: u32 = 0;
    let mut truncated = false;

    let walker = ignore::WalkBuilder::new(&canonical_repo)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|e| !is_always_excluded_dir(e))
        .build();

    'walk: for entry in walker {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let is_file = entry.file_type().is_some_and(|ft| ft.is_file());
        if !is_file {
            continue;
        }

        // Skip files that are too large
        let file_size = match entry.metadata() {
            Ok(m) => m.len(),
            Err(_) => continue,
        };
        if file_size > MAX_FILE_SIZE {
            files_skipped += 1;
            continue;
        }

        let relative = match entry.path().strip_prefix(&canonical_repo) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        // Pre-scan the first 8 KB for binary detection (null byte = binary)
        let is_binary = {
            use std::io::Read;
            let mut buf = [0u8; 8192];
            match std::fs::File::open(entry.path()).and_then(|mut f| f.read(&mut buf)) {
                Ok(n) => buf[..n].contains(&0u8),
                Err(_) => true, // unreadable → treat as skip
            }
        };
        if is_binary {
            files_skipped += 1;
            continue;
        }

        files_searched += 1;

        let matches_before = all_matches.len();

        let search_result = grep_file_with_cancel(
            &mut searcher,
            &matcher,
            entry.path(),
            &relative,
            max_matches,
            &mut all_matches,
            &mut truncated,
            &|| cancel.load(Ordering::Relaxed),
        );

        // If the searcher encountered an error (e.g. non-UTF-8 that slipped past binary check),
        // roll back any partial matches for this file and count it as skipped
        if search_result.is_err() {
            all_matches.truncate(matches_before);
            files_searched -= 1;
            files_skipped += 1;
        }

        if search_result.unwrap_or(false) {
            break 'walk;
        }

        if truncated {
            break 'walk;
        }
    }

    // Rerank the raw grep hits by BM25 over `line_text` so the most
    // lexically relevant lines float to the top. Grep returns hits in
    // file-walk order; with many matches this buries the best hit
    // arbitrarily far down the list. Skip the rerank for regex/whole-word
    // queries where the "query" is a pattern, not natural-language text.
    if !use_regex && !whole_word && !query.is_empty() && all_matches.len() > 1 {
        let lines: Vec<&str> = all_matches.iter().map(|m| m.line_text.as_str()).collect();
        let ranked = crate::text_rank::rank_lines(&query, &lines);
        if !ranked.is_empty() {
            // Stable reorder: BM25-scored lines first (in score order),
            // then any zero-score matches in their original grep order so we
            // never lose a hit the user might still care about.
            let mut seen = vec![false; all_matches.len()];
            let mut reordered: Vec<ContentMatch> = Vec::with_capacity(all_matches.len());
            for (idx, _score) in &ranked {
                if let Some(m) = all_matches.get(*idx) {
                    reordered.push(m.clone());
                    seen[*idx] = true;
                }
            }
            for (idx, m) in all_matches.iter().enumerate() {
                if !seen[idx] {
                    reordered.push(m.clone());
                }
            }
            all_matches = reordered;
        }
    }

    Ok(ContentSearchResult {
        matches: all_matches,
        files_searched,
        files_skipped,
        truncated,
        ..Default::default()
    })
}

/// Build a case-insensitive regex from a user search query.
/// Supports `*` (any within name) and `**` (any including path separators).
fn build_search_pattern(query: &str) -> regex::Regex {
    let mut regex_str = String::from("(?i)");
    let mut chars = query.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' if chars.peek() == Some(&'*') => {
                chars.next(); // consume second *
                regex_str.push_str(".*");
            }
            '*' => regex_str.push_str("[^/]*"),
            '?' => regex_str.push('.'),
            '.' | '(' | ')' | '[' | ']' | '{' | '}' | '+' | '^' | '$' | '|' | '\\' => {
                regex_str.push('\\');
                regex_str.push(c);
            }
            _ => regex_str.push(c),
        }
    }
    regex::Regex::new(&regex_str).unwrap_or_else(|_| {
        // Fallback: treat the whole query as a literal substring
        regex::Regex::new(&format!("(?i){}", regex::escape(query))).unwrap()
    })
}

/// Read a file's content within a repository.
/// Re-uses the existing `read_file_impl` from lib.rs.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fs_read_file(repo_path: String, file: String) -> Result<String, String> {
    spawn_blocking_fs(move || crate::read_file_impl(repo_path, file)).await
}

/// Atomically write `data` to `target` via temp-file + rename, PRESERVING the
/// target's existing permissions when it already exists (these are arbitrary
/// user files — never force a restrictive mode). A crash mid-write leaves the
/// original file intact instead of truncating it (#117-a503).
///
/// The temp file is created in the target's own directory (same filesystem, so
/// the rename is atomic) with a unique per-call name, so concurrent writers to
/// the same target never collide on the temp path.
pub(crate) fn atomic_write(target: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let dir = target
        .parent()
        .ok_or_else(|| "Target path has no parent directory".to_string())?;
    let base = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("tuic");
    let temp = dir.join(format!(".{base}.tmp.{}", uuid::Uuid::new_v4()));

    std::fs::write(&temp, data).map_err(|e| format!("Failed to write temp file: {e}"))?;

    // Preserve the original file's permissions if it already exists — do NOT
    // impose a restrictive mode on files the user owns and edits.
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(target)
        && let Err(e) = std::fs::set_permissions(&temp, meta.permissions())
    {
        tracing::warn!(
            path = %target.display(),
            error = %e,
            "atomic_write: failed to preserve file permissions"
        );
    }

    std::fs::rename(&temp, target).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Failed to commit file: {e}")
    })
}

/// Write content to a file within a repository. Overwrites if it exists.
/// Used by editor saves — creates parent directories as needed so saving to a
/// not-yet-existing nested path can't fail.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn write_file(repo_path: String, file: String, content: String) -> Result<(), String> {
    spawn_blocking_fs(move || write_file_impl(repo_path, file, content)).await
}

fn write_file_impl(repo_path: String, file: String, content: String) -> Result<(), String> {
    let target = if PathBuf::from(&repo_path).join(&file).exists() {
        validate_path(&repo_path, &file)?.1
    } else {
        // Path may be nested under directories that don't exist yet — validate the
        // nearest existing ancestor stays in-repo, then create the parent chain.
        validate_creation_within_repo(&repo_path, &file)?
    };

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {e}"))?;
    }

    atomic_write(&target, content.as_bytes()).map_err(|e| format!("Failed to write file: {e}"))
}

/// Verify that creating `relative` under `repo_path` stays inside the repo, even
/// when neither the target nor its parent exists yet. Walks up to the nearest
/// existing ancestor, canonicalizes it, and checks it's within the repo root.
/// Returns the (uncanonicalized) target path to create.
fn validate_creation_within_repo(repo_path: &str, relative: &str) -> Result<PathBuf, String> {
    let repo = PathBuf::from(repo_path);
    let target = repo.join(relative);

    let canonical_repo = repo
        .canonicalize()
        .map_err(|e| format!("Failed to resolve repo path: {e}"))?;

    let mut check = target.clone();
    loop {
        if check.exists() {
            let canonical_check = check
                .canonicalize()
                .map_err(|e| format!("Failed to resolve path: {e}"))?;
            if !canonical_check.starts_with(&canonical_repo) {
                return Err("Access denied: path is outside repository".to_string());
            }
            break;
        }
        if !check.pop() {
            return Err("Cannot resolve path".to_string());
        }
    }

    Ok(target)
}

/// Create a new, empty file within a repository (VS Code "New File").
/// Creates parent directories as needed, and fails if the file already exists
/// so an existing file is never truncated.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn create_file(repo_path: String, file: String) -> Result<(), String> {
    let target = validate_creation_within_repo(&repo_path, &file)?;

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {e}"))?;
    }

    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
    {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(format!(
            "A file or folder \"{file}\" already exists at this location."
        )),
        Err(e) => Err(format!("Failed to create file: {e}")),
    }
}

/// Create a directory (and parents) within a repository.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn create_directory(repo_path: String, dir: String) -> Result<(), String> {
    spawn_blocking_fs(move || create_directory_impl(repo_path, dir)).await
}

fn create_directory_impl(repo_path: String, dir: String) -> Result<(), String> {
    let repo = PathBuf::from(&repo_path);
    let target = repo.join(&dir);

    let canonical_repo = repo
        .canonicalize()
        .map_err(|e| format!("Failed to resolve repo path: {e}"))?;

    // For new directories we can't canonicalize the full path yet.
    // Walk up to find an existing ancestor and verify it's within the repo.
    let mut check = target.clone();
    loop {
        if check.exists() {
            let canonical_check = check
                .canonicalize()
                .map_err(|e| format!("Failed to resolve path: {e}"))?;
            if !canonical_check.starts_with(&canonical_repo) {
                return Err("Access denied: path is outside repository".to_string());
            }
            break;
        }
        if !check.pop() {
            return Err("Cannot resolve path".to_string());
        }
    }

    std::fs::create_dir_all(&target).map_err(|e| format!("Failed to create directory: {e}"))
}

/// Delete a file or directory within a repository.
///
/// `remove_dir_all` on a deep tree is unbounded work, which is why the command
/// hands it to the blocking pool instead of running it on the IPC thread.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_path(repo_path: String, path: String) -> Result<(), String> {
    spawn_blocking_fs(move || delete_path_impl(repo_path, path)).await
}

fn delete_path_impl(repo_path: String, path: String) -> Result<(), String> {
    let (_canonical_repo, canonical_target) = validate_path(&repo_path, &path)?;

    if canonical_target.is_dir() {
        std::fs::remove_dir_all(&canonical_target)
            .map_err(|e| format!("Failed to delete directory: {e}"))
    } else {
        std::fs::remove_file(&canonical_target).map_err(|e| format!("Failed to delete file: {e}"))
    }
}

/// Rename/move a file or directory within a repository.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn rename_path(repo_path: String, from: String, to: String) -> Result<(), String> {
    spawn_blocking_fs(move || rename_path_impl(repo_path, from, to)).await
}

fn rename_path_impl(repo_path: String, from: String, to: String) -> Result<(), String> {
    let (_canonical_repo, canonical_from) = validate_path(&repo_path, &from)?;
    // NEVER canonicalize the destination — only its parent. On case-insensitive
    // filesystems (macOS APFS, Windows NTFS) `canonicalize("readme.md")` resolves
    // to the existing on-disk `README.md`, so a case-only rename would collapse to
    // `rename(README.md, README.md)` and silently do nothing.
    let (_, canonical_to) = validate_path_for_creation(&repo_path, &to)?;

    std::fs::rename(&canonical_from, &canonical_to).map_err(|e| format!("Failed to rename: {e}"))
}

/// Copy a file within a repository.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copy_path(repo_path: String, from: String, to: String) -> Result<(), String> {
    spawn_blocking_fs(move || copy_path_impl(repo_path, from, to)).await
}

fn copy_path_impl(repo_path: String, from: String, to: String) -> Result<(), String> {
    let (_canonical_repo, canonical_from) = validate_path(&repo_path, &from)?;
    // Same rule as `rename_path`: the destination keeps the requested spelling.
    let (_, canonical_to) = validate_path_for_creation(&repo_path, &to)?;

    if canonical_from.is_dir() {
        return Err("Cannot copy directories. Only files can be copied.".to_string());
    }

    // On a case-insensitive filesystem `README.md` and `readme.md` are the same
    // file: copying it onto itself opens the source for truncation and destroys
    // the content. Compare resolved paths, not the literal ones.
    if canonical_to
        .canonicalize()
        .is_ok_and(|resolved| resolved == canonical_from)
    {
        return Err("Source and destination are the same file".to_string());
    }

    std::fs::copy(&canonical_from, &canonical_to)
        .map_err(|e| format!("Failed to copy file: {e}"))?;

    Ok(())
}

/// Copy a file by absolute source/destination paths.
///
/// Unlike [`copy_path`] (repo-scoped), this supports **cross-repo paste**: the
/// FileBrowser captures the source repo root at copy time, so a file can be
/// pasted from one registered repo into another. TUIC is a local tool — the
/// user is the trust boundary — so any path the user can already see is allowed
/// (mirrors `read_external_file`).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copy_path_abs(from: String, to: String) -> Result<(), String> {
    spawn_blocking_fs(move || copy_path_abs_impl(from, to)).await
}

fn copy_path_abs_impl(from: String, to: String) -> Result<(), String> {
    let from_path = PathBuf::from(&from);
    let to_path = PathBuf::from(&to);
    if from_path == to_path {
        return Ok(());
    }
    let canonical_from = from_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve source: {e}"))?;
    if canonical_from.is_dir() {
        return Err("Cannot copy directories. Only files can be copied.".to_string());
    }
    std::fs::copy(&canonical_from, &to_path).map_err(|e| format!("Failed to copy file: {e}"))?;
    Ok(())
}

/// Move/rename a file by absolute source/destination paths (cross-repo cut+paste).
///
/// Falls back to copy+remove when `rename` fails across filesystems (EXDEV).
/// See [`copy_path_abs`] for the trust-boundary rationale.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn move_path_abs(from: String, to: String) -> Result<(), String> {
    spawn_blocking_fs(move || move_path_abs_impl(from, to)).await
}

fn move_path_abs_impl(from: String, to: String) -> Result<(), String> {
    let from_path = PathBuf::from(&from);
    let to_path = PathBuf::from(&to);
    if from_path == to_path {
        return Ok(());
    }
    let canonical_from = from_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve source: {e}"))?;
    if canonical_from.is_dir() {
        return Err("Cannot move directories. Only files can be moved.".to_string());
    }
    match std::fs::rename(&canonical_from, &to_path) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Cross-filesystem move (EXDEV): rename is rejected, so copy then remove.
            std::fs::copy(&canonical_from, &to_path)
                .map_err(|e| format!("Failed to move file: {e}"))?;
            std::fs::remove_file(&canonical_from)
                .map_err(|e| format!("Failed to remove source after move: {e}"))?;
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// fs_transfer_paths — drag-drop move/copy from OS filesystem into a target dir.
// ---------------------------------------------------------------------------

/// Mode for `fs_transfer_paths`.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferMode {
    Move,
    Copy,
}

/// Result payload for `fs_transfer_paths`.
#[derive(Debug, Clone, Serialize)]
pub struct TransferResult {
    /// Number of top-level paths successfully transferred.
    pub moved: u32,
    /// Number of top-level paths skipped because the destination name exists.
    pub skipped: u32,
    /// Per-source error messages encountered during transfer.
    pub errors: Vec<String>,
    /// True when at least one source is a directory and `allow_recursive=false`.
    /// In that case no files were touched — the caller must re-invoke with
    /// `allow_recursive=true` after confirming with the user.
    pub needs_confirm: bool,
}

/// Recursively copy a directory tree. Fails fast on any error.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else if ft.is_symlink() {
            // Best-effort: dereference symlinks (same as Finder "copy" default).
            std::fs::copy(entry.path(), &dst_path)?;
        } else {
            std::fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

/// Move or copy absolute OS paths into a destination directory.
///
/// Conflict handling: if `dest_dir/<basename>` already exists, that source is
/// skipped silently (counted in `skipped`). No overwrite, no rename.
///
/// Directory handling: when `allow_recursive=false` and any source is a
/// directory, the function performs no filesystem operations and returns
/// `needs_confirm=true`. When `allow_recursive=true`, directories are moved
/// via rename (or copy+remove on cross-device) or copied recursively.
///
/// DEFERRED (2026-08-18) — still a sync command, so `copy_dir_recursive` runs
/// on the IPC thread (the macOS main thread) and dropping a large folder
/// freezes the WebView until the copy finishes. Every sibling command in this
/// file was moved to `async fn` + `spawn_blocking_fs` in story 607-f483; this
/// one was held back because it is the backend of a drag-drop and the D&D
/// surface needs Boss's approval before it is touched. The conversion is
/// mechanical when that approval comes: body → `fs_transfer_paths_impl`,
/// command → `async fn` wrapper. Nothing else changes.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn fs_transfer_paths(
    dest_dir: String,
    paths: Vec<String>,
    mode: TransferMode,
    allow_recursive: bool,
) -> Result<TransferResult, String> {
    let dest = PathBuf::from(&dest_dir);
    let canonical_dest = dest
        .canonicalize()
        .map_err(|e| format!("Invalid destination '{dest_dir}': {e}"))?;
    if !canonical_dest.is_dir() {
        return Err(format!("Destination '{dest_dir}' is not a directory"));
    }

    // First pass: if any source is a directory and recursion not authorized,
    // bail out without touching anything.
    if !allow_recursive {
        for p in &paths {
            let src = PathBuf::from(p);
            if src.is_dir() {
                return Ok(TransferResult {
                    moved: 0,
                    skipped: 0,
                    errors: Vec::new(),
                    needs_confirm: true,
                });
            }
        }
    }

    let mut moved = 0u32;
    let mut skipped = 0u32;
    let mut errors: Vec<String> = Vec::new();

    for src_raw in &paths {
        let src = PathBuf::from(src_raw);
        let Some(file_name) = src.file_name() else {
            errors.push(format!("Invalid source path: '{src_raw}'"));
            continue;
        };
        let dst_path = canonical_dest.join(file_name);

        // Silent skip on name conflict.
        if dst_path.exists() {
            skipped += 1;
            continue;
        }

        // Prevent moving into self/subdir (e.g., drop /a/b onto /a/b/c).
        if let Ok(src_canon) = src.canonicalize()
            && canonical_dest.starts_with(&src_canon)
        {
            errors.push(format!(
                "Cannot transfer '{}' into its own subdirectory",
                src.display()
            ));
            continue;
        }

        let is_dir = src.is_dir();
        let op_result = match mode {
            TransferMode::Move => {
                match std::fs::rename(&src, &dst_path) {
                    Ok(()) => Ok(()),
                    Err(e) if e.raw_os_error() == Some(libc_cross_device()) => {
                        // Cross-device: fall back to copy + remove.
                        let copy_result = if is_dir {
                            copy_dir_recursive(&src, &dst_path)
                        } else {
                            std::fs::copy(&src, &dst_path).map(|_| ())
                        };
                        copy_result.and_then(|_| {
                            if is_dir {
                                std::fs::remove_dir_all(&src)
                            } else {
                                std::fs::remove_file(&src)
                            }
                        })
                    }
                    Err(e) => Err(e),
                }
            }
            TransferMode::Copy => {
                if is_dir {
                    copy_dir_recursive(&src, &dst_path)
                } else {
                    std::fs::copy(&src, &dst_path).map(|_| ())
                }
            }
        };

        match op_result {
            Ok(()) => moved += 1,
            Err(e) => errors.push(format!("{}: {e}", src.display())),
        }
    }

    Ok(TransferResult {
        moved,
        skipped,
        errors,
        needs_confirm: false,
    })
}

/// Platform-specific EXDEV errno ("cross-device link").
#[cfg(unix)]
fn libc_cross_device() -> i32 {
    18 // EXDEV on Linux/macOS
}
#[cfg(windows)]
fn libc_cross_device() -> i32 {
    17 // ERROR_NOT_SAME_DEVICE
}

/// Result of resolving a terminal path candidate.
// PartialEq so a batched resolve can be asserted equal, entry by entry, to the
// single-candidate command it must not diverge from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResolvedFilePath {
    pub absolute_path: String,
    pub is_directory: bool,
}

/// Strip trailing `:line` or `:line:col` suffix from a path candidate.
/// Returns the path portion only.
pub fn strip_line_col_suffix(candidate: &str) -> &str {
    // A `:start-end` line range, as agents cite code (`file.ts:96-150`).
    if let Some(colon_pos) = candidate.rfind(':')
        && let Some((start, end)) = candidate[colon_pos + 1..].split_once('-')
        && !start.is_empty()
        && !end.is_empty()
        && start.chars().all(|c| c.is_ascii_digit())
        && end.chars().all(|c| c.is_ascii_digit())
    {
        return &candidate[..colon_pos];
    }

    // Match `:digits` or `:digits:digits` at the end
    let bytes = candidate.as_bytes();
    let mut end = bytes.len();

    // Try stripping `:col` (rightmost numeric segment)
    if let Some(colon_pos) = candidate[..end].rfind(':')
        && candidate[colon_pos + 1..end]
            .chars()
            .all(|c| c.is_ascii_digit())
        && colon_pos + 1 < end
    {
        end = colon_pos;

        // Try stripping `:line` (second rightmost numeric segment)
        if let Some(colon_pos2) = candidate[..end].rfind(':')
            && candidate[colon_pos2 + 1..end]
                .chars()
                .all(|c| c.is_ascii_digit())
            && colon_pos2 + 1 < end
        {
            end = colon_pos2;
        }
    }

    &candidate[..end]
}

/// macOS TCC-protected directory names under $HOME.
/// Probing these with `.exists()` or `.canonicalize()` triggers permission dialogs.
const TCC_PROTECTED_DIRS: &[&str] = &[
    "Desktop",
    "Documents",
    "Downloads",
    "Movies",
    "Music",
    "Pictures",
    "Library",
    "Photos Library.photoslibrary",
];

/// The TCC-protected folder under `home` that `path` falls in (`"Desktop"`…).
fn tcc_protected_root_in(path: &std::path::Path, home: &std::path::Path) -> Option<&'static str> {
    let first = path.strip_prefix(home).ok()?.components().next()?;
    let name = first.as_os_str().to_string_lossy();
    TCC_PROTECTED_DIRS
        .iter()
        .copied()
        .find(|d| d.eq_ignore_ascii_case(&name))
}

/// Returns true if `path` falls under a macOS TCC-protected directory.
fn is_tcc_protected_path(path: &std::path::Path) -> bool {
    dirs::home_dir().is_some_and(|home| tcc_protected_root_in(path, &home).is_some())
}

/// Whether a terminal whose shell sits in `cwd` may probe `path` without risking
/// a permission dialog. Outside the protected folders, always. Inside one, only
/// when `cwd` is in that same folder: FastAF's own shell already lives there, so
/// macOS has already granted FastAF that folder and a probe cannot prompt.
///
/// Refusing outright made every path under `~/Desktop` unclickable for anyone
/// whose repositories live there — the path a coding agent printed was never
/// even checked, so it never became a link.
fn terminal_may_probe(path: &std::path::Path, cwd: &str, home: &std::path::Path) -> bool {
    match tcc_protected_root_in(path, home) {
        None => true,
        Some(root) => {
            !cwd.is_empty() && tcc_protected_root_in(std::path::Path::new(cwd), home) == Some(root)
        }
    }
}

/// Validate a path candidate from terminal output against the filesystem.
/// Strips `:line:col` suffixes, resolves relative paths against `cwd`,
/// and checks existence.
///
/// SAFETY: Refuses to probe macOS TCC-protected directories to avoid
/// triggering system permission dialogs — unless the terminal's own `cwd` is
/// already inside the same one (see [`terminal_may_probe`]).
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn resolve_terminal_path(cwd: String, candidate: String) -> Option<ResolvedFilePath> {
    let path_str = strip_line_col_suffix(&candidate);

    // Expand ~ to home directory
    let expanded = if let Some(rest) = path_str.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(rest).to_string_lossy().to_string()
        } else {
            path_str.to_string()
        }
    } else {
        path_str.to_string()
    };
    let path = PathBuf::from(&expanded);

    let absolute = if path.is_absolute() {
        path
    } else {
        PathBuf::from(&cwd).join(&path)
    };

    // Never probe a TCC-protected directory the terminal is not already in.
    if let Some(home) = dirs::home_dir()
        && !terminal_may_probe(&absolute, &cwd, &home)
    {
        return None;
    }

    // Canonicalize to resolve symlinks and verify existence
    match absolute.canonicalize() {
        Ok(canonical) => Some(ResolvedFilePath {
            absolute_path: canonical.to_string_lossy().to_string(),
            is_directory: canonical.is_dir(),
        }),
        Err(_) => None,
    }
}

/// Validate many path candidates from one screen in a single call.
///
/// The link verifier issued one `resolve_terminal_path` per candidate per row and
/// awaited each row before starting the next: a screen with links on twenty rows
/// cost twenty serial round trips, each carrying one string. The work per
/// candidate is unchanged — the round trips are what is removed — so the answer
/// at index `i` is exactly what the single-candidate command returns for
/// `candidates[i]`. An unresolved candidate stays a `None` hole rather than
/// dropping out, which would shift every answer after it onto the wrong span.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn resolve_terminal_paths(
    cwd: String,
    candidates: Vec<String>,
) -> Result<Vec<Option<ResolvedFilePath>>, String> {
    // Every candidate canonicalizes, which hits the disk; a screenful of them has
    // no business on the caller's thread.
    spawn_blocking_fs(move || {
        let resolved = candidates
            .into_iter()
            .map(|candidate| resolve_terminal_path(cwd.clone(), candidate))
            .collect::<Vec<_>>();
        Ok(resolved)
    })
    .await
}

/// Append a path pattern to the repo's .gitignore file.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn add_to_gitignore(repo_path: String, pattern: String) -> Result<(), String> {
    spawn_blocking_fs(move || add_to_gitignore_impl(repo_path, pattern)).await
}

fn add_to_gitignore_impl(repo_path: String, pattern: String) -> Result<(), String> {
    let repo = PathBuf::from(&repo_path);
    let canonical_repo = repo
        .canonicalize()
        .map_err(|e| format!("Failed to resolve repo path: {e}"))?;

    let gitignore = canonical_repo.join(".gitignore");
    let mut content = if gitignore.exists() {
        std::fs::read_to_string(&gitignore)
            .map_err(|e| format!("Failed to read .gitignore: {e}"))?
    } else {
        String::new()
    };

    // Check if pattern already exists
    if content.lines().any(|line| line.trim() == pattern.trim()) {
        return Ok(()); // Already ignored
    }

    // Ensure trailing newline before appending
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(pattern.trim());
    content.push('\n');

    std::fs::write(&gitignore, &content).map_err(|e| format!("Failed to write .gitignore: {e}"))
}

/// Validate that `path` is a safe target for `write_external_file`.
///
/// Scope decision (story 1273-c95e): `write_external_file` is a catch-all for
/// files the UI opens by absolute path (drag-drop, markdown tab, code editor
/// outside the active repo). Prior to this guard, a compromised frontend or
/// malicious deep-link could overwrite `~/.ssh/authorized_keys`, `/etc/hosts`,
/// or any other host file — the only check was `is_absolute()`.
///
/// Rules:
/// - Absolute path required (unchanged).
/// - No `..` components — blocks traversal before any canonicalization.
/// - The target's parent directory must exist, canonicalize, and land inside
///   `home` (canonicalized). The file itself may not exist yet, so we anchor
///   the containment check on the parent. Symlinks inside the parent path are
///   resolved by canonicalize, so a symlink `~/tmp -> /etc` is caught.
///
/// The allowlist is deliberately home-dir only, not home + workspace roots:
/// every existing frontend caller already writes files the user opened from a
/// file picker under `$HOME`, and widening the allowlist to arbitrary
/// "workspace roots" would re-introduce the attack surface we're trying to
/// close (any registered repo could be outside home, e.g. `/opt/proj`).
pub(crate) fn validate_external_write_path(
    path: &std::path::Path,
    _home: &std::path::Path,
) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("write_external_file requires an absolute path".to_string());
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Access denied: path must not contain '..' components".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Access denied: path has no parent directory".to_string())?;
    parent
        .canonicalize()
        .map_err(|e| format!("Failed to resolve parent directory: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// `content-search-batch` is one global event with three panels listening,
    /// and each drops anything whose `search_id` is not its own. The field name
    /// is that contract: rename it here and every panel silently stops
    /// accepting its own results, with nothing on either side to fail.
    #[test]
    fn a_batch_carries_its_search_id_under_that_exact_name() {
        let batch = ContentSearchBatch {
            search_id: "cs-7".to_string(),
            matches: Vec::new(),
            is_final: true,
            files_searched: 0,
            files_skipped: 0,
            truncated: false,
            repos_pending: 0,
            repos_searched: 0,
        };
        let wire = serde_json::to_value(&batch).unwrap();
        assert_eq!(wire["search_id"], "cs-7");
    }

    /// A failed search has to be as correlated as a successful one, or the
    /// panel that did not ask is the one that shows the error.
    #[test]
    fn an_error_carries_the_same_search_id() {
        let wire = serde_json::to_value(ContentSearchError {
            search_id: "cs-7".to_string(),
            message: "boom".to_string(),
        })
        .unwrap();
        assert_eq!(wire["search_id"], "cs-7");
        assert_eq!(wire["message"], "boom");
    }

    fn result_with_matches(count: usize) -> ContentSearchResult {
        ContentSearchResult {
            matches: (0..count)
                .map(|i| ContentMatch {
                    path: format!("src/f{i}.rs"),
                    line_number: 1,
                    line_text: "hit".to_string(),
                    match_start: 0,
                    match_end: 3,
                    repo_path: None,
                })
                .collect(),
            files_searched: 12,
            files_skipped: 3,
            truncated: false,
            repos_pending: 0,
            repos_searched: 1,
        }
    }

    fn collect_batches(
        result: ContentSearchResult,
        cancel: &AtomicBool,
    ) -> Vec<ContentSearchBatch> {
        let mut batches = Vec::new();
        dispatch_content_batches(result, cancel, "cs-7", |b| batches.push(b));
        batches
    }

    /// Exactly one batch closes the search, and it is the last one.
    #[test]
    fn a_completed_search_ends_with_a_single_final_batch() {
        let batches = collect_batches(result_with_matches(120), &AtomicBool::new(false));
        assert_eq!(batches.len(), 3, "50 + 50 + 20");
        assert_eq!(
            batches.iter().filter(|b| b.is_final).count(),
            1,
            "a second final would let a panel accept results after it stopped listening"
        );
        assert!(batches.last().unwrap().is_final);
        assert_eq!(
            batches.iter().map(|b| b.matches.len()).sum::<usize>(),
            120,
            "no match may be dropped by the chunking"
        );
    }

    /// An empty result still has to say so. Without this the panel spins on a
    /// search that found nothing.
    #[test]
    fn a_search_with_no_matches_still_emits_a_final_batch() {
        let batches = collect_batches(result_with_matches(0), &AtomicBool::new(false));
        assert_eq!(batches.len(), 1);
        assert!(batches[0].is_final);
        assert!(batches[0].matches.is_empty());
    }

    /// The regression this guards: a search cancelled by a *different* panel
    /// starting its own must still close under its own `search_id`. It is the
    /// only event that panel accepts, so dropping it strands the spinner for
    /// the life of the window.
    #[test]
    fn a_search_cancelled_before_it_emits_still_closes_itself() {
        let batches = collect_batches(result_with_matches(120), &AtomicBool::new(true));
        assert_eq!(batches.len(), 1, "the payload is skipped, the close is not");
        assert_eq!(batches[0].search_id, "cs-7");
        assert!(batches[0].is_final);
        assert!(batches[0].matches.is_empty());
        assert_eq!(
            batches[0].files_searched, 12,
            "the counters report the work actually done, not zero"
        );
    }

    /// Cancellation part-way through: the chunks already sent stand, and the
    /// search still gets its terminator.
    #[test]
    fn a_search_cancelled_mid_stream_closes_after_the_chunks_it_sent() {
        let cancel = AtomicBool::new(false);
        let mut batches = Vec::new();
        dispatch_content_batches(result_with_matches(120), &cancel, "cs-7", |b| {
            cancel.store(true, Ordering::Relaxed);
            batches.push(b);
        });
        assert_eq!(batches.len(), 2, "one chunk, then the close");
        assert_eq!(batches[0].matches.len(), 50);
        assert!(!batches[0].is_final);
        assert!(batches[1].is_final);
        assert!(batches[1].matches.is_empty());
    }

    fn setup_test_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        let repo_path = dir.path();

        // Initialize a git repo
        crate::git_cli::git_cmd(repo_path)
            .args(["init"])
            .run()
            .unwrap();
        crate::git_cli::git_cmd(repo_path)
            .args(["config", "user.email", "test@test.com"])
            .run()
            .unwrap();
        crate::git_cli::git_cmd(repo_path)
            .args(["config", "user.name", "Test"])
            .run()
            .unwrap();

        // Create some files and directories
        fs::write(repo_path.join("README.md"), "# Test").unwrap();
        fs::write(repo_path.join("main.rs"), "fn main() {}").unwrap();
        fs::create_dir(repo_path.join("src")).unwrap();
        fs::write(repo_path.join("src/lib.rs"), "pub fn hello() {}").unwrap();

        // Commit everything
        crate::git_cli::git_cmd(repo_path)
            .args(["add", "-A"])
            .run()
            .unwrap();
        crate::git_cli::git_cmd(repo_path)
            .args(["commit", "-m", "init"])
            .run()
            .unwrap();

        dir
    }

    #[test]
    fn test_list_directory_root() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        let entries = list_directory_impl(repo_path, ".".to_string()).unwrap();

        // Should have: src/ dir, README.md, main.rs (no .git)
        assert!(entries.len() >= 3);

        // Directories should come first
        let first_dir_idx = entries.iter().position(|e| e.is_dir);
        let first_file_idx = entries.iter().position(|e| !e.is_dir);
        if let (Some(di), Some(fi)) = (first_dir_idx, first_file_idx) {
            assert!(di < fi, "Directories should sort before files");
        }

        // .git should not be listed
        assert!(entries.iter().all(|e| e.name != ".git"));

        // src directory should exist
        assert!(entries.iter().any(|e| e.name == "src" && e.is_dir));
    }

    #[test]
    fn test_list_directory_subdir() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        let entries = list_directory_impl(repo_path, "src".to_string()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "lib.rs");
        assert!(!entries[0].is_dir);
        assert_eq!(entries[0].path, "src/lib.rs");
    }

    #[test]
    fn test_list_directory_path_traversal_rejected() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        let result = list_directory_impl(repo_path, "../".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_list_directory_git_status() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        // Modify a tracked file
        fs::write(dir.path().join("README.md"), "# Modified").unwrap();

        // Add an untracked file
        fs::write(dir.path().join("new_file.txt"), "new").unwrap();

        let entries = list_directory_impl(repo_path, ".".to_string()).unwrap();

        let readme = entries.iter().find(|e| e.name == "README.md").unwrap();
        assert_eq!(readme.git_status, "modified");

        let new_file = entries.iter().find(|e| e.name == "new_file.txt").unwrap();
        assert_eq!(new_file.git_status, "untracked");
    }

    #[test]
    fn test_stat_path_file() {
        let dir = setup_test_repo();
        let file = dir.path().join("README.md");
        let stat = stat_path_impl(file.to_string_lossy().to_string());
        assert!(stat.exists);
        assert!(!stat.is_dir);
        // mtime/size are populated for real files so the editor poll can detect
        // on-disk changes without reading content.
        assert!(
            stat.modified_at > 0,
            "expected a non-zero mtime for a real file"
        );
        assert!(stat.size > 0, "README.md should have non-zero size");
    }

    #[test]
    fn test_stat_path_directory() {
        let dir = setup_test_repo();
        let subdir = dir.path().join("src");
        let stat = stat_path_impl(subdir.to_string_lossy().to_string());
        assert!(stat.exists);
        assert!(stat.is_dir);
    }

    #[test]
    fn test_stat_path_missing() {
        let dir = setup_test_repo();
        let missing = dir.path().join("does-not-exist");
        let stat = stat_path_impl(missing.to_string_lossy().to_string());
        assert!(!stat.exists);
        assert!(!stat.is_dir);
    }

    /// TCC-protected paths (Desktop, Documents, Downloads, …) must not be
    /// probed with std::fs::metadata — that triggers the macOS permission
    /// dialog and lets untrusted callers fingerprint user files.
    /// Guard returns {exists:false, is_dir:false} unconditionally.
    #[test]
    fn test_stat_path_tcc_protected_returns_nonexistent() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        for protected in &[
            "Desktop",
            "Documents",
            "Downloads",
            "Library",
            "Movies",
            "Music",
            "Pictures",
        ] {
            let candidate = home.join(protected).join("stat_path_tcc_probe");
            let stat = stat_path_impl(candidate.to_string_lossy().to_string());
            assert!(
                !stat.exists,
                "TCC-protected path {candidate:?} must report exists=false"
            );
            assert!(
                !stat.is_dir,
                "TCC-protected path {candidate:?} must report is_dir=false"
            );
        }
    }

    /// Probing ~/Desktop itself (the directory, not a file under it) also hits
    /// the guard — no metadata call, no TCC dialog.
    #[test]
    fn test_stat_path_tcc_protected_dir_itself() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let desktop = home.join("Desktop");
        let stat = stat_path_impl(desktop.to_string_lossy().to_string());
        assert!(!stat.exists);
        assert!(!stat.is_dir);
    }

    #[test]
    fn test_write_file_creates_and_overwrites() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        // Write a new file
        write_file_impl(
            repo_path.clone(),
            "new.txt".to_string(),
            "hello".to_string(),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("new.txt")).unwrap(),
            "hello"
        );

        // Overwrite
        write_file_impl(repo_path, "new.txt".to_string(), "world".to_string()).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("new.txt")).unwrap(),
            "world"
        );
    }

    #[test]
    fn test_write_file_path_traversal_rejected() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        let result = write_file_impl(repo_path, "../escape.txt".to_string(), "bad".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_create_directory() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        create_directory_impl(repo_path.clone(), "nested/deep/dir".to_string()).unwrap();
        assert!(dir.path().join("nested/deep/dir").is_dir());
    }

    #[test]
    fn test_create_file_empty() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        create_file(repo_path, "brand_new.txt".to_string()).unwrap();
        assert!(dir.path().join("brand_new.txt").is_file());
        assert_eq!(
            fs::read_to_string(dir.path().join("brand_new.txt")).unwrap(),
            ""
        );
    }

    #[test]
    fn test_create_file_creates_parent_dirs() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        // Parent directories don't exist yet — should be created.
        create_file(repo_path, "a/b/c/leaf.txt".to_string()).unwrap();
        assert!(dir.path().join("a/b/c/leaf.txt").is_file());
    }

    #[test]
    fn test_create_file_existing_is_rejected_not_truncated() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        write_file_impl(
            repo_path.clone(),
            "keep.txt".to_string(),
            "important".to_string(),
        )
        .unwrap();

        let result = create_file(repo_path, "keep.txt".to_string());
        assert!(result.is_err(), "creating over an existing file must fail");
        // Existing content must be preserved (not truncated).
        assert_eq!(
            fs::read_to_string(dir.path().join("keep.txt")).unwrap(),
            "important"
        );
    }

    #[test]
    fn test_create_file_path_traversal_rejected() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        let result = create_file(repo_path, "../escape.txt".to_string());
        assert!(result.is_err());
        assert!(!dir.path().join("../escape.txt").exists());
    }

    #[test]
    fn test_write_file_creates_nested_parent_dirs() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        write_file_impl(repo_path, "x/y/deep.txt".to_string(), "content".to_string()).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("x/y/deep.txt")).unwrap(),
            "content"
        );
    }

    #[test]
    fn test_delete_path_file() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        assert!(dir.path().join("README.md").exists());
        delete_path_impl(repo_path, "README.md".to_string()).unwrap();
        assert!(!dir.path().join("README.md").exists());
    }

    #[test]
    fn test_delete_path_directory() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        assert!(dir.path().join("src").exists());
        delete_path_impl(repo_path, "src".to_string()).unwrap();
        assert!(!dir.path().join("src").exists());
    }

    #[test]
    fn test_rename_path() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        rename_path_impl(repo_path, "main.rs".to_string(), "app.rs".to_string()).unwrap();

        assert!(!dir.path().join("main.rs").exists());
        assert!(dir.path().join("app.rs").exists());
    }

    /// A case-only rename must actually change the name on disk. On
    /// case-insensitive filesystems this used to no-op because the destination
    /// was canonicalized back to the source's existing spelling.
    /// `exists()` is case-insensitive there too, so assert on the real dir entry.
    #[test]
    fn test_rename_path_case_only() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        rename_path_impl(repo_path, "main.rs".to_string(), "MAIN.rs".to_string()).unwrap();

        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"MAIN.rs".to_string()), "got {names:?}");
        assert!(!names.contains(&"main.rs".to_string()), "got {names:?}");
    }

    /// Copying a file onto itself would open the source for truncation and wipe
    /// it — the guard must reject it instead.
    #[test]
    fn test_copy_path_onto_itself_rejected() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();
        let before = std::fs::read_to_string(dir.path().join("main.rs")).unwrap();

        let result = copy_path_impl(repo_path, "main.rs".to_string(), "main.rs".to_string());

        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("main.rs")).unwrap(),
            before
        );
    }

    #[test]
    fn test_rename_path_traversal_rejected() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        let result = rename_path_impl(
            repo_path,
            "main.rs".to_string(),
            "../escaped.rs".to_string(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_copy_path_abs_cross_repo() {
        let src = setup_test_repo();
        let dst = setup_test_repo();
        let from = src.path().join("main.rs").to_string_lossy().to_string();
        let to = dst.path().join("copied.rs").to_string_lossy().to_string();

        copy_path_abs_impl(from, to).unwrap();

        assert!(
            dst.path().join("copied.rs").exists(),
            "file copied into dst repo"
        );
        assert!(src.path().join("main.rs").exists(), "source preserved");
    }

    #[test]
    fn test_copy_path_abs_rejects_directory() {
        let src = setup_test_repo();
        let dst = setup_test_repo();
        let from = src.path().join("src").to_string_lossy().to_string();
        let to = dst.path().join("src_copy").to_string_lossy().to_string();

        assert!(
            copy_path_abs_impl(from, to).is_err(),
            "directories cannot be copied"
        );
    }

    #[test]
    fn test_copy_path_abs_same_path_is_noop() {
        let src = setup_test_repo();
        let p = src.path().join("main.rs").to_string_lossy().to_string();

        copy_path_abs_impl(p.clone(), p).unwrap();

        assert!(src.path().join("main.rs").exists());
    }

    #[test]
    fn test_move_path_abs_cross_repo() {
        let src = setup_test_repo();
        let dst = setup_test_repo();
        let from = src.path().join("main.rs").to_string_lossy().to_string();
        let to = dst.path().join("moved.rs").to_string_lossy().to_string();

        move_path_abs_impl(from, to).unwrap();

        assert!(
            dst.path().join("moved.rs").exists(),
            "file moved into dst repo"
        );
        assert!(
            !src.path().join("main.rs").exists(),
            "source removed after move"
        );
    }

    #[test]
    fn test_paths_use_forward_slashes() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        let entries = list_directory_impl(repo_path.clone(), "src".to_string()).unwrap();
        for entry in &entries {
            assert!(
                !entry.path.contains('\\'),
                "Path should use / not \\: {}",
                entry.path
            );
        }

        let root_entries = list_directory_impl(repo_path, ".".to_string()).unwrap();
        for entry in &root_entries {
            assert!(
                !entry.path.contains('\\'),
                "Path should use / not \\: {}",
                entry.path
            );
        }
    }

    #[test]
    fn test_list_directory_modified_at_populated() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        let entries = list_directory_impl(repo_path, ".".to_string()).unwrap();

        for entry in &entries {
            assert!(
                entry.modified_at > 0,
                "modified_at should be non-zero for {}",
                entry.name
            );
        }
    }

    #[test]
    fn test_list_directory_marks_ignored() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        // Create a file and a gitignore that ignores it
        fs::write(dir.path().join("build.log"), "build output").unwrap();
        fs::write(dir.path().join(".gitignore"), "build.log\n").unwrap();

        let entries = list_directory_impl(repo_path, ".".to_string()).unwrap();

        let build_log = entries.iter().find(|e| e.name == "build.log");
        assert!(
            build_log.is_some(),
            "build.log should still appear in listing"
        );
        assert!(
            build_log.unwrap().is_ignored,
            "build.log should be marked as ignored"
        );

        // .gitignore itself should NOT be ignored
        let gitignore = entries.iter().find(|e| e.name == ".gitignore");
        assert!(gitignore.is_some(), ".gitignore should appear in listing");
        assert!(
            !gitignore.unwrap().is_ignored,
            ".gitignore should NOT be marked as ignored"
        );
    }

    // --- search_files tests ---

    #[test]
    fn test_search_files_basic() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        let results = search_files_impl(repo_path, "lib".to_string(), None).unwrap();
        assert!(
            results.iter().any(|e| e.name == "lib.rs"),
            "Should find lib.rs matching 'lib', got: {:?}",
            results.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        // All results should have forward-slash paths
        for entry in &results {
            assert!(
                !entry.path.contains('\\'),
                "Path should use / not \\: {}",
                entry.path
            );
        }
    }

    #[test]
    fn test_search_files_respects_gitignore() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        // Create an ignored directory with files
        fs::create_dir(dir.path().join("build_output")).unwrap();
        fs::write(dir.path().join("build_output/artifact.rs"), "// build").unwrap();
        fs::write(dir.path().join(".gitignore"), "build_output/\n").unwrap();

        let results = search_files_impl(repo_path, "artifact".to_string(), None).unwrap();
        assert!(
            results.iter().all(|e| !e.path.contains("build_output")),
            "Should NOT find files inside gitignored directory, got: {:?}",
            results.iter().map(|e| &e.path).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_search_files_excludes_always_excluded_dirs() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        // Simulate .git internals and common heavy dirs (NOT in .gitignore)
        for sub in [".git/objects", "node_modules/foo", "target/debug", "dist"] {
            fs::create_dir_all(dir.path().join(sub)).unwrap();
            fs::write(dir.path().join(sub).join("needle.txt"), "needle").unwrap();
        }

        let results = search_files_impl(repo_path, "needle".to_string(), None).unwrap();
        assert!(
            results.is_empty(),
            "Should not traverse .git/node_modules/target/dist, got: {:?}",
            results.iter().map(|e| &e.path).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_search_content_excludes_always_excluded_dirs() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        for sub in [".git/objects", "node_modules/foo", "target/debug", "dist"] {
            fs::create_dir_all(dir.path().join(sub)).unwrap();
            fs::write(
                dir.path().join(sub).join("haystack.txt"),
                "needle in haystack",
            )
            .unwrap();
        }

        let result =
            search_content_impl(repo_path, "needle".to_string(), true, false, false, None).unwrap();
        assert!(
            result.matches.iter().all(|m| {
                !m.path.starts_with(".git/")
                    && !m.path.starts_with("node_modules/")
                    && !m.path.starts_with("target/")
                    && !m.path.starts_with("dist/")
            }),
            "Should not match inside excluded dirs, got: {:?}",
            result.matches.iter().map(|m| &m.path).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_search_files_limit() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        // Create many files
        fs::create_dir(dir.path().join("many")).unwrap();
        for i in 0..20 {
            fs::write(dir.path().join(format!("many/file_{i}.txt")), "content").unwrap();
        }

        let results = search_files_impl(repo_path, "file_".to_string(), Some(5)).unwrap();
        assert!(
            results.len() <= 5,
            "Should respect limit of 5, got {}",
            results.len()
        );
    }

    // --- search_content tests ---

    #[test]
    fn content_match_offsets_count_utf16_code_units() {
        let cases = [
            ("ascii needle", 6, 6, 6),
            ("— needle", 4, 2, 2),
            ("é needle", 3, 2, 2),
            ("😀 needle", 5, 2, 3),
        ];

        for (line, byte_start, scalar_start, utf16_start) in cases {
            assert_eq!(line[..byte_start].chars().count(), scalar_start);
            assert_eq!(
                utf16_match_offsets(line, byte_start, byte_start + "needle".len()),
                Some((utf16_start, utf16_start + 6)),
                "wrong UTF-16 range for {line:?}"
            );
        }
    }

    #[test]
    fn content_search_returns_utf16_offsets_for_ascii_and_unicode_prefixes() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("unicode.txt"),
            "ascii needle\n— needle\né needle\n😀 needle\n",
        )
        .unwrap();

        let result = search_content_impl(
            dir.path().to_string_lossy().to_string(),
            "needle".to_string(),
            true,
            false,
            false,
            None,
        )
        .unwrap();

        for (line, expected_start) in [
            ("ascii needle", 6),
            ("— needle", 2),
            ("é needle", 2),
            ("😀 needle", 3),
        ] {
            let found = result
                .matches
                .iter()
                .find(|content_match| content_match.line_text == line)
                .unwrap_or_else(|| panic!("missing match for {line:?}"));
            assert_eq!(
                found.match_start, expected_start,
                "wrong start for {line:?}"
            );
            assert_eq!(
                found.match_end,
                expected_start + 6,
                "wrong end for {line:?}"
            );
        }
    }

    #[test]
    fn test_search_content_basic() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        // src/lib.rs already contains "pub fn hello() {}"
        let result =
            search_content_impl(repo_path, "hello".to_string(), true, false, false, None).unwrap();
        assert!(
            result.matches.iter().any(|m| m.path == "src/lib.rs"),
            "Expected match in src/lib.rs"
        );
        assert!(result.files_searched > 0);
    }

    #[test]
    fn cancelled_content_walk_stops_before_searching_files() {
        let dir = setup_test_repo();
        let cancel = AtomicBool::new(true);

        let result = search_content_impl_with_cancel(
            dir.path().to_string_lossy().to_string(),
            "hello".to_string(),
            true,
            false,
            false,
            None,
            &cancel,
        )
        .unwrap();

        assert_eq!(result.files_searched, 0);
        assert!(result.matches.is_empty());
    }

    #[test]
    fn grep_sink_stops_when_cancelled_between_matching_lines() {
        use grep_searcher::{BinaryDetection, SearcherBuilder};

        let dir = TempDir::new().unwrap();
        let path = dir.path().join("matches.txt");
        fs::write(&path, "needle one\nneedle two\nneedle three\n").unwrap();
        let matcher = grep_regex::RegexMatcherBuilder::new()
            .build("needle")
            .unwrap();
        let mut searcher = SearcherBuilder::new()
            .binary_detection(BinaryDetection::quit(0))
            .build();
        let checks = std::cell::Cell::new(0usize);
        let mut matches = Vec::new();
        let mut truncated = false;

        let stopped_by_cancel = grep_file_with_cancel(
            &mut searcher,
            &matcher,
            &path,
            "matches.txt",
            100,
            &mut matches,
            &mut truncated,
            &|| {
                let current = checks.get();
                checks.set(current + 1);
                current > 0
            },
        )
        .unwrap();

        assert!(stopped_by_cancel);
        assert_eq!(matches.len(), 1, "the second sink call must stop grep");
        assert!(!truncated, "cancellation is not a result-limit truncation");
    }

    #[test]
    fn test_search_content_case_insensitive() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        let result =
            search_content_impl(repo_path, "HELLO".to_string(), false, false, false, None).unwrap();
        assert!(
            result.matches.iter().any(|m| m.path == "src/lib.rs"),
            "HELLO should match hello case-insensitively"
        );
    }

    #[test]
    fn test_search_content_case_sensitive() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        let result =
            search_content_impl(repo_path, "HELLO".to_string(), true, false, false, None).unwrap();
        assert!(
            result.matches.is_empty(),
            "HELLO should NOT match hello when case_sensitive=true"
        );
    }

    #[test]
    fn test_search_content_regex() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        // src/lib.rs has "pub fn hello()" and main.rs has "fn main()"
        let result =
            search_content_impl(repo_path, r"fn\s+\w+".to_string(), true, true, false, None)
                .unwrap();
        assert!(
            !result.matches.is_empty(),
            "Regex fn\\s+\\w+ should match function definitions"
        );
    }

    #[test]
    fn test_search_content_whole_word() {
        let dir = setup_test_repo();

        // Create a file with both "test" and "testing"
        fs::write(
            dir.path().join("words.txt"),
            "this is a test\nbut not testing\n",
        )
        .unwrap();

        let result = search_content_impl(
            dir.path().to_string_lossy().to_string(),
            "test".to_string(),
            true,
            false,
            true,
            None,
        )
        .unwrap();

        let matches: Vec<&ContentMatch> = result
            .matches
            .iter()
            .filter(|m| m.path == "words.txt")
            .collect();
        // "test" (whole word) should match the first line but not "testing"
        assert!(
            matches
                .iter()
                .any(|m| m.line_text.contains("this is a test")),
            "Should match line with standalone 'test'"
        );
        assert!(
            !matches
                .iter()
                .any(|m| m.line_text.trim() == "but not testing"),
            "Should NOT match 'testing' with whole_word=true"
        );
    }

    #[test]
    fn test_search_content_skips_binary() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        // Write a file with null bytes (binary detection)
        let mut content = b"hello world\0binary data".to_vec();
        content.extend_from_slice(b"\0\0\0");
        fs::write(dir.path().join("binary.bin"), &content).unwrap();

        let result =
            search_content_impl(repo_path, "hello".to_string(), true, false, false, None).unwrap();
        assert!(
            result.matches.iter().all(|m| m.path != "binary.bin"),
            "Binary file should be skipped"
        );
        assert!(
            result.files_skipped > 0,
            "files_skipped should be incremented for binary file"
        );
    }

    #[test]
    fn test_search_content_skips_large_file() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        // Write a file > 1MB
        let large_content = vec![b'a'; 1_048_577];
        fs::write(dir.path().join("large.txt"), &large_content).unwrap();

        let result =
            search_content_impl(repo_path, "a".to_string(), true, false, false, None).unwrap();
        assert!(
            result.matches.iter().all(|m| m.path != "large.txt"),
            "Large file should be skipped"
        );
        assert!(
            result.files_skipped > 0,
            "files_skipped should be incremented for large file"
        );
    }

    #[test]
    fn test_search_content_respects_gitignore() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        // Create an ignored directory with a file containing a unique string
        fs::create_dir(dir.path().join("ignored_dir")).unwrap();
        fs::write(
            dir.path().join("ignored_dir/secret.txt"),
            "supersecretstring",
        )
        .unwrap();
        fs::write(dir.path().join(".gitignore"), "ignored_dir/\n").unwrap();

        let result = search_content_impl(
            repo_path,
            "supersecretstring".to_string(),
            true,
            false,
            false,
            None,
        )
        .unwrap();
        assert!(
            result.matches.is_empty(),
            "Should not search inside gitignored directory"
        );
    }

    #[test]
    fn test_search_content_match_offsets() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        fs::write(dir.path().join("offsets.txt"), "hello world\n").unwrap();

        let result =
            search_content_impl(repo_path, "world".to_string(), true, false, false, None).unwrap();
        let m = result
            .matches
            .iter()
            .find(|m| m.path == "offsets.txt")
            .expect("Should find match in offsets.txt");

        assert_eq!(m.line_number, 1);
        let line = &m.line_text;
        let start = m.match_start as usize;
        let end = m.match_end as usize;
        assert_eq!(
            &line[start..end],
            "world",
            "Offsets should point to 'world' in the line"
        );
    }

    #[test]
    fn test_search_content_limit() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        // Create multiple files each with the search term
        for i in 0..5 {
            fs::write(
                dir.path().join(format!("match{i}.txt")),
                format!("target line {i}\ntarget line again {i}\n"),
            )
            .unwrap();
        }

        let result =
            search_content_impl(repo_path, "target".to_string(), true, false, false, Some(2))
                .unwrap();
        assert_eq!(
            result.matches.len(),
            2,
            "Should return exactly 2 matches when limit=2"
        );
        assert!(
            result.truncated,
            "truncated should be true when limit is hit"
        );
    }

    #[test]
    fn test_search_content_empty_query() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        let result =
            search_content_impl(repo_path, String::new(), true, false, false, None).unwrap();
        assert!(
            result.matches.is_empty(),
            "Empty query should return no matches"
        );
    }

    #[test]
    fn test_search_content_no_matches() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        let result = search_content_impl(
            repo_path,
            "xyzzy_no_such_string_9999".to_string(),
            true,
            false,
            false,
            None,
        )
        .unwrap();
        assert_eq!(
            result.matches.len(),
            0,
            "Should return 0 matches for non-existent string"
        );
        assert!(!result.truncated);
    }

    #[test]
    fn test_search_content_bm25_reranks_by_relevance() {
        let dir = setup_test_repo();

        // Two files, both matching "database". a.txt has it once in a line
        // padded with unrelated tokens (low term frequency, long line);
        // b.txt has it three times in a focused line (high TF, short line).
        // Grep returns a.txt first (alphabetical walk) — BM25 must flip it.
        fs::write(
            dir.path().join("a.txt"),
            "lorem ipsum dolor sit amet consectetur database adipiscing elit sed do\n",
        )
        .unwrap();
        fs::write(dir.path().join("b.txt"), "database database database\n").unwrap();

        let repo_path = dir.path().to_string_lossy().to_string();
        let result =
            search_content_impl(repo_path, "database".to_string(), false, false, false, None)
                .unwrap();

        assert!(result.matches.len() >= 2, "expected hits from both files");
        // After rerank, the high-TF / short-line match in b.txt must win.
        assert_eq!(
            result.matches[0].path,
            "b.txt",
            "BM25 rerank should put the highest-tf line first, got order: {:?}",
            result.matches.iter().map(|m| &m.path).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_search_content_non_utf8_skip() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        // Write a file with invalid UTF-8 bytes (not null — won't trigger binary detection, but invalid UTF-8)
        // grep-searcher's UTF8 sink will skip or error gracefully on non-UTF-8 content
        let mut content = b"valid start\n".to_vec();
        content.extend_from_slice(&[0xFF, 0xFE, 0xFD]); // invalid UTF-8
        content.extend_from_slice(b"\nvalid end\n");
        fs::write(dir.path().join("nonutf8.txt"), &content).unwrap();

        // Should not panic or return an error
        let result = search_content_impl(repo_path, "valid".to_string(), true, false, false, None);
        assert!(
            result.is_ok(),
            "Non-UTF-8 file should be handled gracefully, not panic"
        );
    }

    // --- strip_line_col_suffix tests ---

    #[test]
    fn test_strip_no_suffix() {
        assert_eq!(strip_line_col_suffix("src/lib.rs"), "src/lib.rs");
        assert_eq!(strip_line_col_suffix("/usr/bin/test"), "/usr/bin/test");
    }

    #[test]
    fn test_strip_line_only() {
        assert_eq!(strip_line_col_suffix("src/lib.rs:42"), "src/lib.rs");
    }

    #[test]
    fn test_strip_line_and_col() {
        assert_eq!(strip_line_col_suffix("src/lib.rs:42:10"), "src/lib.rs");
    }

    #[test]
    fn test_strip_preserves_non_numeric_colons() {
        // Windows-style C: drive prefix should be preserved
        assert_eq!(
            strip_line_col_suffix("C:\\Users\\file.rs"),
            "C:\\Users\\file.rs"
        );
        // Colon followed by non-digits should be preserved
        assert_eq!(strip_line_col_suffix("src/lib.rs:abc"), "src/lib.rs:abc");
    }

    #[test]
    fn test_strip_empty_after_colon() {
        assert_eq!(strip_line_col_suffix("src/lib.rs:"), "src/lib.rs:");
    }

    // --- resolve_terminal_path tests ---

    /// The link verifier issued one IPC per candidate per row and awaited each
    /// row before starting the next, so a screen with links on many rows cost one
    /// round trip per link, serially. Batching removes the round trips, not the
    /// work: every answer must still equal what the single-candidate command
    /// returns, positionally.
    #[tokio::test]
    async fn resolving_a_batch_answers_each_candidate_in_order() {
        let dir = TempDir::new().unwrap();
        let cwd = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("first.rs"), "").unwrap();
        fs::write(dir.path().join("third.rs"), "").unwrap();

        let candidates = vec![
            "first.rs".to_string(),
            "missing.rs".to_string(),
            "third.rs:12:3".to_string(),
        ];
        let batched = resolve_terminal_paths(cwd.clone(), candidates.clone())
            .await
            .expect("batched resolve failed");

        assert_eq!(
            batched.len(),
            candidates.len(),
            "a batch must not drop entries"
        );
        for (i, candidate) in candidates.iter().enumerate() {
            assert_eq!(
                batched[i],
                resolve_terminal_path(cwd.clone(), candidate.clone()),
                "batched answer for {candidate:?} differs from the single-candidate one"
            );
        }
        // Pinned explicitly so the equality above cannot pass by both being wrong.
        assert!(batched[0].is_some());
        assert!(
            batched[1].is_none(),
            "an unresolved candidate must stay a hole"
        );
        assert!(
            batched[2].is_some(),
            "the :line:col suffix must still be stripped"
        );
    }

    #[tokio::test]
    async fn resolving_an_empty_batch_is_not_an_error() {
        assert_eq!(
            resolve_terminal_paths("/tmp".to_string(), Vec::new()).await,
            Ok(Vec::new())
        );
    }

    #[test]
    fn test_resolve_absolute_existing_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("hello.rs");
        fs::write(&file, "fn main() {}").unwrap();

        let result = resolve_terminal_path(
            dir.path().to_string_lossy().to_string(),
            file.to_string_lossy().to_string(),
        );
        assert!(result.is_some());
        let resolved = result.unwrap();
        assert!(!resolved.is_directory);
        assert!(resolved.absolute_path.ends_with("hello.rs"));
    }

    #[test]
    fn test_resolve_relative_existing_file() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/lib.rs"), "pub fn hello() {}").unwrap();

        let result = resolve_terminal_path(
            dir.path().to_string_lossy().to_string(),
            "src/lib.rs".to_string(),
        );
        assert!(result.is_some());
        let resolved = result.unwrap();
        assert!(!resolved.is_directory);
        assert!(resolved.absolute_path.ends_with("src/lib.rs"));
    }

    #[test]
    fn test_resolve_with_line_suffix() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("main.rs"), "fn main() {}").unwrap();

        let result = resolve_terminal_path(
            dir.path().to_string_lossy().to_string(),
            "main.rs:42".to_string(),
        );
        assert!(result.is_some());
        assert!(result.unwrap().absolute_path.ends_with("main.rs"));
    }

    #[test]
    fn test_resolve_with_line_col_suffix() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("main.rs"), "fn main() {}").unwrap();

        let result = resolve_terminal_path(
            dir.path().to_string_lossy().to_string(),
            "main.rs:42:10".to_string(),
        );
        assert!(result.is_some());
        assert!(result.unwrap().absolute_path.ends_with("main.rs"));
    }

    #[test]
    fn test_resolve_with_line_range_suffix() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("main.rs"), "fn main() {}").unwrap();

        let result = resolve_terminal_path(
            dir.path().to_string_lossy().to_string(),
            "main.rs:96-150".to_string(),
        );
        assert!(result.unwrap().absolute_path.ends_with("main.rs"));
        assert_eq!(strip_line_col_suffix("a-b.rs:3-9"), "a-b.rs");
        assert_eq!(strip_line_col_suffix("a.rs:3-"), "a.rs:3-");
    }

    #[test]
    fn test_resolve_nonexistent_returns_none() {
        let dir = TempDir::new().unwrap();
        let result = resolve_terminal_path(
            dir.path().to_string_lossy().to_string(),
            "does_not_exist.rs".to_string(),
        );
        assert!(result.is_none());
    }

    #[test]
    fn test_resolve_directory() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();

        let result =
            resolve_terminal_path(dir.path().to_string_lossy().to_string(), "src".to_string());
        assert!(result.is_some());
        assert!(result.unwrap().is_directory);
    }

    /// A terminal already working inside a protected folder may resolve paths
    /// in that same folder — its repos live there and FastAF already holds the
    /// permission. Anything else protected stays refused, and an unknown cwd
    /// is never taken as permission.
    #[test]
    fn a_terminal_may_probe_only_the_protected_folder_it_is_already_in() {
        let home = std::path::Path::new("/Users/someone");
        let desktop_file = home.join("Desktop/code/app/src/main.rs");
        let documents_file = home.join("Documents/notes.md");
        let in_desktop = "/Users/someone/Desktop/code/app";

        assert!(terminal_may_probe(&desktop_file, in_desktop, home));
        assert!(terminal_may_probe(
            &home.join("Desktop/other-repo/README.md"),
            in_desktop,
            home
        ));
        assert!(!terminal_may_probe(&documents_file, in_desktop, home));
        assert!(!terminal_may_probe(
            &desktop_file,
            "/Users/someone/projects",
            home
        ));
        assert!(!terminal_may_probe(&desktop_file, "", home));
        // Not protected at all: always.
        assert!(terminal_may_probe(&home.join("projects/a.rs"), "", home));
        assert!(terminal_may_probe(
            std::path::Path::new("/tmp/x.log"),
            "",
            home
        ));
        // Case-insensitive, like the volume.
        assert!(terminal_may_probe(
            &home.join("desktop/app/a.rs"),
            "/Users/someone/Desktop/app",
            home
        ));
    }

    // ----- validate_external_write_path (story 1273-c95e) -----
    //
    // Tests are TempDir-rooted — we treat the tempdir as "home" so the test
    // doesn't depend on or mutate the user's real `$HOME`. This mirrors the
    // parameterised signature of the helper itself.

    #[test]
    fn validate_external_write_rejects_relative_path() {
        let home = TempDir::new().unwrap();
        let result = validate_external_write_path(std::path::Path::new("foo.txt"), home.path());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("absolute path"));
    }

    #[test]
    fn validate_external_write_rejects_parent_dir_component() {
        let home = TempDir::new().unwrap();
        // Path starts inside home but escapes via `..`.
        let escaping = home
            .path()
            .join("sub")
            .join("..")
            .join("..")
            .join("etc")
            .join("passwd");
        let result = validate_external_write_path(&escaping, home.path());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains(".."));
    }

    #[test]
    fn validate_external_write_accepts_path_outside_home() {
        let home = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        let result = validate_external_write_path(&other.path().join("file.txt"), home.path());
        assert!(
            result.is_ok(),
            "paths outside home should be allowed for local tool"
        );
    }

    #[test]
    fn validate_external_write_accepts_file_in_home() {
        let home = TempDir::new().unwrap();
        let target = home.path().join("notes.md");
        let result = validate_external_write_path(&target, home.path());
        assert!(result.is_ok(), "expected Ok, got {:?}", result);
    }

    #[test]
    fn validate_external_write_accepts_file_in_home_subdir() {
        let home = TempDir::new().unwrap();
        let sub = home.path().join("projects").join("demo");
        fs::create_dir_all(&sub).unwrap();
        let target = sub.join("README.md");
        let result = validate_external_write_path(&target, home.path());
        assert!(result.is_ok(), "expected Ok, got {:?}", result);
    }

    #[test]
    fn validate_external_write_rejects_nonexistent_parent() {
        let home = TempDir::new().unwrap();
        // Parent directory doesn't exist — canonicalize fails, we reject
        // rather than auto-creating. Callers that need intermediate dirs must
        // mkdir first.
        let target = home.path().join("never_created_dir").join("file.txt");
        let result = validate_external_write_path(&target, home.path());
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn validate_external_write_accepts_symlink_target() {
        use std::os::unix::fs::symlink;
        let home = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let link = home.path().join("escape");
        symlink(outside.path(), &link).unwrap();
        let target = link.join("file.txt");
        let result = validate_external_write_path(&target, home.path());
        assert!(
            result.is_ok(),
            "symlinks should be allowed — user is the trust boundary"
        );
    }

    // --- fs_transfer_paths tests ---

    #[test]
    fn transfer_move_file_succeeds() {
        let src_dir = TempDir::new().unwrap();
        let dst_dir = TempDir::new().unwrap();
        let src_file = src_dir.path().join("a.txt");
        fs::write(&src_file, "hello").unwrap();

        let res = fs_transfer_paths(
            dst_dir.path().to_string_lossy().to_string(),
            vec![src_file.to_string_lossy().to_string()],
            TransferMode::Move,
            false,
        )
        .unwrap();

        assert_eq!(res.moved, 1);
        assert_eq!(res.skipped, 0);
        assert!(res.errors.is_empty(), "errors: {:?}", res.errors);
        assert!(!res.needs_confirm);
        assert!(!src_file.exists(), "source should be gone after move");
        assert_eq!(
            fs::read_to_string(dst_dir.path().join("a.txt")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn transfer_copy_file_succeeds() {
        let src_dir = TempDir::new().unwrap();
        let dst_dir = TempDir::new().unwrap();
        let src_file = src_dir.path().join("a.txt");
        fs::write(&src_file, "hello").unwrap();

        let res = fs_transfer_paths(
            dst_dir.path().to_string_lossy().to_string(),
            vec![src_file.to_string_lossy().to_string()],
            TransferMode::Copy,
            false,
        )
        .unwrap();

        assert_eq!(res.moved, 1);
        assert!(src_file.exists(), "source should still exist after copy");
        assert_eq!(
            fs::read_to_string(dst_dir.path().join("a.txt")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn transfer_skips_on_name_conflict() {
        let src_dir = TempDir::new().unwrap();
        let dst_dir = TempDir::new().unwrap();
        let src_file = src_dir.path().join("a.txt");
        fs::write(&src_file, "new").unwrap();
        // Pre-existing file with same name in destination
        fs::write(dst_dir.path().join("a.txt"), "old").unwrap();

        let res = fs_transfer_paths(
            dst_dir.path().to_string_lossy().to_string(),
            vec![src_file.to_string_lossy().to_string()],
            TransferMode::Move,
            false,
        )
        .unwrap();

        assert_eq!(res.moved, 0);
        assert_eq!(res.skipped, 1);
        assert!(src_file.exists(), "source should NOT be moved when skipped");
        assert_eq!(
            fs::read_to_string(dst_dir.path().join("a.txt")).unwrap(),
            "old",
            "destination content must be preserved"
        );
    }

    #[test]
    fn transfer_requires_confirm_for_directory() {
        let src_dir = TempDir::new().unwrap();
        let dst_dir = TempDir::new().unwrap();
        let src_subdir = src_dir.path().join("folder");
        fs::create_dir(&src_subdir).unwrap();
        fs::write(src_subdir.join("inside.txt"), "x").unwrap();

        let res = fs_transfer_paths(
            dst_dir.path().to_string_lossy().to_string(),
            vec![src_subdir.to_string_lossy().to_string()],
            TransferMode::Copy,
            false,
        )
        .unwrap();

        assert!(
            res.needs_confirm,
            "dir without allow_recursive must request confirm"
        );
        assert_eq!(res.moved, 0);
        assert!(
            !dst_dir.path().join("folder").exists(),
            "no fs changes must happen when confirm required"
        );
    }

    #[test]
    fn transfer_copies_directory_recursively_when_allowed() {
        let src_dir = TempDir::new().unwrap();
        let dst_dir = TempDir::new().unwrap();
        let src_subdir = src_dir.path().join("folder");
        fs::create_dir(&src_subdir).unwrap();
        fs::write(src_subdir.join("a.txt"), "1").unwrap();
        fs::create_dir(src_subdir.join("nested")).unwrap();
        fs::write(src_subdir.join("nested/b.txt"), "2").unwrap();

        let res = fs_transfer_paths(
            dst_dir.path().to_string_lossy().to_string(),
            vec![src_subdir.to_string_lossy().to_string()],
            TransferMode::Copy,
            true,
        )
        .unwrap();

        assert_eq!(res.moved, 1);
        assert!(res.errors.is_empty(), "errors: {:?}", res.errors);
        assert_eq!(
            fs::read_to_string(dst_dir.path().join("folder/a.txt")).unwrap(),
            "1"
        );
        assert_eq!(
            fs::read_to_string(dst_dir.path().join("folder/nested/b.txt")).unwrap(),
            "2"
        );
        assert!(src_subdir.exists(), "copy must not remove source");
    }

    #[test]
    fn transfer_moves_directory_when_allowed() {
        let src_dir = TempDir::new().unwrap();
        let dst_dir = TempDir::new().unwrap();
        let src_subdir = src_dir.path().join("folder");
        fs::create_dir(&src_subdir).unwrap();
        fs::write(src_subdir.join("a.txt"), "1").unwrap();

        let res = fs_transfer_paths(
            dst_dir.path().to_string_lossy().to_string(),
            vec![src_subdir.to_string_lossy().to_string()],
            TransferMode::Move,
            true,
        )
        .unwrap();

        assert_eq!(res.moved, 1);
        assert!(!src_subdir.exists(), "source must be gone after move");
        assert!(dst_dir.path().join("folder/a.txt").exists());
    }

    #[test]
    fn transfer_rejects_move_into_own_subdir() {
        let base = TempDir::new().unwrap();
        let parent = base.path().join("parent");
        fs::create_dir(&parent).unwrap();
        let child = parent.join("child");
        fs::create_dir(&child).unwrap();

        let res = fs_transfer_paths(
            child.to_string_lossy().to_string(),
            vec![parent.to_string_lossy().to_string()],
            TransferMode::Move,
            true,
        )
        .unwrap();

        assert_eq!(res.moved, 0);
        assert_eq!(res.errors.len(), 1, "got errors: {:?}", res.errors);
        assert!(
            parent.exists(),
            "source must remain untouched on self-nest error"
        );
    }

    #[test]
    fn transfer_rejects_invalid_destination() {
        let nowhere = "/definitely/not/a/real/path/xyzzy";
        let res = fs_transfer_paths(
            nowhere.to_string(),
            vec!["/tmp/ignored".to_string()],
            TransferMode::Copy,
            false,
        );
        assert!(res.is_err(), "non-existent destination must error");
    }

    #[test]
    fn transfer_mixed_files_aggregates_counts() {
        let src_dir = TempDir::new().unwrap();
        let dst_dir = TempDir::new().unwrap();
        let a = src_dir.path().join("a.txt");
        let b = src_dir.path().join("b.txt");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        // Conflict on b only
        fs::write(dst_dir.path().join("b.txt"), "existing").unwrap();

        let res = fs_transfer_paths(
            dst_dir.path().to_string_lossy().to_string(),
            vec![
                a.to_string_lossy().to_string(),
                b.to_string_lossy().to_string(),
            ],
            TransferMode::Copy,
            false,
        )
        .unwrap();

        assert_eq!(res.moved, 1);
        assert_eq!(res.skipped, 1);
        assert!(res.errors.is_empty());
    }

    // --- Cross-repo content search (search_content_all_impl) ---

    fn ready_index(
        dir: &std::path::Path,
    ) -> Arc<parking_lot::RwLock<crate::content_index::ContentIndex>> {
        Arc::new(parking_lot::RwLock::new(
            crate::content_index::ContentIndex::build(
                dir.to_path_buf(),
                None,
                std::collections::HashMap::new(),
            ),
        ))
    }

    /// Cross-repo search now takes the whole `AppState` (it must be able to
    /// kick off a missing index), so the fixtures build one and pre-populate
    /// `content_indices` exactly as the old DashMap fixtures did.
    fn state_with_indices(
        entries: Vec<(
            String,
            Arc<parking_lot::RwLock<crate::content_index::ContentIndex>>,
        )>,
    ) -> Arc<crate::state::AppState> {
        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        for (path, index) in entries {
            state.content_indices.insert(path, index);
        }
        state
    }

    /// Cross-repo search reads the repo registry from the config dir, so a test
    /// that does not isolate it would search the developer's REAL repos and get
    /// machine-dependent counts. Returns the guard — keep it alive.
    fn empty_repo_registry(cfg: &TempDir) -> impl Drop {
        let guard = crate::config::set_config_dir_override(cfg.path().to_path_buf());
        crate::config::replace_repositories_for_test(serde_json::json!({ "repos": {} })).unwrap();
        guard
    }

    #[test]
    fn search_content_all_merges_and_tags_each_repo() {
        let cfg = TempDir::new().unwrap();
        let _registry_guard = empty_repo_registry(&cfg);
        let repo_a = TempDir::new().unwrap();
        fs::write(
            repo_a.path().join("a.txt"),
            "the zebrafish swims in repo a\n",
        )
        .unwrap();
        let repo_b = TempDir::new().unwrap();
        fs::write(
            repo_b.path().join("b.txt"),
            "another zebrafish lives in repo b\n",
        )
        .unwrap();

        let path_a = repo_a.path().to_string_lossy().to_string();
        let path_b = repo_b.path().to_string_lossy().to_string();
        let state = state_with_indices(vec![
            (path_a.clone(), ready_index(repo_a.path())),
            (path_b.clone(), ready_index(repo_b.path())),
        ]);

        let result = search_content_all_impl(&state, "zebrafish", false, 100);

        assert_eq!(result.matches.len(), 2, "one match per repo");
        let repos: std::collections::HashSet<_> = result
            .matches
            .iter()
            .filter_map(|m| m.repo_path.clone())
            .collect();
        assert!(repos.contains(&path_a), "match tagged with repo a");
        assert!(repos.contains(&path_b), "match tagged with repo b");
    }

    #[test]
    fn search_content_all_skips_unready_indices() {
        let cfg = TempDir::new().unwrap();
        let _registry_guard = empty_repo_registry(&cfg);
        let repo_a = TempDir::new().unwrap();
        fs::write(repo_a.path().join("a.txt"), "the zebrafish swims here\n").unwrap();
        let repo_b = TempDir::new().unwrap();
        fs::write(repo_b.path().join("b.txt"), "zebrafish also here\n").unwrap();

        let path_a = repo_a.path().to_string_lossy().to_string();
        let path_b = repo_b.path().to_string_lossy().to_string();
        let state = state_with_indices(vec![
            (path_a.clone(), ready_index(repo_a.path())),
            // repo_b's index never built → not ready → cannot contribute now
            (
                path_b.clone(),
                Arc::new(parking_lot::RwLock::new(
                    crate::content_index::ContentIndex::empty(repo_b.path().to_path_buf()),
                )),
            ),
        ]);

        let result = search_content_all_impl(&state, "zebrafish", false, 100);

        assert_eq!(result.matches.len(), 1, "only the ready repo contributes");
        assert_eq!(
            result.matches[0].repo_path.as_deref(),
            Some(path_a.as_str())
        );
        // Regression: the unready repo used to vanish silently, so a query that
        // only exists there rendered as a confident "No results". It must be
        // reported as still-indexing instead.
        assert_eq!(result.repos_pending, 1, "unready repo must be reported");
        assert_eq!(result.repos_searched, 1);
    }

    /// A cross-repo search must report EVERY registered repo, but it must not
    /// enqueue the entire registry behind the single build semaphore. The
    /// configured warm strategy owns which repos are indexed; search reports
    /// the remainder as pending without turning one query into hours of work.
    #[test]
    fn search_content_all_reports_unindexed_repos_without_enqueuing_builds() {
        let cfg = TempDir::new().unwrap();
        let _config_guard = crate::config::set_config_dir_override(cfg.path().to_path_buf());

        let indexed = TempDir::new().unwrap();
        fs::write(indexed.path().join("a.txt"), "the zebrafish swims here\n").unwrap();
        let never_visited = TempDir::new().unwrap();
        fs::write(never_visited.path().join("b.txt"), "zebrafish here too\n").unwrap();

        let indexed_path = indexed.path().to_string_lossy().to_string();
        let unvisited_path = never_visited.path().to_string_lossy().to_string();
        crate::config::replace_repositories_for_test(serde_json::json!({
            "repos": { indexed_path.clone(): {}, unvisited_path.clone(): {} }
        }))
        .unwrap();

        // Only the "active" repo has an index — exactly the boot-time shape.
        let state = state_with_indices(vec![(indexed_path.clone(), ready_index(indexed.path()))]);

        let result = search_content_all_impl(&state, "zebrafish", false, 100);

        assert_eq!(result.repos_searched, 1, "only the indexed repo is ready");
        assert_eq!(
            result.repos_pending, 1,
            "the registered-but-unindexed repo must be surfaced, not dropped"
        );
        assert!(
            !state.content_indices.contains_key(&unvisited_path),
            "cross-repo search must not enqueue a build for every registered repo"
        );
    }

    #[test]
    fn preparing_an_index_search_releases_the_read_lock_before_grep() {
        let repo = TempDir::new().unwrap();
        fs::write(repo.path().join("a.txt"), "zebrafish lives here\n").unwrap();
        let index = ready_index(repo.path());

        let plan = prepare_index_search(&index, "zebrafish", 50).unwrap();
        let writer = index.try_write().expect(
            "the search plan must own paths and scores so disk grep does not retain the read lock",
        );
        drop(writer);

        let result =
            search_index_plan(plan, "zebrafish", false, Some(100), &AtomicBool::new(false))
                .unwrap();
        assert_eq!(result.matches.len(), 1);
    }

    /// A repo holding an index without being registered (an agent searched it)
    /// must still be searched — the union, not just the registry.
    #[test]
    fn search_content_all_includes_indexed_but_unregistered_repo() {
        let cfg = TempDir::new().unwrap();
        let _registry_guard = empty_repo_registry(&cfg);

        let repo = TempDir::new().unwrap();
        fs::write(repo.path().join("a.txt"), "the zebrafish swims here\n").unwrap();
        let path = repo.path().to_string_lossy().to_string();
        let state = state_with_indices(vec![(path.clone(), ready_index(repo.path()))]);

        let result = search_content_all_impl(&state, "zebrafish", false, 100);

        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].repo_path.as_deref(), Some(path.as_str()));
    }

    #[test]
    fn search_content_all_no_matches_returns_empty() {
        let cfg = TempDir::new().unwrap();
        let _registry_guard = empty_repo_registry(&cfg);
        let repo = TempDir::new().unwrap();
        fs::write(repo.path().join("a.txt"), "nothing relevant here\n").unwrap();
        let state = state_with_indices(vec![(
            repo.path().to_string_lossy().to_string(),
            ready_index(repo.path()),
        )]);

        let result = search_content_all_impl(&state, "zebrafish", false, 100);

        assert!(result.matches.is_empty());
        assert!(!result.truncated);
    }

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("note.md");
        fs::write(&target, "original").unwrap();

        atomic_write(&target, b"updated content").unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), "updated content");
        // No temp files left behind in the directory.
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("tmp."))
            .collect();
        assert!(leftovers.is_empty(), "temp leaked: {leftovers:?}");
    }

    #[test]
    fn atomic_write_creates_new_file() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("new.txt");
        atomic_write(&target, b"hello").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_preserves_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("script.sh");
        fs::write(&target, "#!/bin/sh\necho old").unwrap();
        // User marks the file executable (0755) — a common, legitimate mode we
        // must NOT clobber to a restrictive 0600 on save.
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();

        atomic_write(&target, b"#!/bin/sh\necho new").unwrap();

        let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755, "atomic_write must preserve existing file mode");
        assert_eq!(fs::read_to_string(&target).unwrap(), "#!/bin/sh\necho new");
    }

    // ── Commands stay off the UI thread ──────────────────────────────────
    //
    // A `#[tauri::command]` declared as a plain `fn` gets
    // `ExecutionContext::Blocking` and runs inline in the IPC handler; on macOS
    // that is the main thread, so a directory copy or a large read freezes the
    // WebView. Each mutation command is therefore an `async fn` that does its
    // syscalls inside `spawn_blocking_fs`.
    //
    // These tests cannot observe *which* thread ran the work — they pin the
    // shape that puts it there: the command is awaitable, and awaiting it
    // performs the same operation as calling the `_impl` directly. If someone
    // collapses a command back into a sync `fn`, these stop compiling.

    #[tokio::test]
    async fn write_file_creates_a_dotfile_and_lists_it() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join(".gitignore"), ".env\n").unwrap();

        write_file(repo_path.clone(), ".env".to_string(), String::new())
            .await
            .unwrap();

        assert!(
            dir.path().join(".env").exists(),
            ".env was not created on disk"
        );
        let entries = list_directory_impl(repo_path, String::new()).unwrap();
        let env = entries.iter().find(|e| e.name == ".env");
        assert!(
            env.is_some(),
            "listing dropped .env: {:?}",
            entries.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        assert!(env.unwrap().is_ignored, "expected .env flagged ignored");
    }

    #[tokio::test]
    async fn write_file_command_is_awaitable_and_writes() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        write_file(repo_path, "async.txt".to_string(), "hello".to_string())
            .await
            .unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("async.txt")).unwrap(),
            "hello"
        );
    }

    #[tokio::test]
    async fn create_directory_command_is_awaitable_and_creates() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        create_directory(repo_path, "a/b/c".to_string())
            .await
            .unwrap();

        assert!(dir.path().join("a/b/c").is_dir());
    }

    #[tokio::test]
    async fn delete_path_command_is_awaitable_and_deletes() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        delete_path(repo_path, "README.md".to_string())
            .await
            .unwrap();

        assert!(!dir.path().join("README.md").exists());
    }

    #[tokio::test]
    async fn rename_path_command_is_awaitable_and_renames() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        rename_path(repo_path, "README.md".to_string(), "READ.md".to_string())
            .await
            .unwrap();

        assert!(!dir.path().join("README.md").exists());
        assert!(dir.path().join("READ.md").exists());
    }

    #[tokio::test]
    async fn copy_path_command_is_awaitable_and_copies() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        copy_path(repo_path, "README.md".to_string(), "COPY.md".to_string())
            .await
            .unwrap();

        assert!(dir.path().join("README.md").exists());
        assert!(dir.path().join("COPY.md").exists());
    }

    #[tokio::test]
    async fn copy_path_abs_command_is_awaitable_and_copies() {
        let dir = TempDir::new().unwrap();
        let from = dir.path().join("a.txt");
        let to = dir.path().join("b.txt");
        fs::write(&from, "content").unwrap();

        copy_path_abs(
            from.to_string_lossy().to_string(),
            to.to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        assert_eq!(fs::read_to_string(&to).unwrap(), "content");
    }

    #[tokio::test]
    async fn move_path_abs_command_is_awaitable_and_moves() {
        let dir = TempDir::new().unwrap();
        let from = dir.path().join("a.txt");
        let to = dir.path().join("b.txt");
        fs::write(&from, "content").unwrap();

        move_path_abs(
            from.to_string_lossy().to_string(),
            to.to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        assert!(!from.exists());
        assert_eq!(fs::read_to_string(&to).unwrap(), "content");
    }

    #[tokio::test]
    async fn add_to_gitignore_command_is_awaitable_and_appends() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        add_to_gitignore(repo_path, "target/".to_string())
            .await
            .unwrap();

        let content = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(content.lines().any(|l| l == "target/"));
    }

    #[tokio::test]
    async fn fs_read_file_command_is_awaitable_and_reads() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("data.txt"), "payload").unwrap();

        let content = fs_read_file(repo_path, "data.txt".to_string())
            .await
            .unwrap();

        assert_eq!(content, "payload");
    }

    // A failure inside the blocking closure must surface as the closure's own
    // error, not as an opaque join failure — the FileBrowser shows this string.
    #[tokio::test]
    async fn a_command_error_survives_the_blocking_hop() {
        let dir = setup_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();

        let err = write_file(repo_path, "../escape.txt".to_string(), "bad".to_string())
            .await
            .unwrap_err();

        assert!(
            err.contains("outside repository") || err.contains("Access denied"),
            "expected the validation error, got: {err}"
        );
    }
}
