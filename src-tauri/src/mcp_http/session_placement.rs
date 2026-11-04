//! Caller-bound placement declarations. Git owns worktree identity; repository deltas own durability.
use std::{path::Path, sync::Arc};

use crate::{AppState, state::WorktreeCreatedPayload};

/// Read the stable declaration without changing the PTY's real cwd or cleanup ownership.
pub(super) fn declared_worktree(
    repositories: &serde_json::Value,
    peer: &str,
) -> Option<(String, String)> {
    repositories["repos"]
        .as_object()?
        .values()
        .find_map(|repo| {
            let placement = &repo["declaredWorktrees"][peer];
            let path = placement["worktreePath"].as_str()?;
            if !Path::new(path).is_dir() {
                return None;
            }
            Some((path.to_owned(), placement["branch"].as_str()?.to_owned()))
        })
}

pub(super) fn declare_worktree(
    state: &Arc<AppState>,
    peer: &str,
    session_id: &str,
    path: &str,
) -> Result<WorktreeCreatedPayload, String> {
    if !crate::fs::is_absolute_on_any_platform(path) {
        return Err("worktree_path must be an absolute existing worktree path".into());
    }
    let target = std::fs::canonicalize(path).map_err(|e| format!("Unknown worktree path: {e}"))?;
    let launch_cwd = state
        .session_maps
        .sessions
        .get(session_id)
        .and_then(|session| session.lock().initial_cwd.clone())
        .ok_or("Caller has no live session launch directory")?;
    let launch = std::fs::canonicalize(&launch_cwd)
        .map_err(|e| format!("Caller launch directory is unavailable: {e}"))?;
    let config = crate::config::load_repositories();
    let repos = config["repos"]
        .as_object()
        .ok_or("No registered repositories")?;
    let mut owner = None;
    let mut owner_depth = 0;
    let mut resolved = None;
    for (repo_path, repo) in repos {
        if repo.get("connectionId").and_then(|v| v.as_str()).is_some() {
            continue;
        }
        let Ok(root) = std::fs::canonicalize(repo_path) else {
            continue;
        };
        let Ok(worktrees) = crate::worktree::get_worktree_paths(repo_path.clone()) else {
            continue;
        };
        for (workspace_id, worktree) in worktrees {
            let Ok(checkout) = std::fs::canonicalize(&worktree.path) else {
                continue;
            };
            if launch.starts_with(&checkout) && checkout.components().count() > owner_depth {
                owner_depth = checkout.components().count();
                owner = Some(repo_path.clone());
            }
            if checkout == target && checkout != root {
                resolved = Some((repo_path.clone(), workspace_id, worktree));
            }
        }
    }
    let (repo_path, workspace_id, worktree) =
        resolved.ok_or("Path is not a linked worktree of a registered repository")?;
    if owner.as_deref() != Some(repo_path.as_str()) {
        return Err(
            "Worktree belongs to another repository; caller placement was not changed".into(),
        );
    }
    let before = repos[&repo_path].clone();
    let mut after = before.clone();
    if !after.is_object() {
        return Err("Invalid repository configuration".into());
    }
    if after.get("declaredWorktrees").is_none() {
        after["declaredWorktrees"] = serde_json::json!({});
    }
    let placement = serde_json::json!({
        "workspaceId": workspace_id, "branch": worktree.branch, "worktreePath": worktree.path,
    });
    after["declaredWorktrees"]
        .as_object_mut()
        .ok_or("Invalid declared worktree configuration")?
        .insert(peer.to_owned(), placement);
    // Preserve the existing snapshot format. A declaration can discover an external
    // checkout without recreating it; only the caller's saved record changes rows.
    let workspace_key = if after.get("workspaces").is_some() {
        "workspaces"
    } else {
        "branches"
    };
    if after.get(workspace_key).is_none() {
        after[workspace_key] = serde_json::json!({});
    }
    let workspaces = after[workspace_key]
        .as_object_mut()
        .ok_or("Invalid workspace configuration")?;
    let mut saved = Vec::new();
    for workspace in workspaces.values_mut() {
        // Reading an optional restore list must not insert null: newly discovered
        // workspace rows omit this field until the frontend's first snapshot.
        if let Some(terminals) = workspace
            .get_mut("savedTerminals")
            .and_then(serde_json::Value::as_array_mut)
        {
            terminals.retain(|terminal| {
                if terminal["tuicSession"].as_str() == Some(peer) {
                    saved.push(terminal.clone());
                    false
                } else {
                    true
                }
            });
        }
    }
    let workspace = workspaces.entry(workspace_id.clone()).or_insert_with(|| {
        serde_json::json!({
            "workspaceId": workspace_id, "branchName": worktree.branch,
            "kind": "worktree", "worktreePath": worktree.path, "isMain": false,
        })
    });
    workspace["worktreePath"] = serde_json::json!(worktree.path);
    workspace["branchName"] = serde_json::json!(worktree.branch);
    if !saved.is_empty() {
        if workspace.get("savedTerminals").is_none() {
            workspace["savedTerminals"] = serde_json::json!([]);
        }
        workspace["savedTerminals"]
            .as_array_mut()
            .ok_or("Invalid saved terminal configuration")?
            .extend(saved);
    }
    let changed = crate::config::save_repositories_request(serde_json::json!({
        "mutationVersion": 1, "repos": [{"id": repo_path, "before": before, "after": after}],
    }))
    .map_err(|e| e.to_string())?;
    if changed {
        state.notify_repositories_changed();
    }
    let payload = WorktreeCreatedPayload {
        repo_path,
        workspace_id,
        branch: worktree.branch,
        worktree_path: worktree.path,
        kind: worktree.kind,
        creator_session: Some(session_id.to_owned()),
        spawn_session: false,
    };
    state.notify_session_worktree_declared(payload.clone());
    Ok(payload)
}
