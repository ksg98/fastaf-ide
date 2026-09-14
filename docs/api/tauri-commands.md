# Tauri Commands Reference

All commands are invoked from the frontend via `invoke(command, args)`. In browser mode, these map to HTTP endpoints (see [HTTP API](http-api.md)).

## PTY Session Management (`pty.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `create_pty` | `config: PtyConfig` | `String` (session ID) | Create PTY session |
| `create_pty_with_worktree` | `pty_config, worktree_config` | `WorktreeResult` | Create worktree + PTY |
| `write_pty` | `session_id, data` | `()` | Write to PTY |
| `write_pty_parts` | `session_id, parts: Vec<String>` | `()` | Write several inputs under one writer lock. The parts stay separate on purpose: post-write bookkeeping runs once per part, and it is not a function of the joined bytes (a lone `/` opens slash mode, an exact option key answers a choice prompt) |
| `enqueue_agent_command` | `session_id, text` | `{ typed, queued }` | Queue a command for the agent's next idle window (typed at once when already idle); errors for non-agent sessions |
| `clear_queued_agent_commands` | `session_id` | `usize` | Drop every queued command; returns how many |
| `list_queued_agent_commands` | `session_id` | `[{ id, text }]` | The queued user commands in delivery order; peer messages excluded |
| `remove_queued_agent_command` | `session_id, command_id` | `bool` | Drop one queued command by id; false when it already drained |
| `resize_pty` | `session_id, rows, cols` | `()` | Resize PTY; alternate-screen resizes preserve primary-log continuity |
| `pause_pty` | `session_id` | `()` | Pause reader thread |
| `resume_pty` | `session_id` | `()` | Resume reader thread |
| `close_pty` | `session_id, cleanup_worktree` | `()` | Close PTY session |
| `can_spawn_session` | -- | `bool` | Check session limit |
| `get_orchestrator_stats` | -- | `OrchestratorStats` | Active/max/available |
| `get_session_metrics` | -- | `JSON` | Spawn/fail/byte counts |
| `list_active_sessions` | -- | `Vec<ActiveSessionInfo>` | List all sessions with `display_name_is_custom`, `is_remote`, and the same optional lifecycle `state` (`shell_state`, `agent_state`, `background_work`, `queued_commands`) returned by `GET /sessions` |
| `list_worktrees` | -- | `Vec<JSON>` | List managed worktrees |
| `get_session_foreground_process` | `session_id` | `JSON` | Get foreground process info |
| `get_kitty_flags` | `session_id` | `u32` | Get Kitty keyboard protocol flags for session |
| `get_last_prompt` | `session_id` | `Option<String>` | Get last user-typed prompt from input line buffer |
| `get_shell_state` | `session_id` | `Option<String>` | Get current shell state ("busy", "idle", or null); agent-specific semantic Working markers can repair a transient false-idle state |
| `has_foreground_process` | `session_id: String` | `bool` | Checks if a non-shell foreground process is running |
| `debug_agent_detection` | `session_id: String` | `AgentDiagnostics` | Returns diagnostic breakdown of agent detection pipeline |
| `get_pty_capture` | -- | `JSON` | Raw PTY capture tap state: enabled, session filter, directory, bytes per session. Browser parity: `GET /diagnostics/capture`. |
| `set_pty_capture` | `enabled: bool, session_id: Option<String>` | `JSON` | Start/stop recording raw PTY bytes to `<config dir>/captures/<id>.tcap`; starting begins a fresh file. Surfaced as **Capture Session** in the tab context menu under `isPerfDebug()`. Browser parity: `POST /diagnostics/capture`. |
| `set_session_name` | `session_id, name, is_custom?` | `()` | Set a session display name and whether it represents an explicit user rename |
| `get_input_buffer_content` | `session_id` | `String` | Get the current content of the input line buffer (what the user is typing). Used by plugins with `pty:read` capability. |
| `terminal_get_selection_text` | `session_id, start_row, start_col, end_row, end_col` | `Result<String, String>` | Read a scrollback-aware selection, join soft-wrapped rows, and remove coherent Claude visual gutter runs. Browser parity: `GET /sessions/:id/terminal/selection-text`. |
| `get_process_stats` | -- | `Vec<ProcessStat>` | CPU% and RSS memory for TUIC and all child process trees |
| `subscribe_terminal_grid` | `session_id, channel: Channel<Response>` | `u64` (epoch) | Register the grid-frame channel and install a fresh delivery gate (counting from zero). Returns the subscription epoch the client must carry on `ack_terminal_frame` and `unsubscribe_terminal_grid`. Frames are **raw bytes**, not JSON. Browser parity: `WS /sessions/:id/stream?format=grid` |
| `ack_terminal_frame` | `session_id, epoch: u64, received: u64` | `()` | Report the total number of frames this client has received. The gate opens when the echo catches up with what was sent, which is what tells a fresh ack from a late one for an abandoned frame. An ack whose epoch is not the live subscription's is dropped. Browser parity: none — the WS path uses sequence numbers instead |
| `unsubscribe_terminal_grid` | `session_id, epoch: u64` | `()` | Tear down the grid channel, gate and pending scroll. A non-matching epoch is ignored: a remount subscribes before the outgoing instance unsubscribes, and honouring the stale call would blank a mounted terminal. Browser parity: closing the WS |
| `terminal_styled_rows` | `session_id, start, count` | `Result<Response, String>` (packed bytes) | A range of styled rows by absolute index, filling the client-side scroll cache. Raw bytes for the same reason as grid frames. Browser parity: `GET /sessions/:id/terminal/styled-rows` (`application/octet-stream`) |

Every terminal grid **read** — the two rows above plus `terminal_get_block_rows`,
`terminal_scroll_info`, `terminal_search`, `terminal_search_buffer`,
`terminal_get_row_text`, `terminal_get_logical_line`, `terminal_get_lines`,
`terminal_get_cursor_line`, `terminal_hyperlink_at` and
`terminal_hyperlink_span` and `read_vt_log` — is an `async fn` that runs on the blocking pool via
`pty::vt_try_read`, so it returns `Result<T, String>` rather than a bare `T`.
The `Err` arm means the pool task itself failed; a session that is gone is still
the old default (or a 404 over HTTP). See
[`docs/backend/command-threading.md`](../backend/command-threading.md).

MCP `session action=submit` deliberately has no new Tauri command. It is a
request-scoped orchestration contract in `mcp_transport.rs`: it reuses the PTY
injection claim, writer, input FSM, and output ring, then keeps the MCP response
open for a bounded terminal-movement receipt. Desktop `write_pty` and
`write_pty_parts` remain raw input primitives and make no acknowledgement claim.

## Generators (`generators.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `generate_value` | `generator_id, options` | `GeneratedValue` | Generate a secure random value (password, uuid_v4, uuid_v7, ulid, cuid2, jwt_secret, totp_secret, nano_id, slug, ed25519_keypair) |

## Git Operations (`git.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `get_repo_info` | `path` | `RepoInfo` | Repo name, branch, status |
| `get_git_diff` | `path` | `String` | Full git diff |
| `get_diff_stats` | `path` | `DiffStats` | Addition/deletion counts |
| `get_changed_files` | `path` | `Vec<ChangedFile>` | Changed files with stats |
| `get_file_diff` | `path, file` | `String` | Single file diff |
| `get_gutter_changes` | `path, file, scope?` | `Vec<GutterChange>` | Per-line editor gutter/scrollbar change markers (diff parsed in Rust) |
| `get_git_branches` | `path` | `Vec<JSON>` | All branches (sorted) |
| `get_recent_commits` | `path` | `Vec<JSON>` | Recent git commits |
| `rename_branch` | `path, old_name, new_name` | `()` | Rename branch |
| `check_is_main_branch` | `branch` | `bool` | Is main/master/develop |
| `get_initials` | `name` | `String` | 2-char repo initials |
| `get_merged_branches` | `repo_path` | `Vec<String>` | Branches merged into default branch |
| `get_repo_summary` | `repo_path` | `RepoSummary` | Aggregate snapshot: worktree paths + merged branches + per-path diff stats in one IPC |
| `get_repo_structure` | `repo_path` | `RepoStructure` | Fast phase: worktree paths + merged branches only (Phase 1 of progressive loading) |
| `get_repo_diff_stats` | `repo_path` | `RepoDiffStats` | Slow phase: per-worktree diff stats + last commit timestamps (Phase 2 of progressive loading) |
| `run_git_command` | `path, args` | `GitCommandResult` | Run arbitrary git command (success, stdout, stderr, exit_code) |
| `get_git_panel_context` | `path` | `GitPanelContext` | Rich context for Git Panel (branch, ahead/behind, staged/changed/stash counts, last commit, rebase/cherry-pick state). Cached 5s TTL. |
| `get_working_tree_status` | `path` | `WorkingTreeStatus` | Full porcelain v2 status: branch, upstream, ahead/behind, stash count, staged/unstaged entries, untracked files |
| `update_from_base` | `path, branch_name, strategy?` | `String` | Fetch configured base ref and rebase or merge the branch onto it. Conflict cleanup reports `(aborted)` only after abort succeeds; abort failure includes manual recovery guidance. |
| `git_stage_files` | `path, files` | `()` | Stage files (`git add`). Path-traversal validated |
| `git_unstage_files` | `path, files` | `()` | Unstage files (`git restore --staged`). Path-traversal validated |
| `git_discard_files` | `path, files` | `()` | Discard working tree changes (`git restore`). Destructive. Path-traversal validated |
| `git_commit` | `path, message, amend?` | `String` (commit hash) | Commit staged changes; optional `--amend`. Returns new HEAD hash |
| `get_commit_log` | `path, count?, after?` | `Vec<CommitLogEntry>` | Paginated commit log (default 50, max 500). `after` is a commit hash for cursor-based pagination |
| `get_stash_list` | `path` | `Vec<StashEntry>` | List stash entries (index, ref_name, message, hash) |
| `git_stash_apply` | `path, index` | `()` | Apply stash entry by index |
| `git_stash_pop` | `path, index` | `()` | Pop stash entry by index |
| `git_stash_drop` | `path, index` | `()` | Drop stash entry by index |
| `git_stash_show` | `path, index` | `String` | Show diff of stash entry |
| `git_apply_reverse_patch` | `path, patch, scope?` | `()` | Apply a unified diff patch in reverse (`git apply --reverse`). Used for hunk/line restore. `scope="staged"` adds `--cached`. Patch passed via stdin (no temp files). Path-traversal validated |
| `get_file_history` | `path, file, count?, after?` | `Vec<CommitLogEntry>` | Per-file commit log following renames (default 50, max 500) |
| `get_file_blame` | `path, file` | `Vec<BlameLine>` | Per-line blame: hash, author, author_time (unix), line_number, content |
| `get_branches_detail` | `path` | `Vec<BranchDetail>` | Rich branch listing: name, ahead/behind, last commit date, tracking upstream, merged status |
| `delete_branch` | `path, name, force` | `()` | Delete a local branch. `force=false` uses safe `-d`; `force=true` uses `-D`. Refuses to delete the current branch or default branch |
| `create_branch` | `path, name, start_point, checkout` | `()` | Create a new branch from `start_point` (defaults to HEAD). `checkout=true` switches to it immediately |
| `get_recent_branches` | `path, limit` | `Vec<String>` | Recently checked-out branches from reflog, ordered by recency |

## Commit Graph (`git_graph.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `get_commit_graph` | `path, count?` | `Vec<GraphNode>` | Lane-assigned commit graph for visual rendering. Default 200, max 1000. Returns hash, column, row, color_index (0–7), parents, refs, and connection metadata (from/to col/row) for Bezier curve drawing |

## GitHub Authentication (`github_auth.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `github_start_login` | — | `DeviceCodeResponse` | Start OAuth Device Flow, returns user/device code |
| `github_poll_login` | `device_code` | `PollResult` | Poll for token; saves to keyring on success |
| `github_logout` | — | `()` | Delete OAuth token from keyring, fall back to env/CLI |
| `github_auth_status` | — | `AuthStatus` | Current auth: login, avatar, source, scopes |
| `github_disconnect` | — | `()` | Disconnect GitHub (clear all tokens from keyring and env cache) |
| `github_diagnostics` | — | `JSON` | Diagnostics: token sources, scopes, API connectivity |

## GitHub Integration (`github.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `get_github_status` | `path` | `GitHubStatus` | PR + CI for current branch |
| `get_ci_checks` | `path` | `Vec<JSON>` | CI check details |
| `get_repo_pr_statuses` | `path, include_merged` | `Vec<BranchPrStatus>` | Batch PR status (all branches) |
| `approve_pr` | `repo_path, pr_number` | `String` | Submit approving review via GitHub API |
| `merge_pr_via_github` | `repo_path, pr_number, merge_method` | `String` | Merge PR via GitHub API |
| `get_all_pr_statuses` | `path` | `Vec<BranchPrStatus>` | Batch PR status for all branches (includes merged) |
| `get_pr_diff` | `repo_path, pr_number` | `String` | Get PR diff content |
| `run_pr_review` | `repo_path, pr_number` | `PrReviewResult` | AI review of a PR diff (multi-turn engine, Main slot) → line-level findings |
| `get_merged_prs` | `repo_path, since_tag?` | `Vec<MergedPr>` | Merged PRs via GraphQL, optionally since a tag's date (AI changelog source) |
| `generate_changelog` | `repo_path, since_tag?` | `{markdown, json}` | AI changelog from merged PRs (headless slot, one-shot) |
| `start_conflict_assist` | `repo_path, pr_number` | `ConflictAssistResult` | Worktree on PR head + rebase onto base; reports verified/unverified clean or conflicts, base provenance/warning, and agent prompt (push gated, never auto-merge) |
| `run_improvement_scan` | `repo_path, focus` | `ImprovementScanResult` | One-shot Headless-slot scan of local repo context for improvement proposals (`focus`: `refactor`, `testing`, `perf`); emits `proposals-ready` |
| `create_issue_from_proposal` | `repo_path, proposal` | `CreatedIssue` | Human-gated issue creation from an improvement proposal |
| `fetch_ci_failure_logs` | `repo_path, branch` | `String` | Fetch failed-job logs for the branch's latest GitHub Actions head, including partially completed workflow runs |
| `check_github_circuit` | `path` | `CircuitState` | Check GitHub API circuit breaker state |

## Worktree Management (`worktree.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `create_worktree` | `base_repo, branch_name` | `JSON` | Create git worktree |
| `remove_worktree` | `repo_path, branch_name, delete_branch?, force?` | `{ branch_delete_warning?: string }` | Remove worktree; `delete_branch` (default true) controls whether the local branch is also deleted. If safe branch deletion fails after the worktree is removed, returns `branch_delete_warning` so the UI can report that the branch was kept. Archive script resolved from config (not IPC). |
| `delete_local_branch` | `repo_path, branch_name` | `()` | Delete a local branch (and its worktree if linked). Refuses to delete the default branch. Uses safe `git branch -d` |
| `check_worktree_dirty` | `repo_path, branch_name` | `bool` | Check if a branch's worktree has uncommitted changes. Returns false if no worktree exists. When git cannot answer (the `worktree list` or `status` call fails) it returns an **error**, never `false` — callers that gate a destructive action must see the failure |
| `get_worktree_paths` | `repo_path` | `HashMap<String,String>` | Worktree paths for repo |
| `get_worktrees_dir` | -- | `String` | Worktrees base directory |
| `generate_worktree_name_cmd` | `existing_names` | `String` | Generate unique name |
| `list_local_branches` | `path` | `Vec<String>` | List local branches |
| `checkout_remote_branch` | `repo_path, branch_name` | `()` | Check out a remote-only branch as a new local tracking branch |
| `detect_orphan_worktrees` | `repo_path` | `Vec<String>` | Detect worktrees in detached HEAD state (branch deleted) |
| `remove_orphan_worktree` | `repo_path, worktree_path` | `()` | Remove an orphan worktree by filesystem path (validated against repo) |
| `switch_branch` | `repo_path, branch_name` | `()` | Switch main worktree to a different branch (with dirty-state and process checks) |
| `merge_and_archive_worktree` | `repo_path, branch_name, target_branch, after_merge, force?` | `MergeArchiveResult` | Merge worktree branch into base and archive. A pre-flight counts the commits the target is missing and checks whether the worktree is dirty; both are returned so the caller can say what the merge actually carried. When `after_merge` is `archive` or `delete` and the worktree is **not known to be clean**, it returns `action: "needs_confirmation"` without touching anything — re-call with `force: true` to proceed. The commit count does not enter that decision: both cleanups end in `git worktree remove --force`, which destroys uncommitted work whether or not the branch carries commits. A dirty check that fails also blocks (`worktree_dirty` stays `false` because git never said "dirty"). If conflict cleanup abort fails, the error reports the repo may still be conflicted and includes the manual abort command. |
| `finalize_merged_worktree` | `repo_path, branch_name, action, force?` | `MergeArchiveResult` | Clean up a merged worktree. Passes the **same** dirty-worktree gate as `merge_and_archive_worktree`: without `force` a worktree that is not known to be clean comes back as `action: "needs_confirmation"` instead of being wiped (`merged: true` — only the cleanup stopped, the merge already landed). Delete action may include `branch_delete_warning` if the worktree was removed but safe branch deletion kept the branch. |
| `list_base_ref_options` | `repo_path` | `Vec<String>` | List valid base refs for worktree creation |
| `run_setup_script` | `repo_path, worktree_path` | `()` | Run post-creation setup script in new worktree |
| `generate_clone_branch_name_cmd` | `base_name, existing_names` | `String` | Generate hybrid branch name for clone worktree |

## Configuration (`config.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `load_app_config` | -- | `AppConfig` | Load app settings |
| `save_app_config` | `config` | `()` | Save app settings |
| `load_notification_config` | -- | `NotificationConfig` | Load notifications |
| `save_notification_config` | `config` | `()` | Save notifications |
| `load_ui_prefs` | -- | `UIPrefsConfig` | Load UI preferences |
| `save_ui_prefs` | `config` | `()` | Save UI preferences |
| `load_repo_settings` | -- | `RepoSettingsMap` | Load per-repo settings |
| `save_repo_settings` | `config` | `()` | Save per-repo settings |
| `check_has_custom_settings` | `path` | `bool` | Has non-default settings |
| `load_repo_defaults` | -- | `RepoDefaultsConfig` | Load repo defaults |
| `save_repo_defaults` | `config` | `()` | Save repo defaults |
| `load_repositories` | -- | `JSON` | Load saved repositories |
| `save_repositories` | `config` (`mutationVersion: 1` keyed delta) | `()` | Apply repository/group/order/active-selection changes to the latest locked document; same-record conflicts are returned to the caller |
| `load_prompt_library` | -- | `PromptLibraryConfig` | Load prompts |
| `save_prompt_library` | `config` | `()` | Save prompts |
| `load_notes` | -- | `JSON` | Load notes |
| `save_notes` | `config` | `()` | Save notes |
| `save_note_image` | `note_id, data_base64, extension` | `String` (absolute path) | Decode base64 image, validate ≤10 MB, write to `config_dir()/note-images/<note_id>/<timestamp>.<ext>` |
| `delete_note_assets` | `note_id` | `()` | Remove `note-images/<note_id>/` directory recursively (no-op if missing) |
| `get_note_images_dir` | -- | `String` | Return `config_dir()/note-images/` absolute path |
| `load_keybindings` | -- | `JSON` | Load keybinding overrides |
| `save_keybindings` | `config` | `()` | Save keybinding overrides |
| `load_agents_config` | -- | `AgentsConfig` | Load per-agent run configs |
| `save_agents_config` | `config` | `()` | Save per-agent run configs |
| `load_activity` | -- | `ActivityConfig` | Load activity dashboard state |
| `save_activity` | `config` | `()` | Save activity dashboard state |
| `load_repo_local_config` | `repo_path` | `RepoLocalConfig?` | Read `.tuic.json` from repo root; returns null if absent or malformed |
| `save_repo_local_config` | `repo_path` | `()` | Write the repo's **effective resolved** worktree/branch settings (global defaults + per-repo overrides) to `.tuic.json` at its root (committable, team-shareable). Preserves fields already in the file (e.g. `mcp_upstreams`); never writes script fields |

## SSH Tunnels (`tunnels/tauri_commands.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `list_tunnel_profiles` | -- | `Vec<TunnelProfile>` | Load all tunnel profiles (global + per-repo merged) |
| `save_tunnel_profile` | `profile: JSON` | `String` (profile ID) | Create or update a tunnel profile. Auto-generates UUID if `id` is empty. Validates before saving |
| `delete_tunnel_profile` | `id` | `bool` | Delete a tunnel profile by ID. Stops the tunnel if running |
| `start_tunnel` | `id` | `String` | Start a tunnel by profile ID. Loads the profile, validates, and spawns the SSH process |
| `stop_tunnel` | `id` | `()` | Stop a running tunnel by profile ID |
| `list_active_tunnels` | -- | `Vec<JSON>` | List all active tunnels with ID, status, and started_at |
| `get_tunnel_status` | `id` | `JSON` | Get the current status of a specific tunnel (starting, connected, reconnecting, stopped, error) |
| `list_ssh_config_hosts` | -- | `Vec<String>` | Parse `~/.ssh/config` and return all non-negated, non-wildcard Host entries |
| `get_tunnel_audit` | `id, limit?` | `Vec<JSON>` | Query audit log events for a tunnel (default limit 20). Returns timestamp, kind, and extracted message |
| `list_ssh_agent_keys` | -- | `SshAgentInfo` | Detect SSH agent type (1Password, Secretive, GPG, generic) and list loaded keys via `ssh-add -l` |

## Agent Detection (`agent.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `detect_agent_binary` | `binary` | `AgentBinaryDetection` | Check binary in PATH |
| `detect_all_agent_binaries` | -- | `Vec<AgentBinaryDetection>` | Detect all known agents |
| `detect_claude_binary` | -- | `String` | Detect Claude binary |
| `detect_installed_ides` | -- | `Vec<String>` | Detect installed IDEs |
| `open_in_app` | `path, app` | `()` | Open path in application |
| `spawn_agent` | `pty_config, agent_config` | `String` (session ID) | Spawn agent in PTY |

## Agent Session Discovery (`agent_session.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `discover_agent_session` | `session_id, agent_type, cwd` | `Option<String>` | Discover agent session UUID from filesystem for session-aware resume |
| `verify_agent_session` | `agent_type, session_id, cwd` | `bool` | Verify if a specific agent session file exists on disk (for TUIC_SESSION resume) |

## AI Chat (`ai_chat.rs`)

Conversational AI companion with terminal context injection. See [`docs/user-guide/ai-chat.md`](../user-guide/ai-chat.md) for the feature overview.

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `load_ai_chat_config` | -- | `AiChatConfig` | Load provider / model / base URL / temperature / `context_lines` from `ai-chat-config.json` |
| `save_ai_chat_config` | `config` | `()` | Persist chat config |
| `has_ai_chat_api_key` | -- | `bool` | Whether an API key is stored in the OS keyring for the current provider |
| `save_ai_chat_api_key` | `key: String` | `()` | Store API key in OS keyring (service `tuicommander-ai-chat`, user `api-key`) |
| `delete_ai_chat_api_key` | -- | `()` | Remove stored API key |
| `check_ollama_status` | -- | `OllamaStatus` | Probe `GET /api/tags` on the configured base URL (default `http://localhost:11434/v1/`); returns reachable + model list |
| `test_ai_chat_connection` | -- | `String` | Validate API key + base URL with a minimal completion request |
| `list_conversations` | -- | `Vec<ConversationMeta>` | List persisted conversations (id, title, updated_at, message count) |
| `load_conversation` | `id: String` | `Conversation` | Load a saved conversation body |
| `save_conversation` | `conversation: Conversation` | `()` | Persist a conversation to `ai-chat-conversations/<id>.json` |
| `delete_conversation` | `id: String` | `()` | Remove a saved conversation (idempotent) |
| `new_conversation_id` | -- | `String` | Mint a fresh conversation UUID |
| `stream_ai_chat` | `session_id, messages, chat_id, on_event: Channel<ChatStreamEvent>` | `()` | Stream a turn. Events: `chunk { text }`, `end`, `error { message }`, `tool_call` / `tool_result` (agent mode). Context assembly pulls `VtLogBuffer` (capped at `context_lines`), `SessionState`, recent `ParsedEvent`s, git context |
| `cancel_ai_chat` | `chat_id: String` | `()` | Cancel an in-flight stream (idempotent) |

### Chat Registry (`ai_chat_registry.rs`)

Cross-window state synchronization for the AI Chat panel, **as designed — not as it runs.** Nothing calls `fan_out` or any `ConversationState` setter, so the registry holds the empty default for every chat and no event is ever published. The frontend consumer was removed in story `600-d664`. Every command below still works; they just have no producer behind them, and the AI Chat panel is not a client of any of them. Wire a producer before treating this as a source of truth.

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `chat_subscribe` | `chat_id, on_event: Channel<ChatEvent>` | `{ subscriptionId, snapshot }` | Subscribe to a chat's state changes. Returns current snapshot + subscription ID. Events: `snapshot`, `chunk { delta }`, `error { message }`, `cleared`. **No frontend caller**: `ChatRegistry` has no producer, so the snapshot is always the empty default and no event ever follows. The AI chat panel stopped subscribing — applying that snapshot wiped the history it had just loaded. Wire a producer before using this. |
| `chat_unsubscribe` | `chat_id, subscription_id` | `()` | Remove a subscriber (normal cleanup path) |
| `chat_get_state` | `chat_id` | `ConversationStateSnapshot` | Read-only snapshot of a chat's current state |
| `chat_push_message` | `chat_id, role, content` | `()` | Push a message to the registry and fan-out to subscribers |
| `chat_clear` | `chat_id` | `()` | Clear conversation state and notify subscribers |
| `chat_set_pinned` | `chat_id, pinned` | `()` | Set the pinned flag on a chat |
| `chat_attach_terminal` | `chat_id, terminal_id` | `()` | Attach a terminal session to a chat |
| `chat_detach_terminal` | `chat_id` | `()` | Detach the terminal from a chat |
| `open_panel_window` | `panel_id, title?, params?, width?, height?` | `()` | Open (or focus) a detached panel window. `panel_id` becomes the window label prefix (`panel-{id}`). URL: `/?mode=panel&panel={id}&{params}`. Emits `panel-window-closed { panelId }` on destroy |
| `close_panel_window` | `panel_id` | `()` | Close a detached panel window by ID |
| `focus_main_window` | — | `()` | Bring the main window to foreground (used by detached panels after cross-window actions) |

## AI Agent Loop (`ai_agent/commands.rs`)

ReAct-style agent loop driving a terminal session with `ai_terminal_*` tools,
plus a Tauri-side query for the per-session knowledge store.

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `start_agent_loop` | `session_id, goal, unrestricted?: bool` | `String` (status message) | Start a ReAct loop on the given terminal session with the given goal. When `unrestricted=true`, sets `TrustLevel::Unrestricted` — bypasses sandbox and approval prompts. Errors if an agent is already active for the session. |
| `cancel_agent_loop` | `session_id` | `String` | Cancel the active agent loop. Errors if no loop is active. |
| `pause_agent_loop` | `session_id` | `String` | Pause the active agent loop between iterations. |
| `resume_agent_loop` | `session_id` | `String` | Resume a paused agent loop. |
| `agent_loop_status` | `session_id` | `{ active: bool, state: AgentState?, session_id }` | Query whether an agent is active and its current state (`running`/`paused`/`pending_approval`). |
| `approve_agent_action` | `session_id, approved` | `String` | Approve or reject the pending destructive command the agent wants to run. Errors if no agent is active. |
| `get_session_knowledge` | `session_id` | `SessionKnowledgeSummary` | Lightweight summary for the `SessionKnowledgeBar` UI: commands count, last 5 outcomes with kind badges, recent errors with `error_type`, TUI mode indicator, TUI apps seen. Returns an empty summary when the session has no recorded knowledge yet. |
| `list_knowledge_sessions` | `filter?: { text?, hasErrors?, since? }, limit?` | `SessionListEntry[]` | Scan persisted `ai-sessions/` and list sessions sorted by most recent activity. Filter by text (matches command/output/intent/error_type), errors-only, or UNIX-seconds `since` lower bound. `limit` clamps at 500 (default 100). |
| `get_knowledge_session_detail` | `session_id` | `SessionDetail?` | Full command history for one session — reads the in-memory store when active, falls back to disk otherwise. `HistoryCommand` rows include pre-extracted `kind`/`error_type` and the opt-in `semantic_intent`. |
| `load_scheduler_config` | -- | `SchedulerConfig` | Load cron scheduler config from `ai-cron.json`. Returns `{ jobs: ScheduledJob[] }` where each job has `id`, `cron_expr`, `goal`. |
| `save_scheduler_config` | `config: SchedulerConfig` | `()` | Validate cron expressions and persist scheduler config. Errors if any expression is invalid. |

### Agent Tools (`ai_agent/tools.rs`)

13 tools available to the ReAct agent loop and exposed via MCP as `ai_terminal_*`:

**Terminal tools** (require `session_id`):

| Tool | Args | Description |
|------|------|-------------|
| `read_screen` | `session_id, lines?` | Read visible terminal text (default 50 lines). Secrets redacted. |
| `send_input` | `session_id, command` | Send a text command to the PTY (Ctrl-U prefix + \\r). |
| `send_key` | `session_id, key` | Send a special key (enter, tab, ctrl+c, escape, arrows). |
| `wait_for` | `session_id, pattern?, timeout_ms?, stability_ms?` | Wait for regex match or screen stability. |
| `get_state` | `session_id` | Structured session metadata (shell_state, cwd, terminal_mode). |
| `get_context` | `session_id` | Cheap orientation: `{shell_state, cwd, git_branch, last_exit_code, agent_type}`. Branch from `.git/HEAD` (no subprocess). |

**Filesystem tools** (sandboxed per session via `FileSandbox`):

| Tool | Args | Description |
|------|------|-------------|
| `read_file` | `file_path, offset?, limit?` | Paginated file read (default 200, max 2000 lines). Binary/10MB rejected. Secrets redacted. |
| `write_file` | `file_path, content` | Atomic create/overwrite (tmp+rename). Sensitive paths flagged. |
| `edit_file` | `file_path, old_string, new_string, replace_all?` | Search-and-replace. Must be unique unless replace_all=true. |
| `list_files` | `pattern, path?` | Glob match (e.g. `src/**/*.rs`). Max 500 entries. |
| `search_files` | `pattern, path?, glob?, context_lines?` | Regex search, .gitignore-aware. Max 50 matches with context. |
| `search_code` | `query, path?, limit?` | BM25 semantic search over repo files via `AppState::content_index`. Returns ranked file paths with relevance scores. |
| `run_command` | `command, timeout_ms?, cwd?` | Shell command with captured stdout/stderr. Safety-checked. Env sanitized. |

## MCP OAuth 2.1 (`mcp_oauth/commands.rs`)

OAuth 2.1 authorization for upstream MCP servers. Full RFC 9728 (Protected Resource Metadata) + RFC 8414 (Authorization Server Discovery) flow with PKCE S256. Completion via the `tuic://oauth-callback` deep link.

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `start_mcp_upstream_oauth` | `name: String` | `StartOAuthResponse` | Begin an OAuth flow for the named upstream. Transitions status to `authenticating`, returns the authorization URL + AS origin for the consent dialog. PKCE challenge is generated and stored per pending flow |
| `mcp_oauth_callback` | `code: String, oauth_state: String` | `()` | Consume the `tuic://oauth-callback?code=…&state=…` deep link. Exchanges the code for tokens, persists `OAuthTokenSet` to the OS keyring, transitions upstream to `connecting` |
| `cancel_mcp_upstream_oauth` | `name: String` | `()` | Abort an in-flight OAuth flow. Drops the pending entry and resets upstream status |

## MCP Upstream Proxy (`mcp_upstream_config.rs`, `mcp_upstream_credentials.rs`)

Commands for managing upstream MCP servers proxied through FastAF's `/mcp` endpoint.

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `load_mcp_upstreams` | -- | `UpstreamMcpConfig` | Load upstream config from `mcp-upstreams.json` |
| `save_mcp_upstreams` | `base: UpstreamMcpConfig, config: UpstreamMcpConfig` | `()` | Apply the caller's ID-keyed base-to-config delta to the latest locked `mcp-upstreams.json`, validate it, and hot-reload the exact persisted change. Removing a server or its optional `auth` field is an explicit deletion; unrelated concurrent changes are preserved |
| `reconnect_mcp_upstream` | `name: String` | `()` | Disconnect and reconnect a single upstream by name. Useful after credential changes or transient failures |
| `get_mcp_upstream_status` | -- | `Vec<UpstreamStatus>` | Get live status of all upstream MCP servers. Status values: `connecting`, `ready`, `circuit_open`, `disabled`, `failed`, `authenticating`, `needs_auth` |
| `save_mcp_upstream_credential` | `name: String, token: String` | `()` | Store a Bearer token for an upstream in the OS keyring |
| `delete_mcp_upstream_credential` | `name: String` | `()` | Remove a Bearer token from the OS keyring (idempotent) |

### UpstreamMcpConfig schema

```typescript
interface UpstreamMcpConfig {
  servers: UpstreamMcpServer[];
}

interface UpstreamMcpServer {
  id: string;              // Unique UUID, used for config diff tracking
  name: string;            // Namespace prefix — must match [a-z0-9_-]+
  transport: UpstreamTransport;
  enabled: boolean;        // Default: true
  timeout_secs: number;    // Default: 30 (0 = no timeout, HTTP only)
  tool_filter?: ToolFilter; // Optional allow/deny filter
}

type UpstreamTransport =
  | { type: "http"; url: string }
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> };

interface ToolFilter {
  mode: "allow" | "deny";
  patterns: string[];  // Exact names or trailing-* glob prefix patterns
}
```

### Upstream status values

The live registry exposes status via SSE events (`upstream_status_changed`). Valid status strings:

| Value | Meaning |
|-------|---------|
| `connecting` | Handshake in progress |
| `ready` | Tools available |
| `circuit_open` | Circuit breaker open, backoff active |
| `disabled` | Disabled in config |
| `failed` | Permanently failed, manual reconnect required |

## Agent MCP Configuration (`agent_mcp.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `get_agent_mcp_status` | `agent` | `AgentMcpStatus` | Check MCP config for an agent |
| `install_agent_mcp` | `agent` | `String` | Install FastAF MCP entry |
| `remove_agent_mcp` | `agent` | `String` | Remove FastAF MCP entry |
| `get_agent_config_path` | `agent` | `String` | Get agent's MCP config file path |
| `get_mcp_bridge_info` | — | `McpBridgeInfo` | Bridge path + ready-to-paste JSON config snippet |

## Prompt Processing (`prompt.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `extract_prompt_variables` | `content` | `Vec<String>` | Parse `{var}` placeholders |
| `process_prompt_content` | `content, variables` | `String` | Substitute variables |
| `resolve_context_variables` | `repo_path: String` | `HashMap<String, String>` | Resolve git context variables (branch, diff, changed_files, commit_log, etc.) for smart prompt substitution. Best-effort: variables that fail are omitted |

## Smart Prompt Execution (`smart_prompt.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `execute_headless_prompt` | `command: String, args: Vec<String>, stdin_content: Option<String>, timeout_ms: u64, repo_path: String, env: Option<HashMap<String,String>>` | `Result<String, String>` | Spawn a one-shot agent process in argv form (no shell — metacharacters in args are literal). Prompt content piped via stdin. Timeout capped at 5 minutes |
| `execute_shell_script` | `script_content: String, timeout_ms: u64, repo_path: String` | `Result<String, String>` | Execute shell script content directly via platform shell (sh/cmd). No agent involved — runs the content as-is. Captures stdout. Timeout capped at 60 seconds |

## Claude Usage (`claude_usage.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `get_claude_usage_api` | -- | `UsageApiResponse` | Fetch rate-limit usage from Anthropic OAuth API |
| `get_claude_usage_timeline` | `scope, days?` | `Vec<TimelinePoint>` | Hourly token usage from session transcripts |
| `get_claude_session_stats` | `scope` | `SessionStats` | Aggregated token/session stats from JSONL transcripts |
| `get_claude_project_list` | -- | `Vec<ProjectEntry>` | List project slugs with session counts |

`scope` values: `"all"` (all projects) or a specific project slug. `days` defaults to 7.

Uses incremental parsing with a file-size-based cache (`claude-usage-cache.json`) so only newly appended JSONL data is processed on each call. The cache is persisted across app restarts.

## Voice Dictation (`dictation/`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `start_dictation` | -- | `()` | Start recording |
| `stop_dictation_and_transcribe` | -- | `TranscribeResponse` | Stop + transcribe. Returns `{text, skip_reason?, duration_s}` |
| `inject_text` | `text` | `String` | Apply corrections |
| `get_dictation_status` | -- | `DictationStatus` | Model/recording status plus normalized `audio_level` (0–1) |
| `get_model_info` | -- | `Vec<ModelInfo>` | Available models |
| `download_whisper_model` | `model_name` | `String` | Download model |
| `delete_whisper_model` | `model_name` | `String` | Delete model |
| `get_correction_map` | -- | `HashMap<String,String>` | Load corrections |
| `set_correction_map` | `map` | `()` | Save corrections |
| `list_audio_devices` | -- | `Vec<AudioDevice>` | List input devices |
| `get_dictation_config` | -- | `DictationConfig` | Load config |
| `set_dictation_config` | `config` | `()` | Save config |
| `check_microphone_permission` | -- | `String` | Check macOS microphone TCC permission status |
| `open_microphone_settings` | -- | `()` | Open macOS System Settings > Privacy > Microphone |

## Filesystem (`fs.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `resolve_terminal_path` | `cwd, candidate` | `Option<ResolvedFilePath>` | Resolve one terminal path candidate against `cwd`; `null` on a miss |
| `resolve_terminal_paths` | `cwd, candidates` | `Vec<Option<ResolvedFilePath>>` | Batched form, answered **positionally**: entry `i` is the result for `candidates[i]`. One IPC round-trip per terminal screen instead of one per candidate |
| `list_directory` | `path` | `Vec<DirEntry>` | List directory contents |
| `fs_read_file` | `path` | `String` | Read file contents |
| `write_file` | `path, content` | `()` | Write file |
| `create_directory` | `path` | `()` | Create directory |
| `delete_path` | `path` | `()` | Delete file or directory |
| `rename_path` | `src, dest` | `()` | Rename/move path |
| `copy_path` | `src, dest` | `()` | Copy file or directory |
| `copy_path_abs` | `from, to` | `()` | Copy a file by absolute paths (cross-repo paste). Rejects directories. |
| `move_path_abs` | `from, to` | `()` | Move a file by absolute paths (cross-repo cut+paste); copy+remove fallback across filesystems. |
| `fs_transfer_paths` | `destDir, paths, mode ("move"\|"copy"), allowRecursive` | `TransferResult { moved, skipped, errors, needs_confirm }` | Move/copy OS paths into a destination directory. Skips silently on name conflicts; returns `needs_confirm=true` (no-op) when a source is a directory and `allowRecursive=false`. Used by the drag-drop handler when dropping files onto a folder in the file browser. |
| `add_to_gitignore` | `path, pattern` | `()` | Add pattern to .gitignore |
| `search_files` | `path, query` | `Vec<SearchResult>` | Search files by name in directory |
| `search_content` | `repoPath, query, searchId, caseSensitive?, useRegex?, wholeWord?, limit?` | `()` | Full-text content search; streams results progressively via `content-search-batch` events, each echoing `searchId`. Binary files and files >1 MB are skipped. Supports cancellation. |
| `search_content_all` | `query, searchId, caseSensitive?, limit?` | `()` | Cross-repo BM25 content search over every ready index; streams via the same `content-search-batch` events with each match tagged `repo_path` and every batch echoing `searchId`. Only repos whose index is built participate (depends on Content Indexing strategy). Shares the cancellation slot with `search_content`. |

For both commands, every `ContentMatch.match_start`/`match_end` pair is a
zero-based, end-exclusive UTF-16 code-unit range within `line_text`, matching
JavaScript `String.slice` semantics for ASCII, accented text, and non-BMP emoji.

## Plugin Management (`plugins.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `list_user_plugins` | -- | `Vec<PluginManifest>` | List valid plugin manifests |
| `get_plugin_readme_path` | `id` | `Option<String>` | Get plugin README.md path |
| `read_plugin_data` | `plugin_id, path` | `Option<String>` | Read plugin data file |
| `write_plugin_data` | `plugin_id, path, content` | `()` | Write plugin data file |
| `delete_plugin_data` | `plugin_id, path` | `()` | Delete plugin data file |
| `install_plugin_from_zip` | `path` | `PluginManifest` | Install from local ZIP |
| `install_plugin_from_url` | `url` | `PluginManifest` | Install from HTTPS URL |
| `uninstall_plugin` | `id` | `()` | Remove plugin and all files |
| `install_plugin_from_folder` | `path` | `PluginManifest` | Install from local folder |
| `register_loaded_plugin` | `plugin_id` | `()` | Register a plugin as loaded (for lifecycle tracking) |
| `unregister_loaded_plugin` | `plugin_id` | `()` | Unregister a plugin (on unload/disable) |
| `set_plugin_output_watchers` | `client_id`, `seq`, `watchers: [{ id, pattern, flags }]` | `{ applied, rejected }` | Replace the OutputWatcher set of one frontend — the patterns the PTY reader thread matches lines against. The frontend pushes its whole set on every add or remove; sets are per `client_id`, and `seq` orders the mutations so a stale sync answers `applied: false` and changes nothing. The frontend re-sends the same set every 30 s while it holds any watcher — the backend has no disconnect signal, so that heartbeat is what keeps a live set from being evicted and what recovers one that already was. `rejected` lists the ids the Rust `regex` crate cannot compile (lookaround, backreferences, a negated class escape inside a character class); those watchers keep matching in the WebView, which then receives every line. |

## Plugin Filesystem (`plugin_fs.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `plugin_read_file` | `path, plugin_id` | `String` | Read file as UTF-8 (within $HOME, 10 MB limit) |
| `plugin_read_file_base64` | `path, plugin_id` | `String` | Read file bytes as base64 (within $HOME, 10 MB limit) |
| `plugin_read_file_tail` | `path, max_bytes, plugin_id` | `String` | Read last N bytes of file, skip partial first line |
| `plugin_list_directory` | `path, pattern?, plugin_id` | `Vec<String>` | List filenames in directory (optional glob filter) |
| `plugin_watch_path` | `path, plugin_id, recursive?, debounce_ms?` | `String` (watch ID) | Start watching path for changes |
| `plugin_unwatch` | `watch_id, plugin_id` | `()` | Stop watching a path |
| `plugin_write_file` | `path, content, plugin_id` | `()` | Write file within $HOME (path-traversal validated) |
| `plugin_rename_path` | `src, dest, plugin_id` | `()` | Rename/move path within $HOME (path-traversal validated) |

## Plugin HTTP (`plugin_http.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `plugin_http_fetch` | `url, method?, headers?, body?, allowed_urls, plugin_id` | `HttpResponse` | Make HTTP request (validated against allowed_urls) |

## Code Intelligence / MDKB (`mdkb_commands.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `mdkb_status` | — | `MdkbStatus` | Check if mdkb binary is available and daemon connected |
| `mdkb_outline` | `repo_path, file_path` | `Vec<OutlineSymbol>` | Get symbol outline (functions, types) for a file |
| `mdkb_goto_definition` | `repo_path, file_path, line, col?` | `DefinitionLocation?` | Find definition of symbol at position |
| `mdkb_references` | `repo_path, symbol_name` | `Vec<ReferenceLocation>` | Find all callers of a symbol via code_graph |
| `mdkb_code_find` | `repo_path, name, kind?` | `Vec<OutlineSymbol>` | Exact symbol lookup by name, optionally filtered by kind |
| `install_mdkb` | — | `String` | Download and install mdkb binary |
| `uninstall_mdkb` | — | `()` | Remove mdkb binary (errors for homebrew/cargo installs) |

**Line numbers are 1-based on this boundary.** mdkb stores symbol ranges 0-based
but takes a 1-based `line` as *input* to `symbol_at_position`. `mdkb_commands::editor_line`
shifts every response so `line`/`line_start`/`line_end` reaching the frontend
match CodeMirror's `doc.line(n)`. Request args (`mdkb_goto_definition`'s `line`)
are already 1-based and pass through unchanged.

**Each mdkb method has a different response shape** — do not assume "a JSON array
of symbols":

| mdkb hook method | `result` shape |
|---|---|
| `symbols_in_file` | `text` = stringified **bare array** |
| `symbol_at_position` | `text` = stringified **object**, or the literal `"null"` |
| `code_find` | `text` = stringified **envelope** `{total, showing, symbols}` |
| `code_graph` | `text` = **prose for agents**; the symbols are a separate `symbols` array on `result` |

`code_graph`'s `symbols` field was added after mdkb 3.7.17. Against an older
daemon the field is absent and the call fails loudly — "no callers" is `symbols: []`,
so an absent field can only mean a stale daemon and must never be reported as an
empty result.

## Plugin CLI Execution (`plugin_exec.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `plugin_exec_cli` | `binary, args, cwd?, plugin_id` | `String` | Execute whitelisted CLI binary, return stdout. Allowed: `mdkb`. 30s timeout, 5 MB limit. |

## Plugin Credentials (`plugin_credentials.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `plugin_read_credential` | `service_name, plugin_id` | `String?` | Read credential from system store (Keychain/file) |

## Plugin Registry (`registry.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `fetch_plugin_registry` | -- | `Vec<RegistryEntry>` | Fetch remote plugin registry index |

## Watchers

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `start_head_watcher` | `path` | `()` | Watch .git/HEAD for branch changes |
| `stop_head_watcher` | `path` | `()` | Stop watching .git/HEAD |
| `start_repo_watcher` | `path` | `()` | Watch .git/ for repo changes |
| `stop_repo_watcher` | `path` | `()` | Stop watching .git/ |
| `start_dir_watcher` | `path` | `()` | Watch directory for file changes (non-recursive) |
| `stop_dir_watcher` | `path` | `()` | Stop watching directory |
| `set_hot_repos` | `paths: Vec<String>` | `()` | Set repos with active terminals (cold repos get throttled watchers/polling) |

## System (`lib.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `load_config` | -- | `AppConfig` | Alias for load_app_config |
| `save_config` | `config` | `()` | Alias for save_app_config |
| `hash_password` | `password` | `String` | Bcrypt hash |
| `list_markdown_files` | `path` | `Vec<MarkdownFileEntry>` | List .md files in dir |
| `read_file` | `path, file` | `String` | Read file contents |
| `get_mcp_status` | -- | `JSON` | MCP server status (no token — use `get_connect_url` for QR) |
| `mcp_confirm_response` | `request_id, confirmed` | `()` | Answer a pending `ui(action=confirm)`. HTTP: `POST /mcp/confirm-response`. Every client is shown the same request and the first answer wins, so an unknown or already-answered id is a no-op, not an error |
| `get_connect_url` | `ip` | `String` | Build QR connect URL server-side (token stays in backend) |
| `check_update_channel` | `channel` | `UpdateCheckResult` | Check beta/nightly channel for updates (hardcoded URLs, SSRF-safe) |
| `clear_caches` | -- | `()` | Clear in-memory caches |
| `get_local_ip` | -- | `Option<String>` | Get primary local IP |
| `get_local_ips` | -- | `Vec<LocalIpEntry>` | List local network interfaces |
| `regenerate_session_token` | -- | `()` | Regenerate MCP session token (invalidates all remote sessions) |
| `fetch_update_manifest` | `url` | `JSON` | Fetch update manifest via Rust HTTP (bypasses WebView CSP) |
| `read_external_file` | `path` | `String` | Read file outside repo (standalone file open) |
| `get_relay_status` | -- | `JSON` | Cloud relay connection status |
| `get_tailscale_status` | -- | `TailscaleState` | Tailscale daemon status (NotInstalled/NotRunning/Running with fqdn, https_enabled) |

## Global Hotkey

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `set_global_hotkey` | `combo: Option<String>` | `()` | Set or clear the OS-level global hotkey. There is no getter: the current combo is the `global_hotkey` field of `AppConfig`, read through `load_config`. |

## App Logger (`app_logger.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `push_log` | `level, source, message` | `()` | Push entry to ring buffer (survives webview reloads) |
| `get_logs` | `level?, source?, limit?` | `Vec<LogEntry>` | Query ring buffer with optional filters |
| `clear_logs` | -- | `()` | Flush all log entries |

## Notification Sound (`notification_sound.rs`)

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `play_notification_sound` | `sound` | `()` | Play a Rust rodio notification sound (`question`, `completion`, `error`, `warning`, `info`, or `attention`) |
| `block_sleep` | -- | `()` | Prevent system sleep |
| `unblock_sleep` | -- | `()` | Allow system sleep |

## LLM API (`llm_api.rs`)

Smart Prompts "API" execution mode — direct LLM calls for prompt-based automation (distinct from AI Chat keyring).

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `load_llm_api_config` | -- | `LlmApiConfig` | Load `llm-api.json` (provider, model, base_url) |
| `save_llm_api_config` | `config: LlmApiConfig` | `()` | Persist LLM API config |
| `has_llm_api_key` | -- | `bool` | Check if an API key exists in the keyring for `Credential::LlmApiKey` |
| `save_llm_api_key` | `key: String` | `()` | Store the LLM API key in the OS keyring |
| `delete_llm_api_key` | -- | `()` | Remove the LLM API key from the OS keyring |
| `execute_api_prompt` | `system_prompt, content, timeout_ms?` | `String` | Execute a direct LLM call using the configured provider/model. Returns the model's response text. |
| `test_llm_api` | -- | `String` | Validate connection to the configured LLM endpoint (sends a test prompt) |
