//! Repository-scoped recipient rule shared by the desktop and native host.
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn git_executable() -> PathBuf {
    if cfg!(unix) && Path::new("/usr/bin/git").is_file() {
        return PathBuf::from("/usr/bin/git");
    }
    #[cfg(windows)]
    for variable in ["PROGRAMFILES", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(variable) {
            for relative in ["Git/cmd/git.exe", "Programs/Git/cmd/git.exe"] {
                let candidate = PathBuf::from(&root).join(relative);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    PathBuf::from("git")
}

/// Resolve linked worktrees to the same repository, without trusting path prefixes.
pub fn repository_key(path: &Path) -> Option<PathBuf> {
    let output = std::process::Command::new(git_executable())
        .args(["-C"])
        .arg(path)
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    std::fs::canonicalize(String::from_utf8(output.stdout).ok()?.trim()).ok()
}

/// Live local agents only; a shell or another repository can never receive feedback.
pub fn review_agents(rows: &Value, repo: &Path) -> Result<Vec<Value>, String> {
    let key = repository_key(repo).ok_or("Design Mode repository is unavailable")?;
    let mut keys = HashMap::<String, Option<PathBuf>>::new();
    let mut agents = Vec::new();
    for row in rows.as_array().ok_or("Invalid session list from FastAF")? {
        if row["connection_id"].as_str().is_some()
            || row
                .pointer("/state/agent_type")
                .and_then(Value::as_str)
                .is_none()
        {
            continue;
        }
        let Some(id) = row["session_id"].as_str().filter(|id| !id.is_empty()) else {
            continue;
        };
        let Some(cwd) = row["worktree_path"]
            .as_str()
            .or_else(|| row["cwd"].as_str())
        else {
            continue;
        };
        let owner = keys
            .entry(cwd.to_owned())
            .or_insert_with(|| repository_key(Path::new(cwd)));
        if owner.as_ref() != Some(&key) {
            continue;
        }
        let label = row["display_name"]
            .as_str()
            .or_else(|| row["alias"].as_str())
            .unwrap_or(id);
        agents.push(json!({"sessionId":id,"label":label,"repoPath":repo,"agentType":row.pointer("/state/agent_type")}));
    }
    Ok(agents)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn git(root: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    // Catches: path-prefix matching offering another repository, or shells as agents.
    #[test]
    fn recipients_include_linked_worktrees_but_exclude_other_repositories_and_shells() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let other = tmp.path().join("repo-other");
        let linked = tmp.path().join("linked");
        std::fs::create_dir(&repo).unwrap();
        std::fs::create_dir(&other).unwrap();
        git(&repo, &["init"]);
        git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        );
        git(
            &repo,
            &["worktree", "add", "--detach", linked.to_str().unwrap()],
        );
        git(&other, &["init"]);
        let rows = json!([
            {"session_id":"main","cwd":repo,"is_remote":true,"state":{"agent_type":"codex"},"display_name":"Main"},
            {"session_id":"linked","cwd":linked,"state":{"agent_type":"claude"},"display_name":"Linked"},
            {"session_id":"other","cwd":other,"state":{"agent_type":"codex"}},
            {"session_id":"shell","cwd":repo,"state":{}},
            {"session_id":"remote","cwd":repo,"state":{"agent_type":"codex"},"connection_id":"remote"}
        ]);
        let agents = review_agents(&rows, &repo).unwrap();
        assert_eq!(
            agents
                .iter()
                .map(|a| a["sessionId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["main", "linked"]
        );
    }
}
