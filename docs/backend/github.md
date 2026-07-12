# GitHub Integration

**Modules:** `src-tauri/src/github.rs`, `src-tauri/src/github_auth.rs`, `src-tauri/src/github_account.rs`

Integrates with GitHub via GraphQL API for PR status, CI checks, and batch queries. Supports OAuth Device Flow login as an alternative to gh CLI tokens, plus **multiple accounts** (additional github.com logins and GitHub Enterprise Server) with per-repo bindings.

## Multi-Account Model (`github_account.rs`)

The integration is **account-centric**: the primary key is a stable `GitHubAccountId`, not the host. This keeps github.com behaving exactly as before behind an "ambient default" account while enabling additional accounts.

- **`GitHubHost`** — canonical (lowercased, validated) host. `is_cloud()` → github.com; `graphql_url()` / `rest_base()` return `api.github.com` (+`/graphql`) for cloud and `https://{host}/api/graphql` / `https://{host}/api/v3` for GHE. `is_ambient_default()` routes the global-vs-per-account branch points.
- **Account kinds** — `GithubComOAuth` / `GithubComEnv` / `GithubComGhCli` (the ambient default, existing auth chain), additional named github.com accounts, and `GhePat` (GitHub Enterprise Server via pasted PAT).
- **Credential storage** — github.com keeps `Credential::GithubOauthToken` (`github/oauth-token`) unchanged; per-account PATs use `Credential::GithubToken(account_id)` → `github/account/{id}/token`.
- **Repo bindings** — `{repo_path → account_id, owner, repo, remote_name}` persisted per canonical repo root (worktrees resolve to the main root). `resolve_repo_account(repo_path)` returns `RepoResolution::{Bound | NeedsBind(candidates) | NeedsAccount | Unmonitored}` — binding-first, single-candidate auto-confirm, ambiguity surfaces all candidates (never a silent `origin` pick).
- **Per-account isolation (hybrid)** — github.com keeps the global breaker/viewer/rate/cooldown fields byte-for-byte; GHE accounts get isolated `ghe_state: DashMap<AccountId, GheAccountState>`. The poller groups repos by resolved account and runs one batch per account, so a fault on one never opens another's breaker. Cooldown keys: `owner/repo` (cloud, unchanged) vs `{account_id}:owner/repo` (GHE).
- **Limitation** — `fetch_ci_failure_logs` (gh-CLI-assisted) is disabled with a clear message for non-github.com accounts; all REST + GraphQL paths route through `github_rest_url(host, path)` / account-scoped tokens (no hardcoded `api.github.com` outside `GitHubHost` + tests).

### Multi-account commands

| Command | Signature | Description |
|---------|-----------|-------------|
| `github_list_accounts` | `() -> Vec<GitHubAccount>` | Additional accounts beyond the ambient github.com default |
| `github_add_account` | `(host: String, pat: String) -> GitHubAccount` | Validate PAT against `{rest_base}/user`, store token + record (github.com rejected → device flow) |
| `github_remove_account` | `(id: String) -> ()` | Cascade-remove token + record + bindings + per-account caches |
| `github_bind_repo` | `(repo_path, account_id, remote_name) -> ()` | Persist a repo→account binding |
| `github_unbind_repo` | `(repo_path: String) -> ()` | Remove a repo binding |
| `github_list_bindings` | `() -> Vec<Binding>` | All persisted repo→account bindings |
| `github_resolve_repo` | `(repo_path: String) -> RepoResolutionDto` | `bound` / `needs-bind` / `needs-account` / `unmonitored` + candidates |

## Token Resolution

Priority order (first non-empty wins) for the ambient github.com account:

1. `GH_TOKEN` environment variable
2. `GITHUB_TOKEN` environment variable
3. OAuth keyring token (`github_auth.rs` — stored in OS keyring via `keyring` crate)
4. `gh_token` crate (reads `~/.config/gh/hosts.yml`)
5. `gh auth token` CLI subprocess

The active token source is tracked in `AppState.github_token_source` as a `TokenSource` enum (`Env`, `OAuth`, `GhCli`, `Pat`, `None`). `resolve_token_for_account(&GitHubAccount)` runs this exact chain for github.com and returns the vault PAT (`TokenSource::Pat`) for GHE accounts.

## Tauri Commands — Authentication (`github_auth.rs`)

| Command | Signature | Description |
|---------|-----------|-------------|
| `github_start_login` | `() -> DeviceCodeResponse` | Start OAuth Device Flow, returns user code |
| `github_poll_login` | `(device_code: String) -> PollResult` | Poll for token, saves to keyring on success |
| `github_logout` | `() -> ()` | Delete OAuth token from keyring, fall back to env/CLI |
| `github_auth_status` | `() -> AuthStatus` | Current auth status with login, avatar, source |
| `github_disconnect` | `() -> ()` | Disconnect GitHub — clear all tokens from keyring and env cache |
| `github_diagnostics` | `() -> Value` | Diagnostics: token sources, scopes, API connectivity |

## Tauri Commands — GitHub Data (`github.rs`)

| Command | Signature | Description |
|---------|-----------|-------------|
| `get_github_status` | `(path: String) -> GitHubStatus` | PR + CI status for current branch |
| `get_ci_checks` | `(path: String) -> Vec<Value>` | Detailed CI check list |
| `get_repo_pr_statuses` | `(path: String, include_merged: bool) -> Vec<BranchPrStatus>` | Batch PR status for all branches |
| `approve_pr` | `(repo_path: String, pr_number: i32) -> String` | Submit approving review via GitHub API |
| `get_all_pr_statuses` | `(path: String) -> Vec<BranchPrStatus>` | Batch PR status for all branches (includes merged) |
| `get_pr_diff` | `(repo_path: String, pr_number: i32) -> String` | Get PR diff content |
| `merge_pr_via_github` | `(repo_path: String, pr_number: i32, merge_method: String) -> String` | Merge PR via GitHub API |
| `fetch_ci_failure_logs` | `(repo_path: String, run_id: i64) -> String` | Fetch failure logs from a GitHub Actions run for CI auto-heal |
| `check_github_circuit` | `(path: String) -> CircuitState` | Check GitHub API circuit breaker state |

## Data Types

### GitHubStatus

```rust
struct GitHubStatus {
    has_remote: bool,
    current_branch: String,
    pr_status: Option<PrStatus>,
    ci_status: Option<CiStatus>,
    ahead: i32,
    behind: i32,
}
```

### PrStatus

```rust
struct PrStatus {
    number: i32,
    title: String,
    state: String,    // "OPEN", "CLOSED", "MERGED"
    url: String,
}
```

### BranchPrStatus (Batch Endpoint)

Full PR data for a single branch, returned by `get_repo_pr_statuses`:

```rust
struct BranchPrStatus {
    branch: String,
    number: i32,
    title: String,
    state: String,
    url: String,
    additions: i32,
    deletions: i32,
    checks: CheckSummary,        // passed/failed/pending/total
    check_details: Vec<CheckDetail>,
    author: String,
    commits: i32,
    mergeable: String,           // "MERGEABLE", "CONFLICTING", "UNKNOWN"
    merge_state_status: String,  // "CLEAN", "DIRTY", "BEHIND", etc.
    review_decision: String,     // "APPROVED", "CHANGES_REQUESTED", etc.
    labels: Vec<PrLabel>,        // Labels with pre-computed colors
    is_draft: bool,
    base_ref_name: String,
    created_at: String,
    updated_at: String,
    merge_state_label: Option<StateLabel>,   // Pre-classified display label
    review_state_label: Option<StateLabel>,  // Pre-classified display label
}
```

### PrLabel

```rust
struct PrLabel {
    name: String,
    color: String,            // Hex color from GitHub
    text_color: String,       // Computed: black or white based on luminance
    background_color: String, // Computed: hex_to_rgba with alpha
}
```

### CheckSummary

```rust
struct CheckSummary {
    passed: u32,
    failed: u32,
    pending: u32,
    total: u32,
}
```

### StateLabel

```rust
struct StateLabel {
    label: String,     // Human-readable text (e.g., "Approved", "Behind")
    css_class: String, // CSS class for styling
}
```

## Utility Functions

### `parse_pr_list_json(json_str: &str) -> Vec<BranchPrStatus>`

Parses the JSON output from `gh pr list --json ...` and enriches with computed fields (merge state classification, review state classification, label colors).

### `classify_merge_state(mergeable, merge_state_status) -> Option<StateLabel>`

Maps GitHub merge state to display labels:

| mergeable | merge_state_status | Label | CSS Class |
|-----------|-------------------|-------|-----------|
| MERGEABLE | CLEAN | Ready to merge | merge-ready |
| MERGEABLE | UNSTABLE | Checks failing | merge-unstable |
| CONFLICTING | * | Has conflicts | merge-conflict |
| * | BEHIND | Behind base | merge-behind |
| * | BLOCKED | Blocked | merge-blocked |
| * | DRAFT | Draft | merge-draft |

### `classify_review_state(review_decision) -> Option<StateLabel>`

| review_decision | Label | CSS Class |
|-----------------|-------|-----------|
| APPROVED | Approved | review-approved |
| CHANGES_REQUESTED | Changes requested | review-changes |
| REVIEW_REQUIRED | Review required | review-required |

### `hex_to_rgba(hex: &str, alpha: f64) -> String`

Converts hex color (e.g., "#ff0000") to rgba string (e.g., "rgba(255, 0, 0, 0.5)").

### `is_light_color(hex: &str) -> bool`

Calculates relative luminance using the sRGB formula to determine if a color is light (for choosing black vs white text).

## Tauri Commands — Issues

| Command | Signature | Description |
|---------|-----------|-------------|
| `poll_issues` | `(repos: Vec<(String, String, String)>, login: String, filter: String) -> Vec<RepoIssues>` | Fetch issues for multiple repos using GitHub Search API |
| `close_issue` | `(repo_path: String, issue_number: i32) -> String` | Close an issue via GitHub GraphQL mutation |
| `reopen_issue` | `(repo_path: String, issue_number: i32) -> String` | Reopen a closed issue via GitHub GraphQL mutation |

### GitHubIssue

```rust
struct GitHubIssue {
    number: i32,
    title: String,
    state: String,           // "OPEN", "CLOSED"
    url: String,
    created_at: String,
    updated_at: String,
    author: String,
    labels: Vec<PrLabel>,    // Reuses PrLabel with computed colors
    assignees: Vec<String>,
    milestone: Option<String>,
    comments_count: u32,
}
```

### Issue Filter Modes

The `filter` parameter in `poll_issues` controls which issues are fetched:

| Filter | GitHub Search Qualifier | Description |
|--------|------------------------|-------------|
| `assigned` | `assignee:{login}` | Issues assigned to the authenticated user (default) |
| `created` | `author:{login}` | Issues created by the authenticated user |
| `mentioned` | `mentions:{login}` | Issues mentioning the authenticated user |
| `all` | *(no user qualifier)* | All open issues in the repo |
| `disabled` | *(no query)* | Issue fetching disabled |

### Issue Query Construction

`build_multi_repo_issues_query` constructs a GitHub Search API query per repo:
- Format: `repo:{owner}/{name} is:issue is:open {user_qualifier}`
- Results parsed via `parse_issue_node` which extracts labels with `hex_to_rgba` color computation (same opacity constant `LABEL_BG_OPACITY = 0.7` as PRs)

## GraphQL Batching

`get_repo_pr_statuses` uses `gh pr list` with extensive `--json` fields to fetch all open PRs in a single call. This is efficient: 1 API call returns all branches with PR data.

**Polling budget:** ~2 calls/min/repo = 1,200/hr for 10 repos, well within GitHub's 5,000/hr rate limit.

## PR Approval & Merge

### `approve_pr`

Submits an approving review on a pull request via `gh api`. Used by the remote-only PR popover.

### CI Auto-Heal (`fetch_ci_failure_logs`)

Fetches the latest failure logs from a GitHub Actions run. Used by the CI auto-heal hook (`useCiHeal`) to inject failure context into agent terminals for automatic fix cycles (up to 3 attempts per cycle).

## Stale PR Filtering

When `include_merged` is true, `get_repo_pr_statuses` includes recently merged PRs. Stale merged PRs are filtered: if a branch has been recreated after a PR was merged (detected via branch creation timestamp vs PR merge timestamp), the old merged PR is excluded to prevent ghost badges.
