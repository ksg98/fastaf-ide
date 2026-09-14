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
    /// `"clean"`, `"clean_unverified"`, or `"conflicts"`.
    pub status: String,
    pub worktree_path: String,
    /// The PR head branch that was rebased.
    pub branch: String,
    /// The base branch it was rebased onto.
    pub base: String,
    /// `"fetched_remote"`, `"existing_tracking"`, or `"local_fallback"`.
    pub base_source: String,
    /// Present when the selected base could not be refreshed from origin.
    pub base_warning: Option<String>,
    pub conflicted_files: Vec<String>,
    /// Agent prompt to resolve the conflicts — empty unless `status == "conflicts"`.
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

/// Fetch the PR base branch and decide what `git rebase` should target.
///
/// Rebasing onto the bare branch name resolves against the local `refs/heads/<base>`,
/// which may be days stale — the rebase then comes back `clean` against an old base and
/// the user pushes a PR that actually conflicts. Mirrors `local_pr_diff` in `github.rs`:
/// fetch `+refs/heads/<base>:refs/remotes/origin/<base>` and rebase the remote-tracking
/// ref, so "clean" means clean against what origin has right now.
///
/// Falls back to the bare name when no remote-tracking ref exists afterwards — a
/// local-only base branch or an unreachable origin should still get a (clearly
/// local) answer rather than a hard failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BaseSource {
    FetchedRemote,
    ExistingTracking,
    LocalFallback,
}

impl BaseSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::FetchedRemote => "fetched_remote",
            Self::ExistingTracking => "existing_tracking",
            Self::LocalFallback => "local_fallback",
        }
    }

    fn warning(self, base_ref: &str) -> Option<String> {
        match self {
            Self::FetchedRemote => None,
            Self::ExistingTracking => Some(format!(
                "Could not refresh origin/{base_ref}; conflict result uses the existing remote-tracking ref."
            )),
            Self::LocalFallback => Some(format!(
                "Could not refresh origin/{base_ref} and no remote-tracking ref exists; conflict result uses the local {base_ref} branch."
            )),
        }
    }
}

#[derive(Debug)]
struct ResolvedBase {
    target: String,
    source: BaseSource,
}

fn ref_exists(repo: &Path, reference: &str) -> bool {
    crate::git_cli::git_cmd(repo)
        .args([
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{reference}^{{commit}}"),
        ])
        .run()
        .is_ok()
}

fn resolve_rebase_target(repo: &Path, base_ref: &str) -> Result<ResolvedBase, String> {
    let remote_ref = format!("refs/remotes/origin/{base_ref}");
    let refspec = format!("+refs/heads/{base_ref}:{remote_ref}");
    let fetch = crate::git_cli::git_cmd(repo)
        .args(["fetch", "--no-tags", "origin", &refspec])
        .run();

    if fetch.is_ok() && ref_exists(repo, &remote_ref) {
        return Ok(ResolvedBase {
            target: remote_ref,
            source: BaseSource::FetchedRemote,
        });
    }
    if ref_exists(repo, &remote_ref) {
        return Ok(ResolvedBase {
            target: remote_ref,
            source: BaseSource::ExistingTracking,
        });
    }
    if ref_exists(repo, base_ref) {
        return Ok(ResolvedBase {
            target: base_ref.to_string(),
            source: BaseSource::LocalFallback,
        });
    }

    let fetch_error = fetch
        .err()
        .map(|error| format!(": {error}"))
        .unwrap_or_default();
    Err(format!(
        "Could not resolve PR base {base_ref} from origin, remote tracking, or a local branch{fetch_error}"
    ))
}

/// Rebase `worktree` onto `rebase_target` and report what happened.
///
/// Split out from the command so the three outcomes — clean, conflicted, and failed for
/// some other reason — are reachable from tests against a fixture repo without any
/// network or PR plumbing.
fn rebase_and_collect_conflicts(
    worktree: &Path,
    rebase_target: &str,
) -> (bool, Vec<String>, String) {
    // `run_raw` so a conflicting rebase (non-zero exit) is inspected rather than
    // treated as a hard error.
    let rebase = crate::git_cli::git_cmd(worktree)
        .args(["rebase", "--", rebase_target])
        .run_raw();
    let (rebase_ok, rebase_stderr) = match rebase {
        Ok(out) => (
            out.status.success(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        ),
        Err(e) => (false, format!("git rebase failed to start: {e}")),
    };

    let status_out = crate::git_cli::git_cmd(worktree)
        .args(["status", "--porcelain"])
        .run()
        .map(|o| o.stdout)
        .unwrap_or_default();
    let conflicted = crate::git_cli::parse_conflicted_files_porcelain(&status_out);

    (rebase_ok, conflicted, rebase_stderr)
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
    let (worktree_path, conflicted, rebase_ok, rebase_stderr, base_source) =
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

            // Rebase onto what origin has now, not a possibly-stale local branch.
            let resolved_base =
                resolve_rebase_target(Path::new(&repo_path_for_git), &base_ref_for_git)?;
            let (rebase_ok, conflicted, rebase_stderr) =
                rebase_and_collect_conflicts(&wt_path, &resolved_base.target);

            Ok((
                wt_path.to_string_lossy().to_string(),
                conflicted,
                rebase_ok,
                rebase_stderr,
                resolved_base.source,
            ))
        })
        .await
        .map_err(|e| format!("conflict-assist task panic: {e}"))??;

    // A non-zero rebase with no unmerged files isn't a conflict — it failed for
    // another reason (missing base ref, dirty tree, …). Surface it instead of
    // reporting a phantom "conflicts" state with an empty file list.
    if !rebase_ok && conflicted.is_empty() {
        // Abort before returning: git may have stopped mid-rebase (detached HEAD,
        // rebase-merge state on disk), and leaving it that way strands the worktree
        // so every later run fails with "a rebase is already in progress". Same
        // recovery the merge/rebase paths in git.rs and worktree.rs use.
        return Err(crate::git_cli::finish_failed_git_operation_after_abort(
            Path::new(&worktree_path),
            "rebase",
            &format!("Rebase onto {base_ref} failed (not a conflict)"),
            rebase_stderr.trim(),
        ));
    }

    let base_warning = base_source.warning(&base_ref);
    let (status, prompt) = if conflicted.is_empty() {
        (
            if base_source == BaseSource::FetchedRemote {
                "clean"
            } else {
                "clean_unverified"
            }
            .to_string(),
            String::new(),
        )
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
        base_source: base_source.as_str().to_string(),
        base_warning,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn git(repo: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .current_dir(repo)
            .args(args)
            .output()
            .expect("git")
    }

    fn write(repo: &Path, name: &str, body: &str) {
        std::fs::write(repo.join(name), body).expect("write");
    }

    /// A repo on `main` with one commit, plus a `feature` branch forked from it.
    /// Both branches are left ready for the caller to add divergent commits.
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_path_buf();
        git(&path, &["init", "--initial-branch=main"]);
        git(&path, &["config", "user.email", "test@test.com"]);
        git(&path, &["config", "user.name", "Test"]);
        write(&path, "shared.txt", "base\n");
        git(&path, &["add", "."]);
        git(&path, &["commit", "-m", "base"]);
        git(&path, &["branch", "feature"]);
        (dir, path)
    }

    /// Advance `branch` with a commit touching `file`.
    fn commit_on(repo: &Path, branch: &str, file: &str, body: &str, msg: &str) {
        git(repo, &["checkout", branch]);
        write(repo, file, body);
        git(repo, &["add", "."]);
        git(repo, &["commit", "-m", msg]);
    }

    #[test]
    fn clean_rebase_reports_no_conflicts() {
        let (_d, repo) = fixture();
        // main and feature touch different files — nothing to collide.
        commit_on(&repo, "main", "on_main.txt", "main\n", "main work");
        commit_on(
            &repo,
            "feature",
            "on_feature.txt",
            "feature\n",
            "feature work",
        );

        let (ok, conflicted, stderr) = rebase_and_collect_conflicts(&repo, "main");
        assert!(ok, "clean rebase must succeed: {stderr}");
        assert!(
            conflicted.is_empty(),
            "unexpected conflicts: {conflicted:?}"
        );
    }

    #[test]
    fn conflicting_rebase_reports_the_conflicted_file() {
        let (_d, repo) = fixture();
        // Both sides edit the same line of the same file.
        commit_on(&repo, "main", "shared.txt", "from main\n", "main edit");
        commit_on(
            &repo,
            "feature",
            "shared.txt",
            "from feature\n",
            "feature edit",
        );

        let (ok, conflicted, _) = rebase_and_collect_conflicts(&repo, "main");
        assert!(!ok, "a conflicting rebase must not report success");
        assert_eq!(conflicted, vec!["shared.txt"]);
    }

    /// The case the abort exists for: the rebase fails without producing any
    /// unmerged file, so the caller cannot tell it apart from a conflict by the
    /// file list alone and must not leave the repo mid-rebase.
    #[test]
    fn rebase_failure_without_conflicts_yields_empty_file_list() {
        let (_d, repo) = fixture();
        commit_on(
            &repo,
            "feature",
            "on_feature.txt",
            "feature\n",
            "feature work",
        );

        let (ok, conflicted, stderr) =
            rebase_and_collect_conflicts(&repo, "refs/remotes/origin/nope");
        assert!(!ok, "rebase onto a missing ref must fail");
        assert!(
            conflicted.is_empty(),
            "a missing base is not a conflict, got {conflicted:?}"
        );
        assert!(!stderr.trim().is_empty(), "the failure must carry a reason");
    }

    /// After a failed rebase the abort must leave the worktree usable — otherwise
    /// every later conflict-assist run dies with "a rebase is already in progress".
    #[test]
    fn abort_after_a_failed_rebase_leaves_the_worktree_clean() {
        let (_d, repo) = fixture();
        commit_on(&repo, "main", "shared.txt", "from main\n", "main edit");
        commit_on(
            &repo,
            "feature",
            "shared.txt",
            "from feature\n",
            "feature edit",
        );

        let (ok, conflicted, _) = rebase_and_collect_conflicts(&repo, "main");
        assert!(
            !ok && !conflicted.is_empty(),
            "precondition: conflicted rebase"
        );

        let msg = crate::git_cli::finish_failed_git_operation_after_abort(
            &repo,
            "rebase",
            "Rebase failed",
            "boom",
        );
        assert!(msg.contains("aborted"), "abort must be reported: {msg}");

        let status = git(&repo, &["status", "--porcelain"]);
        assert!(
            String::from_utf8_lossy(&status.stdout).trim().is_empty(),
            "worktree must be clean after abort"
        );
        // And a fresh rebase must be startable again.
        let (_, _, stderr) = rebase_and_collect_conflicts(&repo, "main");
        assert!(
            !stderr.contains("already in progress"),
            "repo left mid-rebase: {stderr}"
        );
    }

    /// No origin configured: the fetch fails, no remote-tracking ref appears, and the
    /// bare branch name must still be usable rather than a ref that does not exist.
    #[test]
    fn rebase_target_falls_back_to_the_local_branch_without_a_remote() {
        let (_d, repo) = fixture();
        let resolved = resolve_rebase_target(&repo, "main").expect("local fallback");
        assert_eq!(resolved.target, "main");
        assert_eq!(resolved.source, BaseSource::LocalFallback);
    }

    /// With a reachable origin the remote-tracking ref wins — that is the whole point:
    /// "clean" must mean clean against what origin has now, not a stale local branch.
    #[test]
    fn rebase_target_prefers_the_remote_tracking_ref() {
        let (_origin_dir, origin) = fixture();
        let clone_dir = tempfile::tempdir().expect("tempdir");
        let clone = clone_dir.path().join("clone");
        let out = Command::new("git")
            .args(["clone", origin.to_str().unwrap(), clone.to_str().unwrap()])
            .output()
            .expect("git clone");
        assert!(out.status.success(), "clone failed");
        git(&clone, &["config", "user.email", "test@test.com"]);
        git(&clone, &["config", "user.name", "Test"]);

        // origin moves ahead after the clone — the local refs/heads/main is now stale.
        commit_on(&origin, "main", "on_main.txt", "main\n", "main work");

        let resolved = resolve_rebase_target(&clone, "main").expect("fetched remote");
        assert_eq!(resolved.target, "refs/remotes/origin/main");
        assert_eq!(resolved.source, BaseSource::FetchedRemote);
        // And the fetch actually advanced it, so a rebase would see the new commit.
        let rev = git(&clone, &["rev-parse", "refs/remotes/origin/main"]);
        let local = git(&clone, &["rev-parse", "refs/heads/main"]);
        assert_ne!(
            String::from_utf8_lossy(&rev.stdout),
            String::from_utf8_lossy(&local.stdout),
            "remote-tracking ref must be ahead of the stale local branch"
        );
    }

    #[test]
    fn rebase_target_uses_existing_tracking_ref_when_fetch_fails() {
        let (_d, repo) = fixture();
        git(
            &repo,
            &["update-ref", "refs/remotes/origin/main", "refs/heads/main"],
        );

        let resolved = resolve_rebase_target(&repo, "main").expect("existing tracking ref");
        assert_eq!(resolved.target, "refs/remotes/origin/main");
        assert_eq!(resolved.source, BaseSource::ExistingTracking);
        assert!(resolved.source.warning("main").is_some());
    }

    #[test]
    fn rebase_target_rejects_a_missing_remote_and_local_ref() {
        let (_d, repo) = fixture();
        let error = resolve_rebase_target(&repo, "missing").expect_err("missing base must fail");
        assert!(
            error.contains("Could not resolve PR base missing"),
            "{error}"
        );
    }
}
