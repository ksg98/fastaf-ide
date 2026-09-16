# Configuration

**Module:** `src-tauri/src/config.rs`

Manages all application configuration as JSON files in the platform config directory.

## Config Directory

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/com.tuic.commander/` |
| Linux | `~/.config/com.tuic.commander/` |
| Windows | `%APPDATA%/com.tuic.commander/` |

Legacy paths `{platform_config}/tuicommander/`, `{platform_config}/tui-commander/`
and `~/.tuicommander/` are auto-migrated on first launch.

**Debug and release builds share this one directory** — `config_dir()` never
branches on `cfg!(debug_assertions)`. The single-instance lock is release-only
(`lib.rs`, `#[cfg(not(debug_assertions))]`), so a `make dev` build runs happily
alongside the installed app, and both read and write the exact same
`config.json`, `repositories.json`, and every other file below. What makes that
safe is the locking model in `ConfigFile<T>` (see Core Functions): a
cross-process advisory file lock. Ordinary `AppConfig`, upstream MCP, and
repository writes additionally apply caller deltas to the latest value while
that lock is held, so independent edits from two processes compose instead of
becoming ordered whole-document overwrites. `repositories.json` used to be the
one exception, seeded into a separate `~/.tuicommander-dev/` directory on first
debug run; that seeding path is gone and it now lives here like everything
else (see below).

## Core Functions

```rust
pub fn config_dir() -> PathBuf
pub fn load_json_config<T: DeserializeOwned + Default>(filename: &str) -> T
```

Config domains write through `ConfigFile<T>`:

```rust
impl<T: Serialize + DeserializeOwned + Default> ConfigFile<T> {
    pub fn load(&self) -> (T, Stamp)
    pub fn update<F: FnOnce(&mut T) -> bool>(&self, mutate: F) -> Result<(), String>
    pub fn update_with<R, F>(&self, mutate: F) -> Result<R, String>
    pub fn update_with_strict<R, F>(&self, mutate: F) -> Result<R, String>
    pub fn save_checked(&self, value: &T, stamp: Stamp) -> Result<(), ConfigWriteError>
    pub fn save(&self, value: &T) -> Result<(), String>
}
```

Two locks protect every write: an in-process `CONFIG_WRITE_LOCK` mutex, and a
cross-process advisory file lock (`std::fs::File::lock()` on a sibling
`<file>.lock`) that serializes writers across the debug/release instances that
now share one config dir. `save_checked` additionally compares a `Stamp`
(mtime+len, captured at `load()`) against the file's current on-disk state and
returns `ConfigWriteError::Conflict` instead of overwriting a change it never
saw — used by most whole-document per-domain files (`notifications.json`,
`ui-prefs.json`, `repo-settings.json`, etc.). Those callers capture the
stamp immediately before saving, so this narrows only the backend write race;
it is not a user-session conflict protocol. `config.json` (`AppConfig`) and
`mcp-upstreams.json` use delta-under-lock instead. `repositories.json` uses the
ID-keyed optimistic delta protocol documented below. See
[`2026-08-08-config-deltas-under-lock.md`](../decisions/2026-08-08-config-deltas-under-lock.md).

## Config Files and Commands

### Application Config (`config.json`)

**Type:** `AppConfig`

Frontend surfaces that update this full-document configuration use the shared
`updateAppConfig()` queue. It serializes each fresh load → owned-field mutation
→ save sequence so simultaneous General, Services, and plugin changes cannot
overwrite one another with stale snapshots.

**Ordinary saves merge under the cross-process lock; they do not replace the
document.** `PUT /config` and the MCP `config` tool (`action: "save"`) accept a
body that mentions only the fields being changed. IPC `save_config` retains its
typed full-config shape, but the backend derives the cache-to-request delta.
`commit_config_change` locks `config.json`, reloads and hydrates the latest disk
value, applies only the requested delta, persists it, and refreshes
`state.config` from the result. Objects merge key by key; arrays and scalars
replace wholesale (so an empty array still clears a list, `null` clears an
optional field, and `""` still blanks a string).
This is not cosmetic: every field carries `#[serde(default)]`, so deserializing a
partial body on its own reset the omitted ones — `services.server.enabled` defaults
to `false`, which is how a partial save used to switch remote access off on disk
while the already-bound listener kept serving, surfacing only at the next boot.

All three writers also share `server_settings_changed` and rebind the listener
through `restart_after_server_settings_change` when `services.server.{enabled,port,
ipv6_enabled}` or `services.auth.{username,password_hash}` move, so the running
process can never serve a configuration the disk disagrees with.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `shell` | `Option<String>` | `None` | Shell override (platform default if None) |
| `font_family` | `String` | `"JetBrains Mono"` | Terminal font family |
| `font_size` | `u16` | `14` | Terminal font size |
| `theme` | `String` | `"nezha-dark"` | Terminal theme |
| `ide` | `String` | `""` | IDE for "Open in..." |
| `default_font_size` | `u16` | `13` | Default font size for reset |
| `mcp_server_enabled` | `bool` | `true` | Enable MCP HTTP server |
| `mcp_port` | `u16` | `9876` | Fixed port for MCP server (0 = OS-assigned) |
| `collapse_tools` | `bool` | `false` | Replace the full MCP tool list with 3 lazy-discovery meta-tools (`search_tools`, `get_tool_schema`, `call_tool`). Discovered native schemas are unchanged: managed commands still use one `call_tool` invocation of `session action=submit` and receive the bounded receipt in that response. Grok sessions use this surface automatically without changing the stored value — see [`mcp-http.md`](mcp-http.md#lazy-tool-discovery-collapse_tools) |
| `services` | `ServicesConfig` | `{}` | Nested remote-access config: `server`, `auth`, `tls`, `relay`, `push` (replaces the former flat `remote_access_*`/`push_enabled`/`relay_enabled` fields) |

Remote-access secrets under `services` are not persisted in plaintext
`config.json`: `auth.session_token`, `relay.token`, and
`push.vapid_private_key` live in the OS keyring-backed credential vault. The
JSON file keeps only the non-secret settings plus `session_token_exists`,
`token_exists`, and `vapid_private_key_exists` booleans for UI state.

A vault **read failure** is never treated as "the secret is absent": on error
`hydrate_one_secret` keeps the `*_exists` flag that `config.json` recorded, so a
momentarily locked keychain cannot flip the flag to `false` and make the next
save delete a live credential. Plaintext still found in `config.json` is moved
into the vault at load time and the file is rewritten immediately, so the
cleartext copy does not survive on disk.

| `confirm_before_quit` | `bool` | `true` | Show quit confirmation |
| `confirm_before_closing_tab` | `bool` | `true` | Show tab close confirmation |
| `copy_on_select` | `bool` | `true` | Auto-copy terminal selection to clipboard |
| `osc52_clipboard` | `bool` | `true` | Honor OSC 52 clipboard-write sequences from terminal output (a notice shows on each write; disable to ignore them) |
| `bell_style` | `String` | `"visual"` | Terminal bell: "none", "visual", "sound", "both" |
| `disabled_agents` | `Vec<String>` | `[]` | Agent IDs hidden from the Add menu |
| `global_hotkey` | `Option<String>` | `null` | OS-level window toggle hotkey combo |
| `intent_tab_title` | `bool` | `true` | Show agent intent as tab title |
| `language` | `String` | `"en"` | UI language code |
| `max_tab_name_length` | `u32` | `25` | Max tab name display length |
| `tab_cycling_all_types` | `bool` | `false` | When true, next/prev-tab shortcuts cycle file/diff/markdown/editor tabs too (default cycles terminals only) |
| `tab_tree_enabled` | `bool` | `false` | When true, a branch with >1 terminal shows a collapsible nested list of its terminals under the branch row in the sidebar |
| `prevent_sleep_when_busy` | `bool` | `false` | Prevent macOS sleep when terminal is busy |
| `suggest_followups` | `bool` | `true` | Show `suggest:` follow-up actions |
| `issue_filter` | `Option<String>` | `"assigned"` | GitHub Issues filter: "assigned", "created", "mentioned", "all", "disabled" |
| `experimental_features_enabled` | `bool` | `false` | Master toggle for experimental features |
| `ai_chat_enabled` | `bool` | `false` | Sub-flag: enable AI Chat panel and shortcuts (requires `experimental_features_enabled`) |
| `scroll_history_enabled` | `bool` | `false` | Sub-flag: scrollback history overlay on scroll-up in agent mode (requires `experimental_features_enabled`) |
| `ai_terminal_mcp_enabled` | `bool` | `false` | Expose `ai_terminal_*` tools to external MCP clients. Off by default — see [`mcp-http.md`](mcp-http.md#mcp-tools-ai_terminal_-external-agent-surface) |
| `auto_show_pr_popover` | `bool` | `false` | Auto-show PR popover when switching to a branch with a PR |
| `update_channel` | `String` | `"stable"` | Update channel: "stable" or "nightly" |
| `inline_blame_enabled` | `bool` | `true` | Show GitLens-style inline git blame on the code editor's active line |
| `file_tree_colors_enabled` | `bool` | `true` | Tint file browser icons by file type (VSCode-style pastel palette) |
| `open_files_to_side` | `bool` | `true` | Open file-browser files in a split pane beside the active terminal instead of replacing the view |
| `hide_docked_file_tabs` | `bool` | `true` | While split, docked file tabs cluster on the right of the main tab bar, above their pane (VSCode-style); the pane's inner strip is hidden for file-only groups |
| `multiview_enabled` | `bool` | `true` | Multiview: toggleable grid (Cmd+Alt+M) showing every live terminal across all repos and branches at once |
| `terminal_drag_selects` | `bool` | `true` | Drag on a mouse-reporting TUI (vim, htop) selects text; a plain click is still forwarded to the app on release. Off = forward mousedown immediately |
| `import_tools_enabled` | `bool` | `true` | Show "Import from Claude Code / Codex / Cursor / superset.sh" in the Add Repository menu |
| `terminal_scroll_sensitivity` | `u16` | `70` | Terminal wheel-scroll sensitivity in percent (100 = raw device delta) |

**Commands:** `load_app_config()`, `save_app_config(config)`

Every writer of `config.json` — IPC `save_config`, `PUT /config`, MCP
`config action=save`, session-token rotation, `set_global_hotkey`, the
`disabled_mcp_agents` toggle and the push auto-enable on first subscription —
goes through
`config::commit_config_change`, which holds one process-wide mutex across the
whole cache-delta → file-lock → latest-disk-read → delta-merge →
preserve-secrets → write → update-`state.config` sequence. The cross-process
file lock spans the authoritative disk read and write. This distinction matters:
locking whole-document saves merely orders lost updates, while applying the
delta after the locked read preserves unrelated fields written by another
debug or release process.
Rotation
(`config::rotate_session_token`, shared by the desktop command and
`POST /auth/rotate-session-token`) goes through the same path so the vault, the
file and `state.config` cannot disagree — previously the in-memory config kept
the pre-rotation token and the next unrelated save wrote it back.

The vault and `config.json` are one logical commit. Before changing any of the
three vault-backed fields, `save_app_config` snapshots their previous values.
If either a later vault operation or the atomic file replacement fails, all
three vault values are restored before the error returns; `state.config` and
the live authentication token are updated only after success. A rollback
failure is appended to the original persistence error instead of being hidden.
Individual credential `set` and `delete` operations also publish their
in-memory vault clone only after the OS keyring accepts it.

Routing every writer through it also guarantees the file is produced by
`config_for_disk`. A writer that serialized the config itself (the
`disabled_mcp_agents` toggle called `save_json_config("config.json", ..)`)
skipped the stripping step and wrote the session token, relay token and VAPID
private key to disk in cleartext.

### MCP Bridge Auto-Install

On every launch `agent_mcp::ensure_mcp_configs` writes the `tuicommander` bridge
entry into each supported agent's own MCP config, and repairs the path when the
sidecar moves. Each target is written in the format its tool reads:

| Agent | Config file | Shape |
|---|---|---|
| Claude Code | `~/.claude.json` | JSON `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | JSON `mcpServers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | JSON `mcpServers` |
| VS Code | `<user dir>/mcp.json` | JSON `servers` |
| Zed | `~/.config/zed/settings.json` | JSON `context_servers` |
| Amp | `~/.config/amp/settings.json` | JSON `amp.mcpServers` |
| Gemini CLI | `~/.gemini/settings.json` | JSON `mcpServers` |
| Droid | `~/.factory/mcp.json` | JSON `mcpServers` |
| opencode | `~/.config/opencode/opencode.json[c]` | JSON `mcp`, `{type:"local", command:[…]}` |
| Codex | `~/.codex/config.toml` | TOML `[mcp_servers]` + `env_vars` allowlist |
| Grok | `~/.grok/config.toml` | TOML `[mcp_servers]` |
| goose | `~/.config/goose/config.yaml` | YAML `extensions` (`ExtensionEntry`) |
| pi | `~/.pi/agent/mcp.json` | JSON `mcpServers` (pi-mcp-adapter extension) |

Aider is absent because it has no MCP client.

**A target is written only when it is installed.** The writer creates every
missing parent directory, so an unconditional pass used to create `~/.cursor/`,
`~/.gemini/`, `~/.config/amp/` and friends for tools the user never had —
which makes *other* software report Cursor or Windsurf as installed. Presence is
proven two ways, cheapest first:

1. the config directory holds a file that is not the one we write (`.DS_Store`
   and stale `*.tmp` staging files do not count), or
2. one of the target's CLI binaries resolves via `cli::has_cli`.

Claude's config sits in `$HOME`, so it uses `~/.claude` as its presence
directory instead of the config file's parent. pi is stricter still: its MCP
support comes from the optional pi-mcp-adapter extension, which owns
`~/.pi/agent/mcp.json` — with no such file there is no adapter, so an
auto-written entry would configure nothing.

A target that already holds a `tuicommander` entry keeps getting path repairs
even when presence no longer resolves, so a stale bridge path is never left
behind. All gates live in `auto_install_allowed`, which only the launch pass
consults: Settings → Agents installs on demand through `ensure_spec_entry`
directly, because pressing Install states that the target is there — that is an
explicit request, not a guess.

**Shared settings files need an explicit install.** Zed, Amp and Gemini keep
their MCP server list inside the `settings.json` that also holds every other
user preference, not a dedicated `mcp.json`. Those three carry
`shared_settings_file: true` and the launch pass never creates or edits them:
FastAF being on the machine is not consent to rewrite the user's editor
configuration. Settings → Agents installs them on request, and once installed
they receive path repairs like any other target. `get_agent_mcp_status` returns
the flag so the UI can say why the entry is missing.

### Never Reserializing a Third-Party Config

Configs that exist but do not parse are **never** overwritten (JSON, TOML and
YAML alike). Treating a parse failure as an empty document is what reduced a
user's 400-line Zed `settings.json` to our single entry
([#115](https://github.com/sstraus/tuicommander/issues/115)).

JSON targets go further: they are never reserialized at all. `jsonc_edit`
parses the document into a concrete syntax tree, splices exactly one member,
and prints it back, so text outside that member is byte-identical. This matters
three times over — `serde_json` rejects the comments and trailing commas Zed,
VS Code and opencode all document as supported; `serde_json::Map` is a
`BTreeMap`, so a round trip alphabetises the user's keys; and
`to_string_pretty` discards their indentation.

Only the documented dialect is accepted. Comments and trailing commas parse;
single-quoted strings, unquoted keys and hexadecimal numbers do not, because a
file using them is one the owning tool cannot read either — writing it back as
if it were fine would be worse than refusing.

Guard rails around the write:

- The edited text is re-parsed and the member compared against what was
  requested before anything reaches disk.
- The first time we modify a file, its original is copied to
  `<config dir>/mcp-backups/<agent>-<filename>.orig`. Written once and never
  overwritten — the state worth keeping is the one from before FastAF
  ever touched it. It lives under our config directory rather than beside the
  original, where the owning tool might try to load or sync it.
- An edit that changes nothing skips the write entirely, so an idempotent pass
  never moves the mtime of a file an editor is watching.

### Removing Every Integration

`remove_all_mcp_integrations` drops the `tuicommander` entry from every target
that has one and adds them all to `disabled_mcp_agents` — without that the next
launch reinstalls them and the action does nothing. `list_installed_mcp_integrations`
backs the Settings → Agents panel that lists them. Uninstalling FastAF
otherwise leaves a dangling `tuic-bridge` path in each client it ever
configured, and each one reports a broken MCP server on startup. One
unparseable config does not abort the sweep: the rest are still cleaned and the
failures are reported together.

### Upstream MCP Config (`mcp-upstreams.json`)

**Type:** `UpstreamMcpConfig`

Interactive saves carry both the configuration the caller loaded (`base`) and
its desired `config`. The backend derives additions, intentional removals,
order changes, and per-server field deltas keyed by stable server ID, then
applies them to the latest document inside `ConfigFile::update_with`. A popup
toggle therefore changes only `enabled`; an OAuth/DCR auth record written after
the popup loaded is preserved. Removing a server or clearing an optional auth
field remains explicit and is not mistaken for an omitted/unchanged field.

Validation and the runtime registry diff use the exact merged pre/post values
from the locked transaction. The lock is released before asynchronous reconnect
work starts.

**Commands:** `load_mcp_upstreams()`, `save_mcp_upstreams(base, config)`

### Notification Config (`notifications.json`)

**Type:** `NotificationConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `bool` | `true` | Global enable |
| `volume` | `f64` | `0.5` | Volume (0.0-1.0) |
| `sounds.question` | `bool` | `true` | Play on agent question |
| `sounds.error` | `bool` | `true` | Play on error |
| `sounds.completion` | `bool` | `true` | Play on completion |
| `sounds.warning` | `bool` | `true` | Play on warning |
| `silence_remote_completions` | `bool` | `true` | Suppress the completion chime for HTTP/MCP-created sessions |
| `toasts_in_bell` | `bool` | `true` | Mirror every toast into the toolbar bell, under a MESSAGES section |

**Commands:** `load_notification_config()`, `save_notification_config(config)`

### AI Chat Config (`ai-chat-config.json`)

**Type:** `AiChatConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `String` | `"ollama"` | AI provider: `ollama`, `anthropic`, `openai`, `openrouter`, `custom` |
| `model` | `String` | `""` | Model name |
| `base_url` | `Option<String>` | per-provider | Endpoint base URL |
| `temperature` | `f32` | `0.7` | Sampling temperature |
| `context_lines` | `u32` | `150` | VtLogBuffer rows injected per turn |
| `experimental_ai_block_enrichment` | `bool` | `false` | Enrich OSC 133 blocks with semantic intent |
| `agent_model_overrides` | `Option<HashMap<ToolPhase, String>>` | `None` | Per-phase model routing. Keys: `plan`, `search`, `read`, `write` |

**Commands:** `load_ai_chat_config()`, `save_ai_chat_config(config)`

### Provider Registry (`providers.json`)

**Type:** `ProviderRegistry` (`provider_registry.rs`, schema version 3) — `providers`, `models`, `slots` (`main` / `triage` / `headless` → model id), `phase_overrides`.

A provider entry is `{ id, type, label, base_url? }`. `type` is one of `anthropic`, `open_ai`, `chat_gpt`, `gemini`, `deep_seek`, `mistral`, `fireworks`, `samba_nova`, `moonshot`, `xai`, `zai`, `open_router`, `requesty`, `lite_llm`, `ollama`, `lm_studio`, `bedrock`, `vertex`, `custom`. API keys never live in the file: they are in the OS keyring under `provider/<id>`.

`chat_gpt` has no key and ignores `base_url`. It resolves to the loopback endpoint in `chatgpt::door` (`http://127.0.0.1:<random>/v1/`, per-process key), backed by the "Sign in with ChatGPT" tokens stored once — not per provider — under the keyring entry `chatgpt/auth`.

**Commands:** `load_provider_registry()`, `save_provider_registry(registry)`, `save_provider_api_key(providerId, key)`, `delete_provider_api_key(providerId)`, `fetch_provider_models(providerId)`, `test_slot_connection(slot)`, `chatgpt_auth_status()`, `chatgpt_start_login()`, `chatgpt_cancel_login()`, `chatgpt_logout()`

### Cron Scheduler Config (`ai-cron.json`)

**Type:** `SchedulerConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `jobs` | `Vec<ScheduledJob>` | `[]` | List of scheduled agent jobs |

Each `ScheduledJob`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `String` | Unique job identifier |
| `cron_expr` | `String` | Cron expression (validated on save) |
| `goal` | `String` | Agent goal to execute |

**Commands:** `load_scheduler_config()`, `save_scheduler_config(config)`

### UI Preferences (`ui-prefs.json`)

**Type:** `UIPrefsConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sidebar_visible` | `bool` | `true` | Sidebar visibility |
| `sidebar_width` | `u32` | `280` | Sidebar width in pixels |
| `error_handling.strategy` | `String` | `"retry"` | Error strategy |
| `error_handling.max_retries` | `u32` | `3` | Max retry count |

**Commands:** `load_ui_prefs()`, `save_ui_prefs(config)`

### Repository Settings (`repo-settings.json`)

**Type:** `RepoSettingsMap` (HashMap of `RepoSettingsEntry`)

Per-repository fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | `String` | -- | Repository path |
| `display_name` | `String` | -- | Display name |
| `base_branch` | `String` | `"main"` | Base branch for worktrees |
| `copy_ignored_files` | `bool` | `false` | Copy .gitignored files to worktree |
| `copy_untracked_files` | `bool` | `false` | Copy untracked files to worktree |
| `setup_script` | `String` | `""` | Script to run after worktree creation |
| `run_script` | `String` | `""` | Default run command |
| `auto_fetch_interval_minutes` | `u32` | `0` | Auto-fetch interval in minutes (0 = disabled) |
| `auto_delete_on_pr_close` | `AutoDeleteOnPrClose` | `"off"` | Auto-delete branch when PR merged/closed (`off`/`ask`/`auto`) |
| `archive_script` | `String` | `""` | Script to run before archive/delete (non-zero exit blocks) |

**Commands:** `load_repo_settings()`, `save_repo_settings(config)`, `check_has_custom_settings(path)`

### Repository Defaults (`repo-defaults.json`)

**Type:** `RepoDefaultsConfig`

Default values applied to new repositories when no per-repo override exists.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `base_branch` | `String` | `"automatic"` | Default base branch |
| `copy_ignored_files` | `bool` | `false` | Copy .gitignored files to worktree |
| `copy_untracked_files` | `bool` | `false` | Copy untracked files to worktree |
| `setup_script` | `String` | `""` | Default setup script |
| `run_script` | `String` | `""` | Default run command |
| `archive_script` | `String` | `""` | Default archive script |

**Commands:** `load_repo_defaults()`, `save_repo_defaults(config)`

### Repositories (`repositories.json`)

**Type:** `serde_json::Value` (flexible persisted JSON, shape defined by frontend)

Stored in the shared config directory like every other file (see Config
Directory) — debug and release builds read and write the same
`repositories.json`. Every write uses a versioned delta inside the existing
`save_repositories(config)` argument:

```json
{
  "mutationVersion": 1,
  "repos": [{ "id": "/repo", "before": {}, "after": {} }],
  "groups": [{ "id": "group-id", "before": null, "after": {} }],
  "repoOrder": { "before": [], "after": ["/repo"] },
  "activeRepoPath": { "before": null, "after": "/repo" },
  "groupOrder": { "before": [], "after": ["group-id"] }
}
```

`before` is the last value that client successfully loaded or persisted;
`after` is its intended value, and `null` in an ID-keyed mutation means absence
or deletion. The backend acquires the cross-process lock, strictly reloads the
latest document, and applies each repository/group mutation by ID. Mutations
to different IDs compose. Independent membership additions/removals in
`repoOrder` and `groupOrder` are three-way merged; incompatible reorders
conflict. Active-repository changes use the same `before`/`after` check.

A stale mutation of the same repository, group, active selection, or order is
rejected with a deterministic conflict instead of overwriting the newer value.

**Derived branch fields are exempt from that check.** `additions`, `deletions`,
`isMerged`, `lastActiveTerminal` and `lastCommitTs` (`DERIVED_BRANCH_FIELDS` in
`config.rs`) are a cache each client recomputes from the repository itself, on
its own refresh cadence — two windows legitimately hold two different values at
the same instant, so comparing them turns every save into a conflict. Measured
2026-08-31: `ego` moved 331 → 357 additions in 70 seconds while 29 consecutive
saves were rejected, and unrelated intent — registering a repository — was
wedged behind a number nobody edited. The conflict check compares records with
those fields stripped; the "already applied" check stays exact, so a
derived-only update still persists and the cache keeps moving. Everything a
human sets (name, order, grouping, active branch) is still fully guarded, and
concurrent edits to the derived fields themselves resolve last-writer-wins.
IPC reports that error to the frontend, where it creates a user-visible Errors
badge; HTTP returns `409 Conflict`. Malformed deltas return HTTP `400`. A
versioned delta is required; unversioned whole-document bodies are rejected.

**A successful write is announced, so the other clients converge instead of
colliding.** One backend serves the desktop WebView, the browser and the PWA at
once, and each keeps its own `before` baseline. Until this event existed, a save
told the other clients nothing: their baseline stayed stale until a conflict
taught them otherwise, which is late — by then the two documents have already
diverged. Both save paths (`save_repositories` over IPC, `PUT
/config/repositories` over HTTP) now call `AppState::notify_repositories_changed()`,
which dual-emits the payload-free `repositories-changed` event to the desktop
window and onto the `/events` SSE bus.

It fires **only when the document actually moved**:
`save_repositories_request` returns `Ok(true)` for a write and `Ok(false)` for a
delta already applied, so a no-op save does not wake every client. The payload is
empty by design — a receiver only needs "disk moved, re-read it", and shipping
the document would copy the whole repository set to everyone on every save.

On the receiving side `repositoriesStore` re-reads `repositories.json` and adopts
a key **only when it has no unsaved intent for it** — when its live value still
equals its baseline. Adopted keys move in the store *and* in the baseline
together: those two are diffed against each other on every save, so refreshing
one alone would make the next diff revert what the other client just wrote. Two
keys are deliberately never adopted: `activeRepoPath`, because which repo a
window is looking at is per-window and a background event must not move the
user's focus, and a repository whose disk record disappeared while it still holds
open terminals, because dropping it would orphan panes the user is looking at.
Keys this client did change are left untouched and still resolve through the
compare-and-swap rebase.

Four details make that gate hold up in practice:

- **The "unsaved intent" test runs on an intent view, not the whole record.**
  `repositoriesStore` mirrors the backend's `DERIVED_BRANCH_FIELDS` (plus
  `hadTerminals`, which is session state that happens to be persisted) and
  normalizes both sides through the same migration pass `hydrate` applies. Without
  the first, a repo under active work drifts from its own baseline every few
  seconds via `updateBranchStats`, which saves nothing — and adoption would be
  refused for exactly the repos the user is working in. Without the second, a
  baseline read off disk *before* the migration defaults were added never matches
  the migrated store, and a record written by an older build is never adopted.
- **The live-terminal rule applies per branch, not only per repository.** A repo
  record that survives on disk with one branch removed goes through the merge path,
  where the repo-level guard never runs; a branch this window still has a pane in is
  kept there instead.
- **Every repo the store holds stays in `repoOrder`.** The order arrives from the
  client that *did* drop the repo, so a record kept for its live terminals would
  otherwise leave the sidebar while its panes keep running. Grouping is an overlay:
  `getGroupedLayout` filters grouped paths out of `repoOrder` at render time, so
  putting a repo back there is always safe.
- **Adoption waits for an in-flight save.** A save ends by assigning the baseline
  it computed before it was sent, and nothing orders the broadcast against that
  save's own reply — so an adoption landing inside the window would have its
  baseline overwritten while its store changes stay, which is the one state this
  whole path exists to prevent.

**Version skew is the dangerous case, and it is one-sided.** A backend from
before the delta protocol does not decode `config` at all — it stores it as the
whole document, so `repositories.json` becomes the delta envelope and every
repository is lost. This is not theoretical: `make dev` never hot-reloads Rust,
so a hot-reloaded frontend meeting a stale backend did exactly that on
2026-08-21. The old binary cannot be fixed retroactively, so the guard lives at
the read end: `repositoriesStore.hydrate()` treats a root `mutationVersion`, or
`repos` as an array, as a poisoned file — it logs a user-visible error, refuses
to hydrate, and leaves `hydrated` false so **no save can run**. That last part is
what makes a hand-restored backup stick; without it, the running app clobbers the
restored file within seconds.

`repositories.json` used to be the one file exempt from the (then-real)
debug/release split: it was seeded into a separate `~/.tuicommander-dev/`
directory on first debug run so a dev instance wouldn't start with an empty
repo list. That seeding path is gone now that both builds share one
directory for `repositories.json` and all other config domains covered by
this document. (`~/.tuicommander-dev/` itself still exists for an unrelated
purpose — see `credentials.rs`'s debug-only credential store.)

**Commands:** `load_repositories()`, `save_repositories(config)`

### Prompt Library (`prompt-library.json`)

**Type:** `PromptLibraryConfig`

```rust
struct PromptEntry {
    id: String,
    label: String,
    text: String,
    pinned: bool,
}
```

**Commands:** `load_prompt_library()`, `save_prompt_library(config)`

### AI Prompts (`ai-prompts.json`)

**Type:** `AiPromptsConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `diff_triage_system_prompt` | `Option<String>` | `None` | Custom system prompt for diff triage LLM classification. Falls back to built-in default when `None` or empty. |

**Commands:** `load_ai_prompts()`, `save_ai_prompts(config)`

**MCP actions:** `list_ai_prompts`, `load_ai_prompt` (requires `service`), `save_ai_prompt` (requires `service` + `prompt`, localhost only)

### Notes (`notes.json`)

**Type:** `serde_json::Value` (flexible JSON, shape defined by frontend)

**Commands:** `load_notes()`, `save_notes(config)`

### Keybindings (`keybindings.json`)

**Type:** `serde_json::Value` (flexible JSON, shape defined by frontend)

Custom keyboard shortcut overrides.

**Commands:** `load_keybindings()`, `save_keybindings(config)`

### Agents Config (`agents.json`)

**Type:** `AgentsConfig`

Per-agent run configurations (custom commands, arguments, environment variables).

```rust
struct AgentRunConfig {
    name: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    is_default: bool,
}

struct AgentSettings {
    run_configs: Vec<AgentRunConfig>,
}

struct AgentsConfig {
    agents: HashMap<String, AgentSettings>,
}
```

**Commands:** `load_agents_config()`, `save_agents_config(config)`

### AI Chat Config (`ai-chat-config.json`)

**Type:** `AiChatConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `String` | `"ollama"` | Provider: `"ollama"`, `"anthropic"`, `"openai"`, `"openrouter"`, `"custom"` |
| `model` | `String` | provider-specific | Model name (free text; settings tab suggests per provider) |
| `base_url` | `Option<String>` | provider-specific | Pre-filled per provider, editable. Ollama default: `http://localhost:11434/v1/` |
| `temperature` | `f32` | `0.7` | Sampling temperature passed through to provider |
| `context_lines` | `u32` | `150` | Maximum `VtLogBuffer` lines injected into each turn's context |

**Commands:** `load_ai_chat_config()`, `save_ai_chat_config(config)`

API keys are stored in the OS keyring — service `tuicommander-ai-chat`, user `api-key` — via `save_ai_chat_api_key` / `delete_ai_chat_api_key`. Saved conversations live in `<config_dir>/ai-chat-conversations/<id>.json`.

### Dictation Config (`dictation-config.json`)

**Type:** `DictationConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `bool` | `false` | Dictation enabled |
| `hotkey` | `String` | `"CommandOrControl+Shift+D"` | Push-to-talk hotkey |
| `language` | `String` | `"en"` | Transcription language |
| `model` | `String` | `"large-v3-turbo"` | Whisper model name |
| `auto_send` | `bool` | `false` | Auto-submit after transcription |

**Commands:** `get_dictation_config()`, `set_dictation_config(config)`

## Cache Files

### Claude Usage Cache (`claude-usage-cache.json`)

**Module:** `src-tauri/src/claude_usage.rs`

Persistent cache for incremental JSONL parsing of Claude session transcripts. Stored in the config directory. The cache maps `project_slug -> (filename -> CachedFileStats)` and tracks per-file byte offsets so only newly appended data is parsed on subsequent scans.

This is an internal cache file, not user-editable. It is automatically pruned when projects or session files are deleted.

## Repo-Local Config (`.tuic.json`)

**Module:** `src-tauri/src/config.rs`

A `.tuic.json` file in the repository root provides team-shareable settings. It is read-only from the app — teams edit it directly in their repo and commit it.

**Precedence chain:** `.tuic.json` > per-repo app settings (`repo-settings.json`) > global defaults (`repo-defaults.json`)

**Type:** `RepoLocalConfig` (all fields `Option<T>`, missing fields fall through to lower tiers)

| Field | Type | Description |
|-------|------|-------------|
| `base_branch` | `String` | Base branch for worktrees |
| `copy_ignored_files` | `bool` | Copy .gitignored files to worktree |
| `copy_untracked_files` | `bool` | Copy untracked files to worktree |
| `setup_script` | `String` | Script to run after worktree creation |
| `run_script` | `String` | Default run command |
| `archive_script` | `String` | Script to run before archive/delete |
| `worktree_storage` | `WorktreeStorage` | Storage strategy (sibling/app-dir/inside-repo) |
| `delete_branch_on_remove` | `bool` | Delete branch when removing worktree |
| `auto_archive_merged` | `bool` | Auto-archive merged worktrees |
| `orphan_cleanup` | `OrphanCleanup` | Orphan worktree handling |
| `pr_merge_strategy` | `MergeStrategy` | PR merge method preference |
| `after_merge` | `WorktreeAfterMerge` | Post-merge worktree action |
| `auto_delete_on_pr_close` | `AutoDeleteOnPrClose` | Auto-delete on PR close |

**Command:** `load_repo_local_config(repo_path)` — returns `RepoLocalConfig` or `null` if file is missing or malformed.

## Additional Commands

| Command | Module | Description |
|---------|--------|-------------|
| `hash_password(password)` | `lib.rs` | Bcrypt hash for remote access authentication |
| `list_markdown_files(path)` | `lib.rs` | List .md files in a directory |
| `read_file(path, file)` | `lib.rs` | Read a file's contents |
| `get_mcp_status()` | `lib.rs` | Get MCP server status (enabled, port, connected clients) |
| `clear_caches()` | `lib.rs` | Clear in-memory caches |
| `get_local_ip()` | `lib.rs` | Get primary local IP address |
| `get_local_ips()` | `lib.rs` | List all local network interfaces |
| `get_claude_usage_api()` | `claude_usage.rs` | Fetch rate-limit usage from Anthropic OAuth API |
| `get_claude_usage_timeline(scope, days?)` | `claude_usage.rs` | Get hourly token usage timeline from session transcripts |
| `get_claude_session_stats(scope)` | `claude_usage.rs` | Scan JSONL transcripts for aggregated token/session stats |
| `get_claude_project_list()` | `claude_usage.rs` | List Claude project slugs with session counts |
| `fetch_plugin_registry()` | `registry.rs` | Fetch remote plugin registry index |
