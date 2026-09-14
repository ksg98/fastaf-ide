# Stores Reference

All stores use SolidJS `createStore` for reactive state. Each store exposes a `state` getter and action methods.

## terminalsStore

**File:** `src/stores/terminals.ts`

Manages terminal instances, active tab selection, split pane layout, and closed tab history.

### State Shape

| Field | Type | Description |
|-------|------|-------------|
| `terminals` | `Record<string, TerminalData>` | All terminals by ID |
| `activeId` | `string \| null` | Currently active terminal |
| `layout` | `TabLayout` | Split pane layout state |

### Key Types

```typescript
interface TerminalData {
  id: string;
  sessionId: string | null;
  name: string;
  nameIsCustom: boolean;            // When true, OSC/status-line title changes are ignored
  fontSize: number;
  cwd: string | null;               // Current working directory (from OSC 7)
  repoPath: string | null;          // Owning repo — the record. null = parked guess (see terminalOwnership)
  awaitingInput: AwaitingInputType; // "question" | "error" | null
  awaitingInputConfident: boolean;  // High-confidence detection — don't clear on idle→busy
  shellState: ShellState;           // "busy" | "idle" | null
  activity: boolean;
  unseen: boolean;                  // Terminal completed work while user wasn't viewing it
  progress: number | null;          // OSC 9;4 progress (0-100), null when inactive
  agentType: AgentType | null;      // Detected foreground agent process (e.g. "claude")
  pendingResumeCommand: string | null; // Set at restore time, consumed on first shell idle
  pendingInitCommand: string | null;   // Setup/run script to auto-execute on first shell idle
  usageLimit: { percentage: number; limitType: string } | null;
  lastDataAt: number | null;        // Timestamp of last PTY output
  lastPrompt: string | null;        // Last relevant user prompt (>= 10 words), set by Rust
  agentIntent: string | null;       // LLM-declared intent via intent: token
  currentTask: string | null;       // Current agent task from status-line parsing
  activeSubTasks: number;           // Count of running sub-agents from ›› status line
  isRemote: boolean;                // Created via HTTP/MCP (not locally by the UI)
  agentSessionId: string | null;    // Agent session ID for session-specific resume
  tuicSession: string | null;       // Stable tab UUID — injected as TUIC_SESSION env var
  suggestedActions: string[] | null; // Follow-up suggestions from suggest: token
  suggestDismissed: boolean;        // true after user dismissed — prevents re-show
}

interface TabLayout {
  direction: SplitDirection;  // "none" | "vertical" | "horizontal"
  panes: string[];            // Terminal IDs (up to MAX_SPLIT_PANES = 6)
  ratios: number[];           // N fractions summing to 1.0 (length === panes.length)
  activePaneIndex: number;    // 0..N-1
}
```

### Actions

| Method | Description |
|--------|-------------|
| `add(data)` | Add a terminal |
| `remove(id)` | Remove a terminal |
| `setActive(id)` | Set active terminal (clears activity flag) |
| `update(id, data)` | Partial update terminal data |
| `setSessionId(id, sessionId)` | Update session ID |
| `setFontSize(id, fontSize)` | Update font size |
| `setAwaitingInput(id, type)` | Set awaiting input indicator |
| `clearAwaitingInput(id)` | Clear awaiting input |
| `splitPane(direction)` | Split into two panes |
| `closeSplitPane(index)` | Collapse back to single pane |
| `setSplitRatio(ratio)` | Adjust split ratio |
| `setActivePaneIndex(index)` | Switch active pane |

### Queries

| Method | Description |
|--------|-------------|
| `get(id)` | Get terminal by ID |
| `getActive()` | Get active terminal |
| `getIds()` | Get all terminal IDs |
| `getCount()` | Get terminal count |
| `hasAwaitingInput()` | Any terminal awaiting input? |
| `getAwaitingInputIds()` | Get IDs of terminals awaiting input |

---

## repositoriesStore

**File:** `src/stores/repositories.ts`

Manages saved repositories, branches, terminal associations, and PR status cache.

### State Shape

| Field | Type | Description |
|-------|------|-------------|
| `repos` | `Record<string, RepositoryState>` | Repositories by path |
| `activePath` | `string \| null` | Active repository path |

### Key Types

```typescript
interface RepositoryState {
  path: string;
  displayName: string;
  initials: string;
  isGitRepo?: boolean;    // false for plain directories
  expanded: boolean;      // Show branch list
  collapsed: boolean;     // Icon-only mode
  parked: boolean;        // Hidden from sidebar (recallable via popover)
  branches: Record<string, BranchState>;
  activeBranch: string | null;
}

interface BranchState {
  name: string;
  isMain: boolean;
  isShell?: boolean;               // true for non-git directory shell entries
  worktreePath: string | null;
  terminals: string[];             // Terminal IDs
  hadTerminals: boolean;           // Suppresses auto-spawn after close-all
  lastActiveTerminal: string | null;
  additions: number;
  deletions: number;
  isMerged: boolean;               // Fully merged into main branch
  lastCommitTs: number | null;     // Unix timestamp of last commit
  runCommand?: string;
  savedTerminals?: SavedTerminal[];
  ciAutoHeal?: { enabled: boolean; attempts: number; lastRunId?: number; healing?: boolean };
  layout?: TabLayout;              // Split layout persisted per-branch
}
```

### Actions

| Method | Description |
|--------|-------------|
| `hydrate()` | Load from Rust backend |
| `add(repo)` | Add repository |
| `remove(path)` | Remove repository |
| `setActive(path)` | Set active repository |
| `toggleExpanded(path)` | Toggle branch list visibility |
| `toggleCollapsed(path)` | Toggle icon-only mode |
| `setBranch(repoPath, branchName, data)` | Add/update branch |
| `setActiveBranch(repoPath, branchName)` | Set active branch |
| `addTerminalToBranch(repoPath, branchName, terminalId)` | Link terminal |
| `removeTerminalFromBranch(repoPath, branchName, terminalId)` | Unlink terminal |
| `setRunCommand(repoPath, branchName, command)` | Save run command |
| `updateBranchStats(repoPath, branchName, additions, deletions)` | Update diff stats |
| `removeBranch(repoPath, branchName)` | Remove branch |
| `renameBranch(repoPath, oldName, newName)` | Rename branch |
| `reorderTerminals(repoPath, branchName, fromIndex, toIndex)` | Reorder tabs |

### Queries

| Method | Description |
|--------|-------------|
| `get(path)` | Get repository by path |
| `getActive()` | Get active repository |
| `getPaths()` | Get all repository paths |
| `getActiveTerminals()` | Get terminal IDs for active branch |
| `isEmpty()` | Check if no repositories |

---

## settingsStore

**File:** `src/stores/settings.ts`

Application settings: font, shell, IDE, theme, confirmations.

### State Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ide` | `IdeType` | `"cursor"` | IDE for "Open in..." |
| `font` | `FontType` | `"JetBrains Mono"` | Terminal font |
| `agent` | `string` | `"claude"` | Primary agent |
| `defaultFontSize` | `number` | `12` | Default font size |
| `shell` | `string` | `""` | Shell override |
| `theme` | `string` | `"dark"` | Terminal theme |
| `confirmBeforeQuit` | `boolean` | `true` | Quit confirmation |
| `confirmBeforeClosingTab` | `boolean` | `true` | Tab close confirmation |
| `maxTabNameLength` | `number` | `20` | Max tab name length |

### Constants

- `IDE_NAMES` — Display names for IDEs
- `IDE_ICONS` — Emoji icons
- `IDE_ICON_PATHS` — SVG icon paths
- `IDE_CATEGORIES` — IDE grouping (editors, terminals, git, utilities)
- `FONT_FAMILIES` — CSS font-family strings

---

## githubStore

**File:** `src/stores/github.ts`

GitHub PR and CI data with background polling.

### Actions

| Method | Description |
|--------|-------------|
| `updateRepoData(repoPath, prStatuses)` | Update PR data for all branches (detects state transitions for notifications) |
| `startPolling()` | Start background polling (30s base, 2m when hidden, 5m backoff on rate limit) |
| `stopPolling()` | Stop polling |
| `pollRepo(path)` | Immediately poll a single repo (debounced 2s to coalesce rapid git events) |
| `setRemoteStatus(repoPath, remote)` | Set remote tracking status directly (used by simulator) |

### Queries

| Method | Description |
|--------|-------------|
| `getCheckSummary(repoPath, branch)` | Get CI check summary |
| `getPrStatus(repoPath, branch)` | Get PR status |
| `getCheckDetails(repoPath, branch)` | Get CI check details |
| `getBranchPrData(repoPath, branch)` | Get full BranchPrStatus |
| `getRemoteStatus(repoPath)` | Get remote tracking status (ahead/behind) |

---

## promptLibraryStore

**File:** `src/stores/promptLibrary.ts`

Prompt template management with variable substitution.

### State Fields

| Field | Type | Description |
|-------|------|-------------|
| `prompts` | `SavedPrompt[]` | All prompts |
| `drawerOpen` | `boolean` | Drawer visibility |
| `searchQuery` | `string` | Search filter |
| `selectedCategory` | `PromptCategory` | Category filter |
| `recentIds` | `string[]` | Recently used prompt IDs |

### Actions

| Method | Description |
|--------|-------------|
| `hydrate()` | Load from Rust |
| `openDrawer()` / `closeDrawer()` / `toggleDrawer()` | Drawer visibility |
| `createPrompt(data)` | Create new prompt |
| `updatePrompt(id, data)` | Update prompt |
| `deletePrompt(id)` | Delete prompt |
| `toggleFavorite(id)` | Toggle pinned status |
| `markAsUsed(id)` | Add to recent list |
| `processContent(prompt, variables)` | Substitute variables (via Rust) |
| `extractVariables(content)` | Parse `{{variable}}` placeholders (via Rust) |

---

## statusBarTicker

**File:** `src/stores/statusBarTicker.ts`

Rotating message ticker for the status bar. Plugins and native features post messages; the highest-priority message is displayed, with rotation among equal-priority messages.

### TickerMessage Type

```typescript
interface TickerMessage {
  id: string;           // Unique message ID (scoped to plugin)
  pluginId: string;     // Plugin that posted the message
  text: string;         // Display text (~40 chars max)
  icon?: string;        // Optional inline SVG icon
  priority: number;     // Higher = more visible. >=80 gets warning styling
  ttlMs: number;        // Time-to-live in ms (0 = persistent until removed)
  createdAt: number;    // Timestamp when added
  onClick?: () => void; // Optional click handler
}
```

### Actions

| Method | Description |
|--------|-------------|
| `addMessage(msg)` | Add or replace a message (by id + pluginId). Resets TTL on replace. |
| `removeMessage(id, pluginId)` | Remove a specific message |
| `removeAllForPlugin(pluginId)` | Remove all messages from a plugin |
| `clear()` | Clear all messages and stop timers |

### Queries

| Method | Description |
|--------|-------------|
| `getCurrentMessage()` | Get the highest-priority non-expired message (rotates among equal-priority) |
| `getAll()` | Get all active (non-expired) messages |

### Internals

- **Rotation:** Messages at the same priority level rotate every 5 seconds.
- **Scavenging:** Expired messages (past TTL) are cleaned up every 1 second.
- **StatusBar integration:** The `claude-usage` ticker message (pluginId `"claude-usage"`) is absorbed into the agent badge when the active terminal runs Claude, and suppressed from the separate ticker area.

---

## notesStore

**File:** `src/stores/notes.ts`

Persistent notes/ideas with per-repo tagging and usage tracking.

### Note Type

```typescript
interface Note {
  id: string;
  text: string;
  createdAt: number;
  repoPath: string | null;
  repoDisplayName: string | null;
  usedAt: number | null;      // Timestamp when sent to terminal
}
```

### Actions

| Method | Description |
|--------|-------------|
| `hydrate()` | Load notes from Rust backend |
| `addNote(text, repoPath?, repoDisplayName?)` | Add a new note, optionally tagged with a repo |
| `removeNote(id)` | Remove a note by ID |
| `reassignNote(id, repoPath, repoDisplayName)` | Reassign a note to a different project |
| `markUsed(id)` | Mark a note as used (sets `usedAt` timestamp) |

### Queries

| Method | Description |
|--------|-------------|
| `getFilteredNotes(activeRepo)` | Get notes for repo (global + repo-specific). `null` = all notes. |
| `filteredCount(activeRepo)` | Count of notes visible for the given repo filter |
| `count()` | Total note count |

---

## Other Stores

### conversationStore (`conversationStore.ts`)

Owns the per-terminal AI Chat and autonomous-agent conversation state. Each
terminal key has independent messages, streaming state, conversation ID, usage,
tool calls, and approval state; the exported accessors follow the active terminal.

Conversation persistence always uses the shared `invoke` transport: desktop calls
the Tauri IPC commands, while browser/PWA clients use the matching HTTP routes with
the same request and response shapes. Messages autosave after a 500 ms debounce,
terminal close performs an immediate save, and initialization restores the newest
saved conversation for the terminal session. History list, load, and delete use the
same transport path. A load is discarded if the local message array changed while
the backend read was in flight, preventing stale history from erasing a newer turn.

### repoSettingsStore (`repoSettings.ts`)
Per-repository settings (base branch, scripts, worktree options).

### uiStore (`ui.ts`)
Panel visibility (sidebar, diff, markdown, notes, file browser), sidebar width, dropdown state, loading state.

### notificationsStore (`notifications.ts`)
Notification sound preferences and playback. Remote orchestration muting uses
the terminal's backend-preserved `isRemote` origin; completion lifecycle code
sets a per-busy-cycle latch before playback so idle and exit cannot both chime.

### dictationStore (`dictation.ts`)
Whisper dictation config, model management, recording state.

### errorHandlingStore (`errorHandling.ts`)
Error retry configuration and active retry tracking.

### rateLimitStore (`ratelimit.ts`)
Active rate limit tracking per session.

### tasksStore (`tasks.ts`)
Agent task queue management.

### promptStore (`prompt.ts`)
Active prompt overlay state and agent stats buffer.

### diffTabsStore (`diffTabs.ts`) / mdTabsStore (`mdTabs.ts`)
Open diff and markdown tab management (identical API patterns).

### updaterStore (`updater.ts`)
App update check, download, and install. Supports stable (Tauri built-in), beta, and nightly channels.

### keybindingsStore (`keybindings.ts`)
Rebindable keyboard shortcuts (persisted, auto-populated from action registry).

### commandPaletteStore (`commandPalette.ts`)
Command palette visibility and search state.

### activityDashboardStore (`activityDashboard.ts`)
Activity center (bell dropdown) visibility.

### prNotificationsStore (`prNotifications.ts`)
PR state transition notifications (merged, closed, blocked, CI failed, etc.).

### userActivityStore (`userActivity.ts`)
Tracks last user activity timestamp. Used for merged PR grace period calculations.

### worktreeManagerStore (`worktreeManager.ts`)
Worktree Manager overlay state and selection.

**State Shape:**

| Field | Type | Description |
|-------|------|-------------|
| `isOpen` | `boolean` | Overlay visibility |
| `selectedIds` | `Set<string>` | Multi-select worktree IDs |
| `repoFilter` | `string \| null` | Filter by repo path |
| `textFilter` | `string` | Free-text search filter |

**Actions:** `open()`, `close()` (resets all state), `toggle()`, `toggleSelect(id)`, `selectAll(ids)`, `clearSelection()`, `setRepoFilter(path)`, `setTextFilter(text)`.

### agentConfigsStore (`agentConfigs.ts`)
Per-agent configuration (spawn args, environment overrides).

### editorTabsStore (`editorTabs.ts`)
Open code editor tabs (CodeEditorTab).

### activityStore (`activityStore.ts`)
Session activity history and timeline data.

### branchSwitcher (`branchSwitcher.ts`)
Branch switch state and loading indicators.

### terminalOwnership (`terminalOwnership.ts`)
Which repo owns a terminal. `TerminalData.repoPath` is the record; the branch
`terminals[]` arrays are a display index derived from it, so a wrong placement is
repairable instead of permanent. `null` means no registered repo claimed the cwd —
the tab is parked in whatever repo was active so it stays visible, and the null
marks the placement as a guess.

| Function | Use |
|---|---|
| `reconcileTerminalOwnership(terminalId?)` | Ask "who owns this?" again. For answers that genuinely changed: repos loaded, one added or removed, a worktree appeared, a branch renamed. Omit the id to sweep every terminal. |
| `reclaimParkedTerminal(terminalId)` | The only thing an OSC 7 cwd change may trigger. No-op unless `repoPath === null`. |

**A `cd` does not re-home an owned tab.** The tab belongs to the repo it was
opened in; the directory the shell sits in does not revoke that. Calling the full
reconcile from the cwd handler moved tabs out from under the user, because three
states answer "where am I" and only one moved: `activeRepoPath` stayed put, so the
sidebar and the tab bar (which filters on it) kept showing the old repo while the
tab left the strip — and `TerminalArea` renders on `terminalsStore.activeId` alone,
so the pane went on drawing a terminal belonging to a repo nobody had selected.
Agents `cd` across repos constantly, which is why it read as the app switching repo
on its own. Only a parked tab is settled by a `cd`, because for it the question was
still open.

**Parking says which repo is missing.** An MCP-spawned agent inherits its parent's
cwd, so sessions land in worktrees of repos the user never registered; the tab was
then filed under whichever repo had focus, and the only trace was a warning naming
the cwd. `unregisteredRepoRootFor(cwd)` (`utils/repoOwnership.ts`) turns that cwd
into the directory to register — `…/gate-os__wt/poc-0001` → `…/gate-os` via the
`__wt` convention, otherwise the path itself — and `assignSessionToRepoBranch`
puts it in the warning and in one deduped toast. It is a guess for the user to act
on, never a placement: `resolveRepoOwnerIn` remains the single answer to "who owns
this tab", and registering the repo lets `reconcileTerminalOwnership` move the tab
home by itself. Auto-registering instead was rejected — `addRepository` calls
`setActive()`, which would yank the user's focused repo from a background event,
the exact failure the paragraph above describes.

### contextMenuActionsStore (`contextMenuActionsStore.ts`)
Dynamic context menu action registration.

### errorLog (`errorLog.ts`)
Error ring buffer and error panel state.

### pluginStore (`pluginStore.ts`)
Loaded plugin instances and lifecycle state.

### registryStore (`registryStore.ts`)
Remote plugin registry cache and install state.

### repoDefaults (`repoDefaults.ts`)
Default settings applied to newly added repositories.

### tabManager (`tabManager.ts`)
Tab ordering, branch-key mapping, and tab persistence logic.

**Exclusive pane activation.** TerminalArea renders terminals, diffs, markdown and
editors as four independent `For` lists, each marking its pane `active` from its
OWN store's `activeId` — so "only one pane shows" is a cross-store invariant.
`createTabManager` registers a deactivator per store (`registerPaneDeactivator`);
`terminals.ts` registers its own since it doesn't use the factory. Activating a
tab — `setActive(id)` with a non-null id, or `_addTab` — calls
`activatePaneExclusively(storeName)`, which clears every other store's `activeId`.
`setActive(null)` and the `_addTabBackground` variants are local: a background
open must not yank the user out of the pane they're in.

Call sites therefore must NOT hand-roll `setActive(null)` on the other stores.
This replaced the `useTabActivationSync` hook, which enforced the same rule from
deferred `on(activeId)` effects: an effect keyed on a *change* cannot enforce an
invariant that has to hold on every activation *request*, so re-activating an
already-active tab (Edit on a file whose editor tab was already the active one)
wrote the same value, fired nothing, and left the other pane rendered underneath.
Pinned by `src/__tests__/stores/paneExclusivity.test.ts`.

### appLogger (`appLogger.ts`)
Centralized logging — replaces direct `console.*` calls. Writes to ring buffer, forwards to console, and surfaces in ErrorLogPanel.

### debugRegistry (`debugRegistry.ts`)
Dynamic snapshot registry for MCP `invoke_js` introspection. Stores self-register a snapshot function at init time, exposed on `window.__TUIC__` as `stores()` (list names) and `store(name)` (get snapshot).

**Registered stores:** github, globalWorkspace, keybindings, notes, paneLayout, repositories, settings, tasks, ui.

**Adding a new store** — append 2 lines at the end of the store file:
```ts
import { registerDebugSnapshot } from "./debugRegistry";
registerDebugSnapshot("storeName", () => ({ /* fields to expose */ }));
```
Each store decides what to expose — no need to modify `debugGlobals.ts`.
