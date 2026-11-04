use serde::{Deserialize, Serialize};

/// A canonical, validated GitHub host (e.g. `github.com`, `ghe.acme.com`).
///
/// Construction goes through [`GitHubHost::new`], which lowercases, trims, and
/// rejects anything that isn't a bare hostname. Using the type everywhere (vs a
/// raw `String`) prevents URL/path injection AND duplicate-key drift from casing
/// or trailing dots.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GitHubHost {
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates host for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    host: String,
}

impl GitHubHost {
    /// Canonicalize + validate a raw host string.
    ///
    /// Lowercases, trims surrounding whitespace, strips a single trailing dot.
    /// Rejects: empty, anything containing `:` (scheme or port), and any byte
    /// outside `[a-z0-9.-]` (which also rejects `/`, `@`, and userinfo).
    pub fn new(raw: &str) -> Option<Self> {
        let h = raw.trim().trim_end_matches('.').to_ascii_lowercase();
        let ok = !h.is_empty()
            && !h.contains(':')
            && h.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
        ok.then_some(Self { host: h })
    }

    /// The canonical host string.
    pub fn as_str(&self) -> &str {
        &self.host
    }

    /// Whether this is github.com (cloud) vs a GitHub Enterprise Server.
    pub fn is_cloud(&self) -> bool {
        self.host == "github.com"
    }

    /// GraphQL endpoint URL: cloud uses `api.github.com/graphql`; GHE Server uses
    /// `https://{host}/api/graphql`.
    pub fn graphql_url(&self) -> String {
        if self.is_cloud() {
            "https://api.github.com/graphql".to_string()
        } else {
            format!("https://{}/api/graphql", self.host)
        }
    }

    /// REST API base URL: cloud uses `api.github.com`; GHE Server uses
    /// `https://{host}/api/v3`.
    pub fn rest_base(&self) -> String {
        if self.is_cloud() {
            "https://api.github.com".to_string()
        } else {
            format!("https://{}/api/v3", self.host)
        }
    }
}

/// Build a REST API URL for a host + path.
///
/// `path` must start with `/` (e.g. `/repos/o/r/pulls/1/merge`). Cloud →
/// `https://api.github.com{path}`; GHE Server → `https://{host}/api/v3{path}`.
pub fn github_rest_url(host: &GitHubHost, path: &str) -> String {
    format!("{}{}", host.rest_base(), path)
}

/// Split a URL path tail into `(owner, repo)`, stripping a leading `/` and a
/// trailing `.git`. Returns `None` if either component is empty.
fn split_owner_repo(path: &str) -> Option<(String, String)> {
    let path = path.trim_start_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.splitn(3, '/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

/// Parse a git remote URL into `(host, owner, repo)` for any GitHub host.
///
/// Supports, for both github.com and GitHub Enterprise Server:
/// - scp-like SSH: `git@host:owner/repo.git`
/// - SSH URL: `ssh://git@host[:port]/owner/repo.git`
/// - HTTPS/HTTP: `https://host[:port]/owner/repo.git`
///
/// The host is canonicalized + validated via [`GitHubHost::new`]; an invalid
/// host yields `None`. This is the host-aware successor to
/// `github::parse_remote_url` (which is github.com-only and stays untouched
/// until later steps route through here).
pub fn parse_remote_url(url: &str) -> Option<(GitHubHost, String, String)> {
    let url = url.trim();

    // scp-like SSH (no scheme): user@host:owner/repo.git
    if !url.contains("://") {
        let at = url.find('@')?;
        let after_at = &url[at + 1..];
        let colon = after_at.find(':')?;
        let host = &after_at[..colon];
        let path = &after_at[colon + 1..];
        let host = GitHubHost::new(host)?;
        let (owner, repo) = split_owner_repo(path)?;
        return Some((host, owner, repo));
    }

    // URL forms: scheme://[userinfo@]host[:port]/owner/repo[.git]
    let scheme_end = url.find("://")?;
    let rest = &url[scheme_end + 3..];
    // Strip optional userinfo (`git@`).
    let rest = rest.rsplit('@').next().unwrap_or(rest);
    let (authority, path) = rest.split_once('/')?;
    // Strip optional port from the authority.
    let host = authority.split(':').next()?;
    let host = GitHubHost::new(host)?;
    let (owner, repo) = split_owner_repo(path)?;
    Some((host, owner, repo))
}

// ---------------------------------------------------------------------------
// Account model
// ---------------------------------------------------------------------------

/// Stable, persisted identifier for a GitHub account.
///
/// For v1 it equals the canonical host (one account per host), but it is stored
/// explicitly so future same-host multi-account is a data change, not a schema
/// change. The github.com default account uses [`GitHubAccount::GITHUB_COM_ID`].
pub type GitHubAccountId = String;

/// How an account authenticates. github.com mirrors the existing token-source
/// chain; GitHub Enterprise Server uses a pasted Personal Access Token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    /// github.com via OAuth Device Flow (keyring `GithubOauthToken` slot).
    #[serde(alias = "github_com_gh_cli")]
    GithubComOauth,
    /// github.com via `GH_TOKEN`/`GITHUB_TOKEN` environment variable.
    GithubComEnv,
    /// GitHub Enterprise Server via pasted Personal Access Token.
    GhePat,
}

/// A configured GitHub account: a host + how it authenticates + (once validated)
/// the resolved viewer login.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GitHubAccount {
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates id for the current owner.","operations":["get"],"confirmationClass":"ordinary"}))]
    pub id: GitHubAccountId,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates host for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub host: GitHubHost,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-not-setting" = "Resolved GitHub viewer identity; supplied by account verification."))]
    pub login: Option<String>,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates kind for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub kind: AccountKind,
}

impl GitHubAccount {
    /// Stable id of the implicit github.com default account.
    pub const GITHUB_COM_ID: &'static str = "github.com";

    /// Build the github.com default account for the given resolved auth kind.
    pub fn github_com(kind: AccountKind, login: Option<String>) -> Self {
        Self {
            id: Self::GITHUB_COM_ID.to_string(),
            host: GitHubHost::new("github.com").expect("github.com is a valid host"),
            login,
            kind,
        }
    }

    /// Build a GitHub Enterprise Server account authenticated by PAT. The id
    /// defaults to the canonical host (one account per host in v1).
    ///
    /// The id can in principle equal a `github_com_named` login id (e.g. a
    /// dotless GHE host `acme` vs login `acme`); [`add_account_record`] rejects
    /// adding an id already owned by a different host so the two can't silently
    /// clobber each other's record + vault token.
    pub fn ghe_pat(host: GitHubHost, login: Option<String>) -> Self {
        Self {
            id: host.as_str().to_string(),
            host,
            login,
            kind: AccountKind::GhePat,
        }
    }

    /// Build an ADDITIONAL github.com account (beyond the implicit ambient
    /// default). Its id is the GitHub login, captured at creation — a GitHub
    /// username can never equal the reserved [`Self::GITHUB_COM_ID`] (`.` is
    /// invalid in logins), so it never collides with the ambient default.
    ///
    /// Additional cloud accounts are persisted registry entries with their own
    /// per-account token (`Credential::GithubToken(id)`); they never use the
    /// ambient env/gh/keyring chain or the global breaker/viewer/rate state.
    pub fn github_com_named(login: &str) -> Self {
        Self {
            id: login.to_string(),
            host: GitHubHost::new("github.com").expect("github.com is a valid host"),
            login: Some(login.to_string()),
            kind: AccountKind::GithubComOauth,
        }
    }

    pub fn is_cloud(&self) -> bool {
        self.host.is_cloud()
    }

    /// Whether this is the implicit ambient github.com default — the single
    /// account that resolves its token via the env→keyring→gh chain and uses
    /// the global breaker/viewer/rate state. Every OTHER account (a GHE PAT or
    /// an additional named github.com account) is keyed by its own id and uses
    /// per-account token + per-account runtime state.
    ///
    /// This is the routing predicate that replaced `is_cloud()` at the
    /// global-vs-per-account branch points: a named github.com account IS cloud
    /// (for endpoint URLs) but is NOT the ambient default (for state/token).
    pub fn is_ambient_default(&self) -> bool {
        self.id == Self::GITHUB_COM_ID
    }
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- GitHubHost::new canonicalization + validation ---

    #[test]
    fn host_lowercases_and_trims() {
        assert_eq!(
            GitHubHost::new("  GitHub.COM  ").unwrap().as_str(),
            "github.com"
        );
    }

    #[test]
    fn host_strips_trailing_dot() {
        assert_eq!(
            GitHubHost::new("github.com.").unwrap().as_str(),
            "github.com"
        );
    }

    #[test]
    fn host_rejects_scheme() {
        assert!(GitHubHost::new("https://github.com").is_none());
    }

    #[test]
    fn host_rejects_slash_path() {
        assert!(GitHubHost::new("github.com/owner").is_none());
    }

    #[test]
    fn host_rejects_userinfo() {
        assert!(GitHubHost::new("git@github.com").is_none());
    }

    #[test]
    fn host_rejects_port() {
        assert!(GitHubHost::new("github.com:443").is_none());
    }

    #[test]
    fn host_rejects_empty() {
        assert!(GitHubHost::new("").is_none());
        assert!(GitHubHost::new("   ").is_none());
        assert!(GitHubHost::new(".").is_none());
    }

    #[test]
    fn host_accepts_ghe() {
        assert_eq!(
            GitHubHost::new("ghe.acme.com").unwrap().as_str(),
            "ghe.acme.com"
        );
    }

    // --- endpoint URLs ---

    #[test]
    fn cloud_endpoints() {
        let h = GitHubHost::new("github.com").unwrap();
        assert!(h.is_cloud());
        assert_eq!(h.graphql_url(), "https://api.github.com/graphql");
        assert_eq!(h.rest_base(), "https://api.github.com");
    }

    #[test]
    fn ghe_endpoints() {
        let h = GitHubHost::new("ghe.acme.com").unwrap();
        assert!(!h.is_cloud());
        assert_eq!(h.graphql_url(), "https://ghe.acme.com/api/graphql");
        assert_eq!(h.rest_base(), "https://ghe.acme.com/api/v3");
    }

    #[test]
    fn rest_url_cloud_vs_ghe() {
        let cloud = GitHubHost::new("github.com").unwrap();
        assert_eq!(
            github_rest_url(&cloud, "/repos/o/r/pulls/1/merge"),
            "https://api.github.com/repos/o/r/pulls/1/merge"
        );
        let ghe = GitHubHost::new("ghe.acme.com").unwrap();
        assert_eq!(
            github_rest_url(&ghe, "/repos/o/r/pulls/1/merge"),
            "https://ghe.acme.com/api/v3/repos/o/r/pulls/1/merge"
        );
    }

    // --- parse_remote_url: github.com ---

    #[test]
    fn parse_github_ssh_scp_like() {
        let (h, o, r) = parse_remote_url("git@github.com:octocat/hello.git").unwrap();
        assert_eq!(h.as_str(), "github.com");
        assert_eq!(o, "octocat");
        assert_eq!(r, "hello");
    }

    #[test]
    fn parse_github_https() {
        let (h, o, r) = parse_remote_url("https://github.com/octocat/hello.git").unwrap();
        assert_eq!(h.as_str(), "github.com");
        assert_eq!(o, "octocat");
        assert_eq!(r, "hello");
    }

    #[test]
    fn parse_github_https_no_dot_git() {
        let (h, o, r) = parse_remote_url("https://github.com/octocat/hello").unwrap();
        assert_eq!(h.as_str(), "github.com");
        assert_eq!((o.as_str(), r.as_str()), ("octocat", "hello"));
    }

    // --- parse_remote_url: GitHub Enterprise Server ---

    #[test]
    fn parse_ghe_ssh_scp_like() {
        let (h, o, r) = parse_remote_url("git@ghe.acme.com:team/project.git").unwrap();
        assert_eq!(h.as_str(), "ghe.acme.com");
        assert_eq!((o.as_str(), r.as_str()), ("team", "project"));
    }

    #[test]
    fn parse_ghe_https() {
        let (h, o, r) = parse_remote_url("https://ghe.acme.com/team/project.git").unwrap();
        assert_eq!(h.as_str(), "ghe.acme.com");
        assert_eq!((o.as_str(), r.as_str()), ("team", "project"));
    }

    #[test]
    fn parse_ssh_url_with_port() {
        let (h, o, r) = parse_remote_url("ssh://git@ghe.acme.com:22/team/project.git").unwrap();
        assert_eq!(h.as_str(), "ghe.acme.com");
        assert_eq!((o.as_str(), r.as_str()), ("team", "project"));
    }

    #[test]
    fn parse_rejects_non_owner_repo() {
        assert!(parse_remote_url("https://github.com/onlyowner").is_none());
        assert!(parse_remote_url("not a url").is_none());
    }

    // --- account model ---

    #[test]
    fn github_com_default_account() {
        let acc = GitHubAccount::github_com(AccountKind::GithubComOauth, Some("octocat".into()));
        assert_eq!(acc.id, "github.com");
        assert!(acc.is_cloud());
        assert_eq!(acc.host.as_str(), "github.com");
        assert_eq!(acc.kind, AccountKind::GithubComOauth);
    }

    #[test]
    fn ghe_pat_account_id_defaults_to_host() {
        let host = GitHubHost::new("ghe.acme.com").unwrap();
        let acc = GitHubAccount::ghe_pat(host, None);
        assert_eq!(acc.id, "ghe.acme.com");
        assert!(!acc.is_cloud());
        assert_eq!(acc.kind, AccountKind::GhePat);
    }

    #[test]
    fn account_serde_round_trip() {
        let acc = GitHubAccount::ghe_pat(
            GitHubHost::new("ghe.acme.com").unwrap(),
            Some("octocat".into()),
        );
        let json = serde_json::to_string(&acc).unwrap();
        let back: GitHubAccount = serde_json::from_str(&json).unwrap();
        assert_eq!(acc, back);
    }
}
