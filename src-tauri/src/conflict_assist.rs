//! Conflict-resolution assist for pull requests.
//!
//! Creates a worktree on a PR's head branch, rebases it onto the PR base, and
//! reports whether the rebase was clean or produced conflicts. On conflicts it
//! returns the conflicted-file list plus a ready-to-inject agent prompt; the
//! frontend spawns an agent PTY in the worktree and seeds it via `sendCommand`.
//! Nothing is ever pushed or merged automatically — the push is a separate,
//! human-gated action in the UI.

use std::path::Path;

use serde::Serialize;

/// Outcome of a conflict-assist run.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ConflictAssistResult {
    /// `"clean"` (rebase applied without conflicts) or `"conflicts"`.
    pub status: String,
    pub worktree_path: String,
    /// The PR head branch that was rebased.
    pub branch: String,
    /// The base branch it was rebased onto.
    pub base: String,
    pub conflicted_files: Vec<String>,
    /// Agent prompt to resolve the conflicts — empty when `status == "clean"`.
    pub prompt: String,
}

/// Dual-emit the conflict-assist lifecycle event (desktop window + event bus).
#[cfg(feature = "desktop")]
fn emit_conflict_assist_status(
    state: &crate::AppState,
    repo_path: &str,
    pr_number: i64,
    status: &str,
    conflicted_files: &[String],
) {
    use tauri::Emitter;
    let payload = serde_json::json!({
        "pr_number": pr_number,
        "status": status,
        "conflicted_files": conflicted_files,
    });
    if let Some(app) = state.app_handle.read().clone() {
        let _ = app.emit(
            "conflict-assist-status",
            serde_json::json!({ "repo_path": repo_path, "payload": payload }),
        );
    }
    let _ = state
        .event_bus
        .send(crate::state::AppEvent::ConflictAssistStatus {
            repo_path: repo_path.to_string(),
            payload,
        });
}

#[cfg(not(feature = "desktop"))]
fn emit_conflict_assist_status(
    _state: &crate::AppState,
    _repo_path: &str,
    _pr_number: i64,
    _status: &str,
    _conflicted_files: &[String],
) {
}

pub(crate) async fn start_conflict_assist_impl(
    repo_path: String,
    pr_number: i64,
    state: &crate::AppState,
) -> Result<ConflictAssistResult, String> {
    let refs = crate::github::get_pr_refs_impl(&repo_path, pr_number, state).await?;
    if refs.head_from_fork {
        return Err(
            "Conflict assist doesn't support PRs from forks yet — the head branch isn't on origin."
                .to_string(),
        );
    }

    let worktrees_dir =
        crate::worktree::resolve_worktree_dir_for_repo(Path::new(&repo_path), &state.worktrees_dir);

    let head_ref = refs.head_ref.clone();
    let base_ref = refs.base_ref.clone();
    let base_ref_for_git = base_ref.clone();
    let repo_path_for_git = repo_path.clone();

    // All blocking git work (fetch, worktree add, rebase, status) runs off the
    // async executor so a slow checkout/rebase doesn't stall other commands.
    let (worktree_path, conflicted, rebase_ok, rebase_stderr) =
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            // Make the head branch available locally. Best-effort: it may already
            // be present, or origin may be unreachable for a local-only branch.
            let _ = crate::git_cli::git_cmd(Path::new(&repo_path_for_git))
                .args(["fetch", "origin", "--", &head_ref])
                .run_silent();

            let config = crate::worktree::WorktreeConfig {
                task_name: format!("conflict-pr-{pr_number}"),
                base_repo: repo_path_for_git.clone(),
                branch: Some(head_ref.clone()),
                create_branch: false,
            };
            let wt = crate::worktree::create_worktree_with_stale_recovery(
                &worktrees_dir,
                &config,
                None,
            )?;
            let wt_path = wt.path.clone();

            // Rebase onto the base. `run_raw` so a conflicting rebase (non-zero
            // exit) is inspected rather than treated as a hard error.
            let rebase = crate::git_cli::git_cmd(&wt_path)
                .args(["rebase", "--", &base_ref_for_git])
                .run_raw()
                .map_err(|e| format!("git rebase failed to start: {e}"))?;
            let rebase_ok = rebase.status.success();
            let rebase_stderr = String::from_utf8_lossy(&rebase.stderr).to_string();

            let status_out = crate::git_cli::git_cmd(&wt_path)
                .args(["status", "--porcelain"])
                .run()
                .map(|o| o.stdout)
                .unwrap_or_default();
            let conflicted = crate::git_cli::parse_conflicted_files_porcelain(&status_out);

            Ok((
                wt_path.to_string_lossy().to_string(),
                conflicted,
                rebase_ok,
                rebase_stderr,
            ))
        })
        .await
        .map_err(|e| format!("conflict-assist task panic: {e}"))??;

    // A non-zero rebase with no unmerged files isn't a conflict — it failed for
    // another reason (missing base ref, dirty tree, …). Surface it instead of
    // reporting a phantom "conflicts" state with an empty file list.
    if !rebase_ok && conflicted.is_empty() {
        return Err(format!(
            "Rebase onto {} failed (not a conflict): {}",
            base_ref,
            rebase_stderr.trim()
        ));
    }

    let (status, prompt) = if conflicted.is_empty() {
        ("clean".to_string(), String::new())
    } else {
        (
            "conflicts".to_string(),
            crate::git_cli::build_conflict_assist_prompt(pr_number, &base_ref, &conflicted),
        )
    };

    emit_conflict_assist_status(state, &repo_path, pr_number, &status, &conflicted);

    Ok(ConflictAssistResult {
        status,
        worktree_path,
        branch: refs.head_ref,
        base: refs.base_ref,
        conflicted_files: conflicted,
        prompt,
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn start_conflict_assist(
    repo_path: String,
    pr_number: i64,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<ConflictAssistResult, String> {
    let state = state.inner().clone();
    start_conflict_assist_impl(repo_path, pr_number, &state).await
}
