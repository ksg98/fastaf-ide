# State Management

## Overview

State is split between the Rust backend (source of truth for persistence) and SolidJS frontend stores (reactive UI state).

## Backend State (`src-tauri/src/state.rs`)

### AppState

The central backend state, shared across all Tauri commands via `State<'_, Arc<AppState>>`:

`AppState` has **113 fields** (`state.rs:1328`). The excerpt below is the PTY core
only — it is NOT the whole struct. Read `state.rs` for the rest; the remainder covers
the config cache, git/GitHub TTL caches, repo watchers, session states, MCP/agent
registries, worktree bookkeeping and the event bus.

```rust
pub struct AppState {
    pub sessions: DashMap<String, Mutex<PtySession>>,       // Active PTY sessions
    pub(crate) data_dir: PathBuf,                            // Config/data directory
    pub(crate) worktrees_dir: PathBuf,                       // Worktree storage path
    pub(crate) metrics: SessionMetrics,                      // Atomic counters
    pub output_buffers: DashMap<String, Mutex<OutputRingBuffer>>, // MCP output access
    pub mcp_sessions: DashMap<String, McpSessionMeta>,       // MCP Streamable HTTP sessions
    pub ws_clients: DashMap<String, Vec<WsClientTx>>,        // WebSocket clients per session
    // ... 106 more fields
}
```

**Concurrency model:**
- `DashMap` for lock-free concurrent read/write of session maps
- `Mutex` for interior mutability of individual PTY writers and buffers
- `Arc<AtomicBool>` for pause/resume signaling per session
- `AtomicUsize` for zero-overhead metrics counters

### PtySession

```rust
pub type SharedPtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;

pub struct PtySession {
    pub writer: SharedPtyWriter,                        // Write to PTY (outside the session mutex)
    pub master: Box<dyn MasterPty + Send>,              // PTY master handle
    pub(crate) _child: Box<dyn Child + Send + Sync>,    // Child process
    pub(crate) paused: Arc<AtomicBool>,                 // Pause flag
    pub worktree: Option<WorktreeInfo>,                 // Associated worktree
    pub cwd: Option<String>,                            // Working directory
    pub display_name: Option<String>,                   // UI/agent/intent title
    pub display_name_is_custom: bool,                   // Explicit user rename wins over OSC/intent
    pub display_name_from_spawn: bool,                  // Named by agent spawn; OSC title must not replace it
    pub is_remote: bool,                                // Created through HTTP/MCP, not the desktop UI
    pub shell: String,                                  // Resolved spawn command, kept for shell-family classification
}
```

`writer` is deliberately outside the session `Mutex` so a terminal-generated reply can
wait on an in-flight user write without blocking the reader thread.

### SessionMetrics

Zero-overhead atomic counters:

```rust
pub(crate) struct SessionMetrics {
    pub(crate) total_spawned: AtomicUsize,
    pub(crate) failed_spawns: AtomicUsize,
    pub(crate) active_sessions: AtomicUsize,
    pub(crate) bytes_emitted: AtomicUsize,
    pub(crate) pauses_triggered: AtomicUsize,
}
```

### Buffer Types

| Buffer | Purpose | Capacity |
|--------|---------|----------|
| `Utf8ReadBuffer` | Accumulates bytes until valid UTF-8 boundary | Variable |
| `EscapeAwareBuffer` | Holds incomplete ANSI escape sequences | Variable |
| `OutputRingBuffer` | Circular buffer for MCP output access | 2 MB |

### Constants

```rust
pub(crate) const MAX_CONCURRENT_SESSIONS: usize = 50;
pub(crate) const OUTPUT_RING_BUFFER_CAPACITY: usize = 2 * 1024 * 1024; // 2 MB
```

## Frontend Stores

### Store Pattern

All stores follow a consistent pattern:

```typescript
// Internal reactive state
const [state, setState] = createStore<Type>(defaults);

// Exported as a module object
export const myStore = {
  get state() { return state; },  // Read-only access
  hydrate() { ... },              // Load from Rust
  action() { ... },               // Mutate + persist
};
```

### Store Registry

A subset — `src/stores/` holds 60 store modules. The table covers the ones a
contributor meets first; it is not the full inventory.

| Store | File | Purpose | Persisted |
|-------|------|---------|-----------|
| `terminalsStore` | `terminals.ts` | Terminal instances, active tab, split layout | Partial (IDs in repos) |
| `repositoriesStore` | `repositories.ts` | Saved repos, branches, terminal associations, repo groups | `repositories.json` |
| `settingsStore` | `settings.ts` | App settings (font, shell, IDE, theme, update channel) | `config.json` |
| `repoSettingsStore` | `repoSettings.ts` | Per-repository settings (scripts, worktree) | `repo-settings.json` |
| `repoDefaultsStore` | `repoDefaults.ts` | Default settings for new repositories | `repo-defaults.json` |
| `uiStore` | `ui.ts` | Panel visibility, sidebar width | `ui-prefs.json` |
| `githubStore` | `github.ts` | PR/CI data per branch, remote tracking (ahead/behind), PR state transitions | Not persisted |
| `promptLibraryStore` | `promptLibrary.ts` | Prompt templates | `prompt-library.json` |
| `notificationsStore` | `notifications.ts` | Notification preferences | `notification-config.json` |
| `dictationStore` | `dictation.ts` | Dictation config and state | `dictation-config.json` |
| `errorLogStore` | `errorLog.ts` | Error-log overlay open/closed | Not persisted |
| `rateLimitStore` | `ratelimit.ts` | Active rate limits | Not persisted |
| `tasksStore` | `tasks.ts` | Agent task queue | Not persisted |
| `promptStore` | `prompt.ts` | Active prompt overlay state | Not persisted |
| `diffTabsStore` | `diffTabs.ts` | Open diff tabs | Not persisted |
| `mdTabsStore` | `mdTabs.ts` | Open markdown tabs and plugin panels | Not persisted |
| `ideasStore` | `ideas.ts` | Ideas with repo tagging and used-at tracking | `notes.json` |
| `statusBarTicker` | `statusBarTicker.ts` | Priority-based rotating status bar messages | Not persisted |
| `userActivityStore` | `userActivity.ts` | Tracks last user click/keydown for activity-based timeouts | Not persisted |
| `updaterStore` | `updater.ts` | App update state (check, download, install) | Not persisted |
| `keybindingsStore` | `keybindings.ts` | Custom keyboard shortcut bindings | `keybindings.json` |
| `agentConfigsStore` | `agentConfigs.ts` | Per-agent run configs and toggles | `agents.json` |

### Key Store Relationships

```
repositoriesStore
    │
    ├── BranchState.terminals: string[]  ──references──> terminalsStore IDs
    ├── BranchState.worktreePath         ──managed by──> worktree.rs
    └── BranchState.additions/deletions  ──from──> git.rs (get_diff_stats)

terminalsStore
    │
    ├── TerminalData.sessionId           ──maps to──> AppState.sessions key
    ├── TerminalData.agentType           ──read by──> StatusBar (agent badge)
    ├── TerminalData.usageLimit          ──read by──> StatusBar (usage display)
    └── TabLayout.panes                  ──indexes into──> TerminalData[]

githubStore
    │
    ├── Per-branch PR status             ──from──> github.rs (get_repo_pr_statuses)
    ├── Per-repo remote status           ──from──> github.rs (get_github_status)
    ├── CheckSummary                     ──drives──> CiRing component
    └── PR state transitions             ──emits to──> prNotificationsStore

statusBarTicker
    │
    ├── TickerMessage[]                  ──rendered by──> StatusBar
    ├── Claude Usage messages            ──from──> features/claudeUsage.ts (native)
    └── Plugin messages                  ──from──> pluginRegistry (ui:ticker capability)

ideasStore
    │
    ├── Note.repoPath                    ──filters by──> active repo
    ├── Note.usedAt                      ──marks when──> sent to terminal
    └── filteredCount()                  ──drives──> StatusBar badge

settingsStore
    │
    ├── font/theme                       ──configures──> Terminal component
    ├── shell                            ──passed to──> create_pty
    ├── ide                              ──used by──> open_in_app
    └── updateChannel                    ──used by──> updaterStore
```

## Debug Registry (MCP Introspection)

Stores self-register snapshot functions via `src/stores/debugRegistry.ts`. Snapshots are exposed on `window.__TUIC__` and accessible through MCP `debug(action=invoke_js)`.

| API | Returns |
|-----|---------|
| `__TUIC__.stores()` | List of registered store names |
| `__TUIC__.store(name)` | Snapshot of the named store |

**Registered:** github, globalWorkspace, keybindings, notes, paneLayout, repositories, settings, tasks, ui.

To register a new store, append at the bottom of the store file:
```ts
import { registerDebugSnapshot } from "./debugRegistry";
registerDebugSnapshot("name", () => ({ /* safe subset */ }));
```

## Configuration Files

All config files are JSON, stored in the platform config directory:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/tuicommander/` |
| Linux | `~/.config/tuicommander/` |
| Windows | `%APPDATA%/tuicommander/` |

Legacy path `~/.tuicommander/` is auto-migrated on first launch.

### Config File Map

| File | Contents | Rust Type |
|------|----------|-----------|
| `config.json` | Shell, font, theme, MCP, remote access, update channel | `AppConfig` |
| `notification-config.json` | Sound preferences, volume | `NotificationConfig` |
| `ui-prefs.json` | Sidebar, error handling settings | `UIPrefsConfig` |
| `repo-settings.json` | Per-repo scripts, worktree options | `RepoSettingsMap` |
| `repo-defaults.json` | Default settings for new repos (base branch, scripts) | `RepoDefaultsConfig` |
| `repositories.json` | Saved repos, branches, groups | `serde_json::Value` |
| `prompt-library.json` | Prompt templates | `PromptLibraryConfig` |
| `dictation-config.json` | Dictation on/off, hotkey, language, model | `DictationConfig` |
| `notes.json` | Ideas/notes with repo tags and used-at timestamps | `serde_json::Value` |
| `keybindings.json` | Custom keyboard shortcut overrides | `serde_json::Value` |
| `agents.json` | Per-agent run configs and toggles | `AgentsConfig` |
| `claude-usage-cache.json` | Incremental JSONL parse offsets for session stats | `SessionStatsCache` |
