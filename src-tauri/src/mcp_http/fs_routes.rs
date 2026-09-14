use axum::Json;
use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use super::types::*;
use super::{err_500, json_result, validate_path_string, validate_repo_path};

// `list_directory_http` intentionally omits `State` + `indexer_throttle`: the
// throttle exists to bound *concurrent* blocking walks (search, content grep,
// BM25 indexing) against each other, and a directory listing is not one of them.
//
// It is NOT free, though — `fs::list_directory_impl` runs `git status
// --porcelain` as a subprocess for the requested subdir, which is tens to
// hundreds of ms on a large repo. It is reached through the command so this
// route and the IPC one make the same threading decision (story 607-f483); the
// blocking work happens inside `spawn_blocking_fs` there.
pub(super) async fn list_directory_http(Query(q): Query<FsDirQuery>) -> Response {
    if let Err(e) = validate_repo_path(&q.repo_path) {
        return e.into_response();
    }
    json_result(crate::fs::list_directory(q.repo_path, q.subdir.unwrap_or_default()).await)
}

pub(super) async fn search_files_http(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<crate::state::AppState>>,
    Query(q): Query<FsSearchQuery>,
) -> Response {
    if let Err(e) = validate_repo_path(&q.repo_path) {
        return e.into_response();
    }
    // `search_files_impl` is a synchronous `WalkBuilder` traversal and can
    // block for hundreds of ms on large repos — move off the Tokio executor.
    let guard = state.indexer_throttle.begin_search();
    let result = tokio::task::spawn_blocking(move || {
        let _g = guard; // hold across the walk; dropped when closure returns
        crate::fs::search_files_impl(q.repo_path, q.query, q.limit)
    })
    .await
    .unwrap_or_else(|e| Err(format!("search task panicked: {e}")));
    json_result(result)
}

pub(super) async fn search_content_http(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<crate::state::AppState>>,
    Query(q): Query<FsSearchContentQuery>,
) -> Response {
    if let Err(e) = validate_repo_path(&q.repo_path) {
        return e.into_response();
    }
    let use_regex = q.use_regex.unwrap_or(false);
    let whole_word = q.whole_word.unwrap_or(false);
    let case_sensitive = q.case_sensitive.unwrap_or(false);

    // Use the BM25 index when available and applicable. This is NOT a cheap
    // in-memory lookup: ranking is proportional to the index and the grep phase
    // then opens up to 50 files, so it goes to the blocking pool like the
    // fallback below. Its IPC twin has always offloaded (story 607-f483).
    let can_use_index = !use_regex && !whole_word && !q.query.is_empty();
    if can_use_index {
        let guard = state.indexer_throttle.begin_search();
        let index_arc = crate::content_index::ensure_index(&state, &q.repo_path);
        let query = q.query.clone();
        let limit = q.limit;
        let indexed = tokio::task::spawn_blocking(move || {
            let _g = guard;
            let index = index_arc.read();
            index
                .is_ready()
                .then(|| crate::fs::search_via_index(&index, &query, case_sensitive, limit))
        })
        .await
        .unwrap_or(None);
        if let Some(result) = indexed {
            return json_result(result);
        }
    }

    // Fallback to full grep — blocks on WalkBuilder, offload to blocking pool.
    let guard = state.indexer_throttle.begin_search();
    let result = tokio::task::spawn_blocking(move || {
        let _g = guard;
        crate::fs::search_content_impl(
            q.repo_path,
            q.query,
            case_sensitive,
            use_regex,
            whole_word,
            q.limit,
        )
    })
    .await
    .unwrap_or_else(|e| Err(format!("search task panicked: {e}")));
    json_result(result)
}

/// BM25 semantic search across **all registered** repos. Each match includes `repoPath`.
/// Repos whose index is not ready yet cannot answer now: a build is kicked off and they
/// are counted in `repos_pending`, so an empty result is never reported as a clean miss.
pub(super) async fn search_content_all_http(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<crate::state::AppState>>,
    Query(q): Query<FsSearchContentAllQuery>,
) -> Response {
    let case_sensitive = q.case_sensitive.unwrap_or(false);
    let global_limit = q.limit.unwrap_or(100);

    // Same offload as the IPC twin `fs::search_content_all`: the impl queries
    // every ready BM25 index and falls back to a walk, so it must not run on the
    // executor (story 607-f483).
    let guard = state.indexer_throttle.begin_search();
    let result = tokio::task::spawn_blocking(move || {
        let _g = guard;
        crate::fs::search_content_all_impl(&state, &q.query, case_sensitive, global_limit)
    })
    .await
    .map_err(|e| format!("search task panicked: {e}"));

    json_result(result)
}

pub(super) async fn fs_read_file_http(Query(q): Query<FsFileQuery>) -> Response {
    if let Err(e) = validate_repo_path(&q.repo_path) {
        return e.into_response();
    }
    json_result(crate::fs::fs_read_file(q.repo_path, q.file).await)
}

/// Repo file read for the code editor, at the larger `MAX_EDITOR_LARGE_FILE_SIZE` cap.
pub(super) async fn read_editor_file_http(Query(q): Query<FsFileQuery>) -> Response {
    if let Err(e) = validate_repo_path(&q.repo_path) {
        return e.into_response();
    }
    // Through the command, so this route and the IPC one make the same threading
    // decision: a 250 MB read belongs on the blocking pool, not the executor.
    json_result(crate::read_editor_file(q.repo_path, q.file).await)
}

/// Check if a path falls within any of the given repository roots.
/// Uses Path::starts_with for component-level matching (not string prefix).
///
/// This is a purely LEXICAL check — it compares the path as written. On its own it does
/// not confine anything: `/repo/../../etc/passwd` starts with `/repo` by components, yet
/// the OS resolves it far outside. Callers on the HTTP boundary must go through
/// `deny_unless_in_roots`, which rejects traversal syntax before consulting this.
fn is_within_repo_roots(path: &std::path::Path, roots: &[String]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

/// Gate an absolute, client-supplied path on the HTTP boundary. Returns a 403 response
/// when the path must not be served, `None` when it may proceed.
///
/// Two layers:
/// 1. `validate_path_string` — rejects `..`, NUL and non-absolute paths. This is the layer
///    that actually confines: with `..` gone, the lexical component check below cannot be
///    walked out of.
/// 2. `is_within_repo_roots` — component-level containment in a registered repo.
///
/// Deliberately NOT canonicalizing: symlinks inside a registered repo that resolve outside
/// it are an accepted design decision in this project (the user put them there), and
/// canonicalizing would break them. The remote caller these routes are exposed to cannot
/// create symlinks through any gated route, so resolution buys nothing here.
///
/// These routes live in `shared_routes()` and are therefore merged into the remote router
/// as well as the loopback one. The caller there is a narrower trust level than the desktop
/// user, which is why this boundary exists at all — see `read_external_file_http`.
fn deny_unless_in_roots(path: &str, roots: &[String]) -> Option<Response> {
    if validate_path_string(path).is_err() {
        return Some(access_denied());
    }
    if !is_within_repo_roots(std::path::Path::new(path), roots) {
        return Some(access_denied());
    }
    None
}

/// Extract registered repository root paths from the opaque repos JSON.
fn registered_repo_roots() -> Vec<String> {
    crate::config::load_repositories()
        .get("repositories")
        .and_then(|r| r.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default()
}

pub(super) async fn read_external_file_http(Query(q): Query<FsExternalFileQuery>) -> Response {
    // Restrict to files within registered repos — prevents arbitrary file reads via HTTP
    if let Some(resp) = deny_unless_in_roots(&q.path, &registered_repo_roots()) {
        return resp;
    }
    json_result(crate::read_external_file(q.path).await)
}

/// External (absolute-path) file read for the code editor, at the larger
/// `MAX_EDITOR_LARGE_FILE_SIZE` cap. Same repo-root restriction as `read_external_file_http`.
pub(super) async fn read_editor_file_external_http(
    Query(q): Query<FsExternalFileQuery>,
) -> Response {
    if let Some(resp) = deny_unless_in_roots(&q.path, &registered_repo_roots()) {
        return resp;
    }
    // Through the command, for the same threading-parity reason as
    // `read_editor_file_http`.
    json_result(crate::read_editor_file_external(q.path).await)
}

pub(super) async fn write_file_http(Json(body): Json<FsWriteFileRequest>) -> Response {
    if let Err(e) = validate_repo_path(&body.repo_path) {
        return e.into_response();
    }
    match crate::fs::write_file(body.repo_path, body.file, body.content).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => err_500(&e),
    }
}

pub(super) async fn create_file_http(Json(body): Json<FsFileCreateRequest>) -> Response {
    if let Err(e) = validate_repo_path(&body.repo_path) {
        return e.into_response();
    }
    match crate::fs::create_file(body.repo_path, body.file) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => err_500(&e),
    }
}

pub(super) async fn create_directory_http(Json(body): Json<FsDirCreateRequest>) -> Response {
    if let Err(e) = validate_repo_path(&body.repo_path) {
        return e.into_response();
    }
    match crate::fs::create_directory(body.repo_path, body.dir).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => err_500(&e),
    }
}

pub(super) async fn delete_path_http(Json(body): Json<FsPathRequest>) -> Response {
    if let Err(e) = validate_repo_path(&body.repo_path) {
        return e.into_response();
    }
    match crate::fs::delete_path(body.repo_path, body.path).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => err_500(&e),
    }
}

pub(super) async fn rename_path_http(Json(body): Json<FsRenameRequest>) -> Response {
    if let Err(e) = validate_repo_path(&body.repo_path) {
        return e.into_response();
    }
    match crate::fs::rename_path(body.repo_path, body.from, body.to).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => err_500(&e),
    }
}

pub(super) async fn copy_path_http(Json(body): Json<FsCopyRequest>) -> Response {
    if let Err(e) = validate_repo_path(&body.repo_path) {
        return e.into_response();
    }
    match crate::fs::copy_path(body.repo_path, body.from, body.to).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => err_500(&e),
    }
}

pub(super) async fn add_to_gitignore_http(Json(body): Json<FsGitignoreRequest>) -> Response {
    if let Err(e) = validate_repo_path(&body.repo_path) {
        return e.into_response();
    }
    match crate::fs::add_to_gitignore(body.repo_path, body.pattern).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => err_500(&e),
    }
}

/// Resolve a terminal path candidate (handles `~`, relative, `:line:col`) to an
/// absolute canonical path. Metadata-only result (path + is_directory), so it is
/// intentionally NOT gated to repo roots — the terminal's cwd may sit anywhere.
pub(super) async fn resolve_terminal_path_http(
    Query(q): Query<FsResolveTerminalPathQuery>,
) -> Response {
    json_result(Ok::<Option<crate::fs::ResolvedFilePath>, String>(
        crate::fs::resolve_terminal_path(q.cwd, q.candidate),
    ))
}

/// Resolve a whole screen's worth of path candidates in one request. POST, not
/// GET: the batch is the point, and a screenful of candidates does not belong in
/// a query string. Same non-gating rationale as the single-candidate route.
pub(super) async fn resolve_terminal_paths_http(
    Json(body): Json<FsResolveTerminalPathsRequest>,
) -> Response {
    json_result(crate::fs::resolve_terminal_paths(body.cwd, body.candidates).await)
}

/// Stat an absolute path. Metadata-only (exists/is_dir/size/mtime), no content,
/// so it is not repo-root gated — `stat_path_impl` already refuses TCC-protected dirs.
pub(super) async fn stat_path_http(Query(q): Query<FsExternalFileQuery>) -> Response {
    json_result(Ok::<crate::fs::PathStat, String>(
        crate::fs::stat_path_impl(q.path),
    ))
}

/// Warm the BM25 content index for a repo (fire-and-forget; build runs in the
/// background). Mirrors `search_content_http`'s use of `ensure_index`.
pub(super) async fn warm_content_index_http(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<crate::state::AppState>>,
    Json(body): Json<FsWarmIndexRequest>,
) -> Response {
    if let Err(e) = validate_repo_path(&body.repo_path) {
        return e.into_response();
    }
    crate::content_index::ensure_index(&state, &body.repo_path);
    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

/// Write a file at an absolute path (editor saves for files outside any repo).
/// Gated to registered repo roots for the HTTP boundary, matching
/// `read_external_file_http` — the editor can only *open* repo-root files over
/// HTTP, so saves target the same set. `write_external_file` also confines to $HOME.
pub(super) async fn write_external_file_http(Json(body): Json<FsExternalWriteRequest>) -> Response {
    if let Some(resp) = deny_unless_in_roots(&body.path, &registered_repo_roots()) {
        return resp;
    }
    match crate::write_external_file(body.path, body.content).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => err_500(&e),
    }
}

/// Copy a single file by absolute paths (FileBrowser cross-repo copy). Both
/// endpoints gated to registered repo roots for the HTTP boundary.
pub(super) async fn copy_path_abs_http(Json(body): Json<FsAbsTransferRequest>) -> Response {
    if let Some(resp) = deny_unless_both_in_roots(&body.from, &body.to) {
        return resp;
    }
    match crate::fs::copy_path_abs(body.from, body.to).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => err_500(&e),
    }
}

/// Move a single file by absolute paths (FileBrowser cross-repo cut). Both
/// endpoints gated to registered repo roots for the HTTP boundary.
pub(super) async fn move_path_abs_http(Json(body): Json<FsAbsTransferRequest>) -> Response {
    if let Some(resp) = deny_unless_both_in_roots(&body.from, &body.to) {
        return resp;
    }
    match crate::fs::move_path_abs(body.from, body.to).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => err_500(&e),
    }
}

/// Bulk OS drag-drop transfer into a destination directory. Only the destination
/// is gated to repo roots: sources are frequently external (a file dragged from
/// the desktop), which is the whole point of drag-import.
pub(super) async fn fs_transfer_paths_http(Json(body): Json<FsTransferPathsRequest>) -> Response {
    if let Some(resp) = deny_unless_in_roots(&body.dest_dir, &registered_repo_roots()) {
        return resp;
    }
    json_result(crate::fs::fs_transfer_paths(
        body.dest_dir,
        body.paths,
        body.mode,
        body.allow_recursive,
    ))
}

/// 403 response for an absolute path that escapes every registered repo root.
fn access_denied() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "error": "Access denied: path must be within a registered repository"
        })),
    )
        .into_response()
}

/// Deny unless BOTH absolute paths fall within a registered repo root.
fn deny_unless_both_in_roots(from: &str, to: &str) -> Option<Response> {
    let roots = registered_repo_roots();
    deny_unless_in_roots(from, &roots).or_else(|| deny_unless_in_roots(to, &roots))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn within_repo_roots_match() {
        let roots = vec![
            "/Users/dev/project-a".to_string(),
            "/Users/dev/project-b".to_string(),
        ];
        assert!(is_within_repo_roots(
            Path::new("/Users/dev/project-a/src/main.rs"),
            &roots
        ));
        assert!(is_within_repo_roots(
            Path::new("/Users/dev/project-b/README.md"),
            &roots
        ));
    }

    #[test]
    fn within_repo_roots_no_match() {
        let roots = vec!["/Users/dev/project-a".to_string()];
        assert!(!is_within_repo_roots(
            Path::new("/Users/dev/.ssh/id_rsa"),
            &roots
        ));
        assert!(!is_within_repo_roots(Path::new("/etc/passwd"), &roots));
    }

    #[test]
    fn within_repo_roots_no_prefix_trick() {
        // "/Users/dev/project-abc" should NOT match root "/Users/dev/project-a"
        // Path::starts_with checks components, not string prefix
        let roots = vec!["/Users/dev/project-a".to_string()];
        assert!(!is_within_repo_roots(
            Path::new("/Users/dev/project-abc/file.txt"),
            &roots
        ));
    }

    #[test]
    fn within_repo_roots_empty() {
        assert!(!is_within_repo_roots(Path::new("/any/path"), &[]));
    }

    /// The bug this gate exists for: `Path::starts_with` is lexical, so a traversal path
    /// is "inside" the root by components while the OS resolves it outside. All six
    /// external-path routes share `deny_unless_in_roots`, so covering it covers them.
    #[test]
    fn gate_rejects_traversal_the_lexical_check_accepts() {
        let roots = vec!["/Users/dev/project-a".to_string()];
        let escape = "/Users/dev/project-a/../../../etc/passwd";

        // Component-level containment says yes — this is exactly why it is not enough.
        assert!(
            is_within_repo_roots(Path::new(escape), &roots),
            "precondition: the lexical check accepts the escape"
        );
        assert!(
            deny_unless_in_roots(escape, &roots).is_some(),
            "the gate must reject a traversal path before the lexical check is consulted"
        );
    }

    #[test]
    fn gate_rejects_relative_and_nul_paths() {
        let roots = vec!["/Users/dev/project-a".to_string()];
        assert!(deny_unless_in_roots("project-a/src/main.rs", &roots).is_some());
        assert!(deny_unless_in_roots("/Users/dev/project-a/sr\0c", &roots).is_some());
    }

    #[test]
    fn gate_rejects_a_path_outside_every_root() {
        let roots = vec!["/Users/dev/project-a".to_string()];
        assert!(deny_unless_in_roots("/etc/passwd", &roots).is_some());
        assert!(deny_unless_in_roots("/Users/dev/project-abc/f.txt", &roots).is_some());
        assert!(deny_unless_in_roots("/Users/dev/project-a/f.txt", &[]).is_some());
    }

    #[test]
    fn gate_allows_a_plain_path_inside_a_root() {
        let roots = vec!["/Users/dev/project-a".to_string()];
        assert!(deny_unless_in_roots("/Users/dev/project-a/src/main.rs", &roots).is_none());
    }

    /// copy/move gate both endpoints, so a traversal on either side must deny.
    #[test]
    fn both_sides_are_gated_for_transfers() {
        let roots = vec!["/Users/dev/project-a".to_string()];
        let good = "/Users/dev/project-a/src/main.rs";
        let bad = "/Users/dev/project-a/../../../etc/passwd";

        assert!(
            deny_unless_in_roots(good, &roots)
                .or_else(|| deny_unless_in_roots(bad, &roots))
                .is_some()
        );
        assert!(
            deny_unless_in_roots(bad, &roots)
                .or_else(|| deny_unless_in_roots(good, &roots))
                .is_some()
        );
    }
}
