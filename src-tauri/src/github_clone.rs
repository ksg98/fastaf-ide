//! Clone a GitHub repository and register it as a project.
//!
//! `github_list_user_repos` discovers the signed-in user's repositories via
//! REST (`GET /user/repos`, newest-pushed first) using the same github.com
//! token chain as the rest of the GitHub integration. `github_clone_repo`
//! shells out to `git clone --progress`, streaming progress lines back as
//! events. For private github.com HTTPS clones the token is injected as a
//! one-shot `http.extraheader` config (the actions/checkout pattern) — it is
//! never written to the cloned repo's config and never logged.

use std::collections::VecDeque;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;

use crate::state::AppState;

#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter, State};

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/// A repository URL normalized for cloning.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ParsedRepoUrl {
    /// URL to pass to `git clone` (canonical https, or ssh passthrough).
    pub clone_url: String,
    /// Host component ("github.com", "ghe.example.com", …).
    pub host: String,
    /// Repository name — default destination folder name.
    pub repo_name: String,
}

/// Parse user input into a cloneable URL. Accepts full https URLs (extra path
/// segments like `/tree/main` and query strings are dropped), `git@host:o/r`
/// SSH URLs (passed through), and bare `owner/repo` shorthand (→ github.com).
pub(crate) fn parse_github_url(input: &str) -> Result<ParsedRepoUrl, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Repository URL is empty".to_string());
    }

    // SSH: git@host:owner/repo(.git) — pass through untouched (user's keys apply)
    if let Some(rest) = input.strip_prefix("git@") {
        let (host, path) = rest
            .split_once(':')
            .ok_or_else(|| format!("Invalid SSH repository URL: {input}"))?;
        let (_, repo) = owner_repo_from_path(path)
            .ok_or_else(|| format!("Invalid SSH repository URL: {input}"))?;
        if host.is_empty() {
            return Err(format!("Invalid SSH repository URL: {input}"));
        }
        return Ok(ParsedRepoUrl {
            clone_url: input.to_string(),
            host: host.to_string(),
            repo_name: repo,
        });
    }

    // HTTPS/HTTP: https://host/owner/repo[.git][/extra…][?…][#…]
    if let Some(rest) = input
        .strip_prefix("https://")
        .or_else(|| input.strip_prefix("http://"))
    {
        let rest = rest.split(['?', '#']).next().unwrap_or(rest);
        let (host, path) = rest
            .split_once('/')
            .ok_or_else(|| format!("Repository URL has no path: {input}"))?;
        let (owner, repo) = owner_repo_from_path(path)
            .ok_or_else(|| format!("Repository URL must include owner and repo: {input}"))?;
        if host.is_empty() {
            return Err(format!("Repository URL has no host: {input}"));
        }
        return Ok(ParsedRepoUrl {
            clone_url: format!("https://{host}/{owner}/{repo}.git"),
            host: host.to_string(),
            repo_name: repo,
        });
    }

    // Shorthand: owner/repo → github.com
    if !input.contains(char::is_whitespace)
        && let Some((owner, repo)) = owner_repo_from_path(input)
        && input.matches('/').count() == 1
    {
        return Ok(ParsedRepoUrl {
            clone_url: format!("https://github.com/{owner}/{repo}.git"),
            host: "github.com".to_string(),
            repo_name: repo,
        });
    }

    Err(format!(
        "Unrecognized repository URL: {input} (expected https://github.com/owner/repo, git@host:owner/repo, or owner/repo)"
    ))
}

/// First two path segments as `(owner, repo)`, stripping a trailing `.git`.
fn owner_repo_from_path(path: &str) -> Option<(String, String)> {
    let mut segs = path.split('/').filter(|s| !s.is_empty());
    let owner = segs.next()?;
    let repo_raw = segs.next()?;
    let repo = repo_raw.strip_suffix(".git").unwrap_or(repo_raw);
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

// ---------------------------------------------------------------------------
// Repo listing
// ---------------------------------------------------------------------------

/// One repository from `GET /user/repos`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct GithubRepoEntry {
    pub full_name: String,
    pub clone_url: String,
    pub ssh_url: String,
    pub private: bool,
    pub description: Option<String>,
    pub pushed_at: Option<String>,
}

/// Parse a `/user/repos` response leniently — entries missing `full_name` are
/// skipped, other fields default.
pub(crate) fn parse_user_repos(json: &serde_json::Value) -> Vec<GithubRepoEntry> {
    let Some(entries) = json.as_array() else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|e| {
            let full_name = e.get("full_name")?.as_str()?.to_string();
            let clone_url = e
                .get("clone_url")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| format!("https://github.com/{full_name}.git"));
            Some(GithubRepoEntry {
                clone_url,
                ssh_url: e
                    .get("ssh_url")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                private: e.get("private").and_then(|v| v.as_bool()).unwrap_or(false),
                description: e
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                pushed_at: e
                    .get("pushed_at")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                full_name,
            })
        })
        .collect()
}

/// github.com token: cached in state, else fresh chain resolve off-thread
/// (keychain access can block). Mirrors the lazy-resolve in `graphql_with_retry`.
async fn resolve_github_com_token(state: &AppState) -> Result<Option<String>, String> {
    let cached = state.github_token.read().clone();
    if cached.is_some() {
        return Ok(cached);
    }
    let (t, s) = tokio::task::spawn_blocking(crate::github_auth::resolve_token_with_source)
        .await
        .map_err(|e| format!("Token resolve task panicked: {e}"))?;
    if t.is_some() {
        *state.github_token.write() = t.clone();
        *state.github_token_source.write() = s;
    }
    Ok(t)
}

pub(crate) async fn github_list_user_repos_impl(
    state: &AppState,
) -> Result<Vec<GithubRepoEntry>, String> {
    let token = resolve_github_com_token(state)
        .await?
        .ok_or("GitHub not connected — sign in under Settings → GitHub")?;

    let account = crate::github::github_com_account(state);
    let mut repos = Vec::new();
    for page in 1..=3u32 {
        let url = crate::github_account::github_rest_url(
            &account.host,
            &format!("/user/repos?per_page=100&sort=pushed&page={page}"),
        );
        crate::github_debug::log_api("GET", &url, "github_list_user_repos");
        let response = state
            .http_client
            .get(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("User-Agent", "tuicommander")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("GitHub API request failed: {e}"))?;

        let status = response.status();
        if !status.is_success() {
            let json: serde_json::Value = response
                .json()
                .await
                .unwrap_or_else(|_| serde_json::json!({"message": "Unknown error"}));
            let msg = json["message"].as_str().unwrap_or("Unknown error");
            return Err(format!("GitHub API error ({status}): {msg}"));
        }
        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Invalid GitHub API response: {e}"))?;
        let page_len = json.as_array().map(|a| a.len()).unwrap_or(0);
        repos.extend(parse_user_repos(&json));
        if page_len < 100 {
            break;
        }
    }
    Ok(repos)
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

/// Parse a git progress line into `(phase, percent)`. Lines look like
/// `Receiving objects:  42% (123/292), 1.2 MiB | 2.4 MiB/s` (possibly with a
/// `remote: ` prefix for the server-side phases).
pub(crate) fn parse_clone_progress(line: &str) -> Option<(&'static str, u32)> {
    let line = line.strip_prefix("remote: ").unwrap_or(line);
    let (phase, rest) = if let Some(r) = line.strip_prefix("Receiving objects:") {
        ("Receiving objects", r)
    } else if let Some(r) = line.strip_prefix("Resolving deltas:") {
        ("Resolving deltas", r)
    } else if let Some(r) = line.strip_prefix("Counting objects:") {
        ("Counting objects", r)
    } else if let Some(r) = line.strip_prefix("Compressing objects:") {
        ("Compressing objects", r)
    } else if let Some(r) = line.strip_prefix("Updating files:") {
        ("Updating files", r)
    } else {
        return None;
    };
    let pct = rest.trim_start().split('%').next()?.trim().parse::<u32>().ok()?;
    Some((phase, pct.min(100)))
}

/// Run `git clone --progress`, forwarding parsed progress to `on_progress`
/// (deduplicated — each (phase, percent) pair fires once). Returns Err with
/// the last non-progress stderr lines on failure. Blocking — call from
/// `spawn_blocking`.
fn run_git_clone(
    clone_url: &str,
    dest: &str,
    auth_config: Option<&str>,
    on_progress: impl Fn(&str, u32),
) -> Result<(), String> {
    let mut cmd = std::process::Command::new(crate::cli::resolve_cli("git"));
    if let Some(cfg) = auth_config {
        cmd.args(["-c", cfg]);
    }
    cmd.args(["clone", "--progress", clone_url, dest]);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::piped());
    crate::cli::apply_no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start git: {e}"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture git output")?;

    // git rewrites progress lines with \r — read raw bytes and treat \r and \n
    // both as line terminators.
    let mut tail: VecDeque<String> = VecDeque::new();
    let mut line_buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut last_emitted: Option<(&'static str, u32)> = None;
    loop {
        let n = match stderr.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => return Err(format!("Failed to read git output: {e}")),
        };
        for &b in &chunk[..n] {
            if b == b'\r' || b == b'\n' {
                if !line_buf.is_empty() {
                    let line = String::from_utf8_lossy(&line_buf).to_string();
                    line_buf.clear();
                    if let Some((phase, pct)) = parse_clone_progress(&line) {
                        if last_emitted != Some((phase, pct)) {
                            last_emitted = Some((phase, pct));
                            on_progress(phase, pct);
                        }
                    } else {
                        if tail.len() >= 8 {
                            tail.pop_front();
                        }
                        tail.push_back(line);
                    }
                }
            } else {
                line_buf.push(b);
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("Failed to wait for git: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        let detail = tail
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        if detail.is_empty() {
            Err(format!("git clone failed ({status})"))
        } else {
            Err(format!("git clone failed: {detail}"))
        }
    }
}

/// Clone `url` into `dest_dir/<repo_name>` and return the final path.
pub(crate) async fn github_clone_repo_impl(
    state: &AppState,
    url: String,
    dest_dir: String,
    on_progress: impl Fn(&str, u32) + Send + 'static,
) -> Result<String, String> {
    let parsed = parse_github_url(&url)?;
    let dest_root_str = crate::cli::expand_tilde(dest_dir.trim());
    let dest_root = Path::new(&dest_root_str);
    if dest_root_str.is_empty() || !dest_root.is_dir() {
        return Err(format!(
            "Destination folder does not exist: {dest_root_str}"
        ));
    }
    let dest = dest_root.join(&parsed.repo_name);
    if dest.exists() {
        return Err(format!("Destination already exists: {}", dest.display()));
    }

    // One-shot auth header for private github.com HTTPS clones. `-c` applies to
    // this invocation only — nothing is written to the cloned repo's config.
    let auth_config = if parsed.host == "github.com" && parsed.clone_url.starts_with("https://") {
        resolve_github_com_token(state).await?.map(|token| {
            use base64::{Engine as _, engine::general_purpose};
            let b64 = general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
            format!("http.https://github.com/.extraheader=AUTHORIZATION: basic {b64}")
        })
    } else {
        None
    };

    let clone_url = parsed.clone_url.clone();
    let dest_str = dest.to_string_lossy().to_string();
    let dest_ret = dest_str.clone();

    tokio::task::spawn_blocking(move || {
        run_git_clone(&clone_url, &dest_str, auth_config.as_deref(), on_progress)
    })
    .await
    .map_err(|e| format!("Clone task panicked: {e}"))??;

    Ok(dest_ret)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn github_list_user_repos(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<GithubRepoEntry>, String> {
    github_list_user_repos_impl(state.inner()).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn github_clone_repo(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    url: String,
    dest_dir: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    github_clone_repo_impl(&state, url, dest_dir, move |phase, percent| {
        let _ = app.emit(
            "clone-progress",
            serde_json::json!({ "phase": phase, "percent": percent }),
        );
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_https_url() {
        let p = parse_github_url("https://github.com/owner/repo").unwrap();
        assert_eq!(p.clone_url, "https://github.com/owner/repo.git");
        assert_eq!(p.host, "github.com");
        assert_eq!(p.repo_name, "repo");
    }

    #[test]
    fn parse_https_url_with_git_suffix_and_extras() {
        let p = parse_github_url("https://github.com/owner/repo.git").unwrap();
        assert_eq!(p.clone_url, "https://github.com/owner/repo.git");
        assert_eq!(p.repo_name, "repo");

        // Deep links, trailing slashes, query strings are normalized away
        let p = parse_github_url("https://github.com/owner/repo/tree/main?tab=readme").unwrap();
        assert_eq!(p.clone_url, "https://github.com/owner/repo.git");
        assert_eq!(p.repo_name, "repo");

        let p = parse_github_url("https://github.com/owner/repo/").unwrap();
        assert_eq!(p.clone_url, "https://github.com/owner/repo.git");
    }

    #[test]
    fn parse_ghe_https_url() {
        let p = parse_github_url("https://ghe.acme.com/team/tool.git").unwrap();
        assert_eq!(p.clone_url, "https://ghe.acme.com/team/tool.git");
        assert_eq!(p.host, "ghe.acme.com");
        assert_eq!(p.repo_name, "tool");
    }

    #[test]
    fn parse_ssh_url_passthrough() {
        let p = parse_github_url("git@github.com:owner/repo.git").unwrap();
        assert_eq!(p.clone_url, "git@github.com:owner/repo.git");
        assert_eq!(p.host, "github.com");
        assert_eq!(p.repo_name, "repo");
    }

    #[test]
    fn parse_shorthand() {
        let p = parse_github_url("owner/repo").unwrap();
        assert_eq!(p.clone_url, "https://github.com/owner/repo.git");
        assert_eq!(p.host, "github.com");
        assert_eq!(p.repo_name, "repo");
    }

    #[test]
    fn parse_invalid_urls() {
        assert!(parse_github_url("").is_err());
        assert!(parse_github_url("   ").is_err());
        assert!(parse_github_url("not a url").is_err());
        assert!(parse_github_url("https://github.com").is_err());
        assert!(parse_github_url("https://github.com/owner").is_err());
        assert!(parse_github_url("git@github.com").is_err());
        assert!(parse_github_url("owner/repo/extra").is_err());
        assert!(parse_github_url("/leading").is_err());
    }

    #[test]
    fn parse_user_repos_normal() {
        let json = serde_json::json!([
            {
                "full_name": "octocat/hello",
                "clone_url": "https://github.com/octocat/hello.git",
                "ssh_url": "git@github.com:octocat/hello.git",
                "private": true,
                "description": "demo",
                "pushed_at": "2026-07-01T00:00:00Z"
            },
            {
                "full_name": "octocat/world",
                "private": false
            }
        ]);
        let repos = parse_user_repos(&json);
        assert_eq!(repos.len(), 2);
        assert_eq!(repos[0].full_name, "octocat/hello");
        assert!(repos[0].private);
        assert_eq!(repos[0].description.as_deref(), Some("demo"));
        // Missing clone_url falls back to the canonical form
        assert_eq!(
            repos[1].clone_url,
            "https://github.com/octocat/world.git"
        );
        assert!(!repos[1].private);
        assert_eq!(repos[1].description, None);
    }

    #[test]
    fn parse_user_repos_skips_malformed() {
        let json = serde_json::json!([
            { "clone_url": "https://x/y.git" }, // no full_name
            42,
            { "full_name": "a/b" }
        ]);
        let repos = parse_user_repos(&json);
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].full_name, "a/b");
    }

    #[test]
    fn parse_user_repos_non_list() {
        assert!(parse_user_repos(&serde_json::json!({"message": "Bad credentials"})).is_empty());
    }

    #[test]
    fn clone_progress_lines() {
        assert_eq!(
            parse_clone_progress("Receiving objects:  42% (123/292), 1.2 MiB | 2.4 MiB/s"),
            Some(("Receiving objects", 42))
        );
        assert_eq!(
            parse_clone_progress("remote: Counting objects: 100% (321/321), done."),
            Some(("Counting objects", 100))
        );
        assert_eq!(
            parse_clone_progress("Resolving deltas: 7% (14/200)"),
            Some(("Resolving deltas", 7))
        );
        assert_eq!(parse_clone_progress("Cloning into 'repo'..."), None);
        assert_eq!(parse_clone_progress("fatal: repository not found"), None);
        assert_eq!(parse_clone_progress(""), None);
    }
}
