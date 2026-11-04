//! Explicit cleanup of a run's recorded workspace through the shared Git safety boundary.
use super::{model::Workspace, run::AutomationRun, store::RunStore};
use crate::{state::AppState, worktree};
use serde::Serialize;
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};
use tuic_git::worktree::{WorkspaceCommitStatus, WorkspaceRemovalSafety};

#[derive(Serialize)]
pub(crate) struct CleanupPreview {
    pub automation_id: String,
    pub run_id: String,
    pub repository: String,
    pub workspace: Option<String>,
    pub workspace_id: Option<String>,
    pub can_remove: bool,
    pub reason: Option<String>,
    pub safety: Option<worktree::WorktreeRemovalPreview>,
}

/// Read provenance from the immutable saved snapshot, never a caller-supplied path.
pub(crate) fn execute(
    state: &Arc<AppState>,
    runs: &RunStore,
    id: &str,
    remove: bool,
) -> Result<Value, String> {
    let run = runs.get(id)?;
    let preview = inspect(state, &run);
    if !remove {
        return serde_json::to_value(preview).map_err(|error| error.to_string());
    }
    if !preview.can_remove {
        return Err(preview
            .reason
            .unwrap_or_else(|| "Worktree cleanup is unsafe".into()));
    }
    let workspace_id = run
        .workspace_id
        .as_deref()
        .ok_or("No recorded workspace id")?;
    // Recheck live ownership immediately before the common removal implementation.
    // No force, lock override, archive hook, or session termination is allowed here.
    let workspace = Path::new(run.workspace.as_deref().ok_or("No recorded workspace")?);
    if !worktree::live_sessions_in(state, workspace).is_empty() {
        return Err("Worktree has live sessions".into());
    }
    let outcome = worktree::remove_worktree_with_presence_confirmation(
        state,
        &run.definition.repository,
        workspace_id,
        true,
        None,
        false,
        false,
        None,
        false,
        false,
    )?;
    state.notify_worktree_removed(crate::state::WorktreeRemovedPayload {
        repo_path: run.definition.repository,
        workspace_id: workspace_id.into(),
        branch: outcome.branch,
    });
    Ok(
        json!({"removed": true, "run_id": run.id, "branch_delete_warning": outcome.branch_delete_warning}),
    )
}

fn inspect(state: &Arc<AppState>, run: &AutomationRun) -> CleanupPreview {
    let mut preview = CleanupPreview {
        automation_id: run.definition.id.clone(),
        run_id: run.id.clone(),
        repository: run.definition.repository.clone(),
        workspace: run.workspace.clone(),
        workspace_id: run.workspace_id.clone(),
        can_remove: false,
        reason: None,
        safety: None,
    };
    let result = (|| -> Result<(), String> {
        if run.status.is_open() {
            return Err("Run is still open".into());
        }
        if !matches!(run.definition.workspace, Workspace::NewPerRun { .. }) {
            return Err("Run uses an existing repository; it cannot be cleaned up".into());
        }
        let id = run
            .workspace_id
            .as_deref()
            .ok_or("No recorded workspace id")?;
        let saved = Path::new(run.workspace.as_deref().ok_or("No recorded workspace")?);
        let repo = Path::new(&run.definition.repository);
        let resolved = tuic_git::worktree::resolve_any_workspace(repo, id)?;
        let current = Path::new(&resolved.path)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if current != saved.canonicalize().map_err(|e| e.to_string())?
            || current == repo.canonicalize().map_err(|e| e.to_string())?
            || resolved.branch != format!("automation/{}", run.id)
        {
            return Err("Recorded automation workspace identity changed".into());
        }
        let safety = worktree::inspect_worktree_removal(state, repo, id);
        let integrated = matches!(
            safety.lifecycle.commit_status,
            WorkspaceCommitStatus::Merged | WorkspaceCommitStatus::InSync
        );
        let clean = safety.lifecycle.removal_safety == WorkspaceRemovalSafety::Safe
            && safety.lifecycle.dirty_files == Some(0)
            && safety.lifecycle.submodule_unpushed_commits.is_empty();
        let live = !safety.live_sessions.is_empty();
        preview.safety = Some(safety);
        if !clean || !integrated || live {
            return Err("Worktree must be clean, integrated and free of live sessions".into());
        }
        let integration = worktree::branch_integration(state, repo, &resolved.branch)?;
        if !integration.integrated || (integration.archive_required && !integration.archived) {
            return Err("Integration proof requires a current-tip archive before cleanup".into());
        }
        Ok(())
    })();
    match result {
        Ok(()) => preview.can_remove = true,
        Err(reason) => preview.reason = Some(reason),
    }
    preview
}

#[cfg(test)]
mod tests;
