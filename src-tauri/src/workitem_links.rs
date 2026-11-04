//! Persistent links between a worktree branch and a work item (story 1685-4b12).
//!
//! One JSON document in the config dir, `{repoPath -> {branch -> WorkItemLink}}`,
//! written only under the `ConfigFile` locks. Loads are strict: a corrupt file is
//! moved aside and the write fails, so a parse error never erases every link.
use crate::work_items::model::{WorkItemRef, WorkItemState};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const LINKS_FILE: &str = "workitem_links.json";
const MAX_TEXT: usize = 512;
const MAX_URL: usize = 2048;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkItemLink {
    pub reference: WorkItemRef,
    pub key: String,
    pub title: String,
    pub url: String,
    pub state: Option<WorkItemState>,
}

/// `repoPath -> branch -> link`.
pub(crate) type WorkItemLinks = BTreeMap<String, BTreeMap<String, WorkItemLink>>;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct GitRemote {
    pub name: String,
    pub url: String,
}

pub(crate) struct LinkStore {
    file: crate::config::ConfigFile<WorkItemLinks>,
}

impl LinkStore {
    pub(crate) fn new() -> Self {
        Self {
            file: crate::config::ConfigFile::new(LINKS_FILE),
        }
    }

    #[cfg(test)]
    fn at_path(path: std::path::PathBuf) -> Self {
        Self {
            file: crate::config::ConfigFile::at_path(path),
        }
    }

    pub(crate) fn list(&self) -> Result<WorkItemLinks, String> {
        self.file
            .update_with_strict(|links| Ok((links.clone(), false)))
    }

    pub(crate) fn link(
        &self,
        repo_path: &str,
        branch: &str,
        link: WorkItemLink,
    ) -> Result<(), String> {
        validate(repo_path, branch, &link)?;
        self.file.update_with_strict(|links| {
            let key = stored_key(links, repo_path);
            let changed = links.get(&key).and_then(|b| b.get(branch)) != Some(&link);
            if changed {
                links
                    .entry(key)
                    .or_default()
                    .insert(branch.to_string(), link);
            }
            Ok(((), changed))
        })
    }

    /// Returns whether a link existed. A missing link does not touch the file.
    pub(crate) fn unlink(&self, repo_path: &str, branch: &str) -> Result<bool, String> {
        self.file.update_with_strict(|links| {
            let key = stored_key(links, repo_path);
            let Some(branches) = links.get_mut(&key) else {
                return Ok((false, false));
            };
            let removed = branches.remove(branch).is_some();
            if branches.is_empty() {
                links.remove(&key);
            }
            Ok((removed, removed))
        })
    }
}

/// The spelling of a repository that identifies it: symlinks resolved, and a
/// trailing separator dropped when the path no longer exists.
fn repo_identity(path: &str) -> std::path::PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| {
        std::path::PathBuf::from(path.trim_end_matches(['/', '\\']).to_string())
    })
}

/// The key already stored for the same repository, else `repo_path` as given, so
/// the frontend keeps finding links under the spelling it used.
fn stored_key(links: &WorkItemLinks, repo_path: &str) -> String {
    if links.contains_key(repo_path) {
        return repo_path.to_string();
    }
    let identity = repo_identity(repo_path);
    links
        .keys()
        .find(|key| repo_identity(key) == identity)
        .cloned()
        .unwrap_or_else(|| repo_path.to_string())
}

/// Reject input that the badge would render or open unsafely.
pub(crate) fn validate(repo_path: &str, branch: &str, link: &WorkItemLink) -> Result<(), String> {
    if !crate::fs::is_absolute_on_any_platform(repo_path) {
        return Err("repoPath must be absolute".into());
    }
    if branch.trim().is_empty() || branch.len() > MAX_TEXT {
        return Err("branch must be a non-empty name".into());
    }
    let r = &link.reference;
    for (name, value) in [
        ("reference.providerId", r.provider_id.as_str()),
        ("reference.accountId", r.account_id.as_str()),
        ("reference.id", r.id.as_str()),
        ("key", link.key.as_str()),
    ] {
        if value.trim().is_empty() || value.len() > MAX_TEXT {
            return Err(format!(
                "{name} must be non-empty and at most {MAX_TEXT} bytes"
            ));
        }
    }
    if link.title.len() > MAX_TEXT {
        return Err(format!("title must be at most {MAX_TEXT} bytes"));
    }
    // The badge opens this URL: anything but http(s) could launch a local handler.
    let url = link.url.to_ascii_lowercase();
    if link.url.len() > MAX_URL || !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("url must be an http(s) URL".into());
    }
    Ok(())
}

/// Every remote of a repository, with credentials removed from the URLs.
pub(crate) fn git_remotes(repo_path: &std::path::Path) -> Vec<GitRemote> {
    crate::git::list_remotes(repo_path)
        .into_iter()
        .map(|(name, url)| GitRemote {
            name,
            url: strip_userinfo(&url),
        })
        .collect()
}

/// `https://user:token@host/x` -> `https://host/x`. A token embedded in a
/// remote URL must never reach plugin JavaScript. scp-like `git@host:x` keeps
/// its user: it carries no secret.
fn strip_userinfo(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    match rest[..authority_end].rfind('@') {
        Some(at) => format!("{scheme}://{}", &rest[at + 1..]),
        None => url.to_string(),
    }
}

/// Drop the link of a worktree TUIC removed. Called from
/// `AppState::notify_worktree_removed`, the one seam every removal path shares.
pub(crate) fn drop_link_of_removed_worktree(repo_path: &str, branch: &str) {
    if let Err(e) = LinkStore::new().unlink(repo_path, branch) {
        tracing::warn!(source = "workitem_links", repo = %repo_path, branch = %branch, "Could not drop link of removed worktree: {e}");
    }
}

// --- Tauri commands ---

#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) async fn list_workitem_links() -> Result<WorkItemLinks, String> {
    tokio::task::spawn_blocking(|| LinkStore::new().list())
        .await
        .map_err(|e| format!("Task panic: {e}"))?
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) async fn link_workitem(
    repo_path: String,
    branch: String,
    link: WorkItemLink,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || LinkStore::new().link(&repo_path, &branch, link))
        .await
        .map_err(|e| format!("Task panic: {e}"))?
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) async fn unlink_workitem(repo_path: String, branch: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || LinkStore::new().unlink(&repo_path, &branch))
        .await
        .map_err(|e| format!("Task panic: {e}"))?
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) async fn get_git_remotes(path: String) -> Result<Vec<GitRemote>, String> {
    tokio::task::spawn_blocking(move || git_remotes(std::path::Path::new(&path)))
        .await
        .map_err(|e| format!("Task panic: {e}"))
}

#[cfg(test)]
#[path = "workitem_links_tests.rs"]
mod tests;
