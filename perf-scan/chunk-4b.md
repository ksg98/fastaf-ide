# Chunk 4b — the app's most-read stores (settings / ui / paneLayout), terminal lifecycle, unopened stores

Methodology, severity and verification ladder: see `performance_scan.md`.
Reserved finding range: **F70-F79**. Owner: opus agent. Date: 2026-08-16.

Continues chunk 4's "Not covered" list. Framework facts established there
(memos are eager, store writes are equality-guarded per field, a write on a
terminal path segment replaces instead of merging, `For` keys by item
reference) are used, not re-derived. Canvas/grid (chunk 3), AI streaming and
`conversationStore` (chunk 2b), repo watcher and git panels (chunk 5) and the
status-bar ticker (F50) are out of scope.

## Framework facts added by this pass

Two more, read from `node_modules/solid-js/store/dist/store.cjs`, because three
findings below rest on them:

- **`Object.keys` / `Object.values` / `Object.entries` on a store node subscribe
  to that node's `$SELF`** (`ownKeys` → `trackSelf`, `:91-97`), and `setProperty`
  notifies `$SELF` on **every** direct property write to that node (`:150`). So
  `Object.keys(state.terminals)` wakes on add/remove/whole-node replace, but not
  on a write *inside* a terminal — `setState("terminals", id, partial)` reaches
  `mergeStoreNode` and lands per field.
- **`setState(wholeObject)` at the store root merges per key, and each key is a
  wholesale replace.** `updatePath` with `part === undefined` calls
  `mergeStoreNode(root, value)` (`:222`), which calls `setProperty(root, key, …)`
  per key. A freshly allocated `{}` therefore **fails** the `state[property] ===
  value` guard every time. This is what makes F71 a finding.

## Cardinality baseline (measured on this machine, 2026-08-16)

| Quantity | Value | Source |
|---|---|---|
| Live PTY sessions → mounted `CanvasTerminal`s | 9 | chunk 4's baseline; `TerminalArea.tsx:145` mounts one `<Terminal>` per id, `Terminal.tsx:1201` one `CanvasTerminal` per live session |
| `pane-layout.json` | `{"activeGroupId":null,"groups":{},"root":null}` (59 B) | config dir |
| Repos with `auto_consolidate_worktrees: true` | **0 of 15** | `repo-settings.json` |
| `repo-settings.json` | 15 repos × 19 fields | config dir |
| `prompt-library.json` | 30 prompts, 24 KB | config dir |
| `settingsStore.hydrate()` store writes | 45, unbatched | `settings.ts:564-615` |
| `uiStore.hydrate()` store writes | 16, unbatched | `ui.ts:232-285` |
| `saveUIPrefs()` call sites | 15 | `ui.ts` |
| Branch entries across all repos | 56 | chunk 4's baseline |

So **split panes and the global workspace are both unused in Boss's current
configuration** — F70 and F71's amplitude is stated against that fact, not
around it.

## Files evaluated

| File | Date | Verdict |
|---|---|---|
| `src/stores/settings.ts` (whole) | 2026-08-16 | clean on write granularity — see "Clean, worth recording"; contributes to F74 |
| `src/stores/ui.ts` (whole) | 2026-08-16 | F72, F75 |
| `src/stores/paneLayout.ts` (whole) | 2026-08-16 | F70, F71 |
| `src/stores/keybindings.ts` (whole) | 2026-08-16 | clean (plain `Map`s + one version signal, O(1) per-keystroke lookup) |
| `src/stores/globalWorkspace.ts` (whole) | 2026-08-16 | contributes to F70 |
| `src/stores/repoSettings.ts` (whole) | 2026-08-16 | F73 |
| `src/stores/mdTabs.ts` (whole) | 2026-08-16 | clean (dedup-on-open, per-field writes) |
| `src/stores/tabManager.ts` (whole) | 2026-08-16 | clean (`produce` for multi-field, per-field elsewhere) |
| `src/stores/promptLibrary.ts` (60-190, 300-360) | 2026-08-16 | clean (debounced 500 ms; `getSmartPrompts` memo not woken by `markAsUsed`) |
| `src/stores/remoteConnections.ts` (whole) | 2026-08-16 | clean (health poll starts/stops with the connection) |
| `src/stores/tunnels.ts` (150-230) | 2026-08-16 | clean-enough — see Open questions |
| `src/stores/dictation.ts` (120-220) | 2026-08-16 | already judged by chunk 2 (`clean`, poll bounded to recording); see Open questions |
| `src/stores/savedPaneLayouts.ts` | 2026-08-16 | clean-enough (session-scoped `Map`, see note) |
| `src/hooks/useTerminalLifecycle.ts` (whole) | 2026-08-16 | clean — the branch-switch teardown is not here, see F70/F71 |
| `src/hooks/git/createBranchSelectionCoordinator.ts` (whole) | 2026-08-16 | F71 |
| `src/hooks/useWorktreeConsolidation.ts` (whole) | 2026-08-16 | clean (idempotent, and 0 repos enable it) |
| `src/hooks/useAppBootstrap.ts` / `useAppInit.ts` (265-300, 760-800) | 2026-08-16 | hydration ordering; see "Clean, worth recording" |
| `src/components/PaneTree/PaneTree.tsx` (whole) | 2026-08-16 | contributes to F70 |
| `src/components/TerminalArea.tsx` (whole) | 2026-08-16 | contributes to F73; cross-ref F21 |
| `src/components/ui/PanelResizeHandle.tsx` | 2026-08-16 | contributes to F72 |
| `src/components/Sidebar/Sidebar.tsx` (183-223) | 2026-08-16 | clean (CSS var during drag, one IPC at drag-end) |
| `src/components/Terminal/CanvasTerminal.tsx` (2840-2870, 3019-3030) | 2026-08-16 | F74 |
| `src/components/Terminal/canvasTerminalTouch.ts` (100-165) | 2026-08-16 | contributes to F74 |
| `src-tauri/src/config.rs` (1915-1922, 2168-2192) | 2026-08-16 | contributes to F72 |
| `node_modules/solid-js/store/dist/store.cjs` (91-230) | 2026-08-16 | framework facts above |

## Findings

### F70 — `paneLayoutStore.restore()` disposes and re-creates every pane's content, including every mounted `CanvasTerminal` (P3)

`restore()` (`paneLayout.ts:564-578`) does two things, and **both** force a full
rebuild of the pane subtree:

```ts
tree = saved.root;                                   // :572  new plain-JS node objects
bumpTree();                                          // :573
setState({ groups: saved.groups, activeGroupId: … }); // :574  wholesale node replace
```

- The tree is plain JS, so `saved.root` and every node under it are new object
  identities. `PaneBranchView`'s `<For each={props.branch.children}>`
  (`PaneTree.tsx:155`) keys by item reference → every child is "new" → each
  `PaneGroupView` is disposed and re-created.
- Independently, `setState({groups: …})` reaches `mergeStoreNode` →
  `setProperty(root, "groups", saved.groups)`. `saved.groups` is a different
  object, so the guard misses and the whole node is replaced: new proxies for
  every group and every `PaneTab`. `aliveTabs()` (`PaneTree.tsx:198-207`)
  therefore returns all-new items, and `<For each={aliveTabs()}>`
  (`PaneTree.tsx:369`) rebuilds every `PaneTabContent`.

Either path disposes `TerminalPane` → `<Terminal>` → `<Show keyed>` →
`CanvasTerminal` (`Terminal.tsx:1201`), i.e. a canvas teardown, glyph-atlas
rebuild, grid-channel unsubscribe/resubscribe and full repaint **per pane**.
Verified by construction from the Solid source, not observed at runtime.

Where it hurts is not the branch switch — `restore` there is replacing content
that genuinely changed — but `globalWorkspaceStore`:
`syncToPaneStore()` (`globalWorkspace.ts:138-143`) calls `restore(current)`
whenever the workspace is on screen, and it is called from `promote`
(`:240`), `unpromote` (`:259`), `setScope` (`:341`) and `syncScopeMembers`
(`:384`). **Promoting one terminal into a visible global workspace remounts
every terminal already in it.**

Note the asymmetry this creates: outside split mode, `TerminalArea.tsx:145`
keeps every terminal mounted permanently and only toggles a CSS class, so a
branch switch remounts nothing. Inside split mode, the same switch remounts
everything.

P3 and not higher because the trigger is opt-in and unused in the current
configuration (`pane-layout.json` is empty; 0 of 15 repos enable
`auto_consolidate_worktrees`). The per-event cost is high, the event count is
currently zero. Fix is `reconcile` on the groups node plus keying the tree
`For` on node identity that survives a round-trip — not a new store.

### F71 — every branch select rewrites `pane-layout.json` and re-notifies the layout graph, even when there is no split and nothing changed (P3)

`paneLayoutStore.reset()` (`paneLayout.ts:599-608`) is unconditional:

```ts
tree = null; restoredFromDisk = false;
bumpTree();                                     // :602
setState({ groups: {}, activeGroupId: null });  // :603-606
scheduleSave();                                 // :607
```

Three separate wastes when the store is *already* empty, which is the default
state on this machine:

1. `{}` is freshly allocated, so `setProperty`'s `state[property] === value`
   guard (`store.cjs:134`) never fires — the `groups` node is replaced and its
   `$SELF` notified on every call.
2. `bumpTree()` invalidates every `treeRevision()` subscriber even though the
   tree was already `null`. Subscribers: `isSplit()` (11 reactive call sites,
   incl. `TerminalArea.tsx:76,106,120,138`, `Terminal.tsx:864` **per terminal**,
   `TabViews.tsx:40` **per tab**, `TabBar.tsx:102,108,384`), plus `getRoot()`,
   `canSplit()`, `getAllGroupIds()`, `getGroupForTab()`.
3. `scheduleSave()` schedules `invoke("save_pane_layout")` 500 ms later. On the
   Rust side that is a file read + parse, the global `CONFIG_WRITE_LOCK`, a
   cross-process file lock and an atomic write — to store bytes identical to
   what is already there.

`createBranchSelectionCoordinator.ts` calls `reset()` on the common path:
`:216` (terminals exist, no saved layout — the default), plus `:203`, `:213`,
`:272`, `:295`, `:308`, `:313`. So it runs on essentially **every** branch
select. Rate is user-driven (sidebar click, command palette, quick switcher,
worktree prompt), not automatic — which is why this is P3 and not P2.

An early return when `tree === null && activeGroupId === null && groups` is
already empty removes all three at once.

### F72 — `saveUIPrefs()` is the only undebounced persist of the three mandated stores, and 4 of the 16 fields it writes are dead state (P3)

`ui.ts:135-156` fires `invoke("save_ui_prefs", …)` synchronously from **15**
call sites, with no debounce — unlike `settingsStore.save()`
(`settings.ts:527-541`, 500 ms) and `paneLayoutStore.scheduleSave()`
(`paneLayout.ts:300-321`, 500 ms), which both coalesce. Every panel toggle goes
through `setExclusivePanel` (`ui.ts:180-193`) and therefore pays one.

The Rust cost per call (`config.rs:2174-2179` → `save_checked`,
`config.rs:1915-1922`) is: `file.load()` (read + parse), the global
`CONFIG_WRITE_LOCK` (shared with `save_app_config` and every other config
writer), a cross-process file lock, a stamp `stat`, then `write_atomic`. It runs
on a tokio worker, so it does not block the WebView — but it does serialize
against concurrent config writes.

Separately, four of the sixteen serialized fields are **dead**:
`markdownPanelWidth`, `notesPanelWidth`, `gitPanelWidth`, `aiChatPanelWidth`
(`ui.ts:68-71`) are written by `hydrate` (`:255-266`) and `resetLayout`
(`:512-515`) and read by nothing — grepping `src/` outside `ui.ts` and its tests
returns zero consumers. The reason is visible at
`PanelResizeHandle.tsx:36`: the handle sets `panel.style.width` inline and never
tells the store, so the setters at `ui.ts:388,484,489,494` have no callers
either. (Consequence outside this scan's scope: right-panel widths do not
survive a restart.)

Fix is the existing debounce pattern plus deleting four fields and four setters.

### F73 — `repoSettingsStore.getEffective()` allocates a 24-field object and subscribes to ~50 signals to serve call sites that read one field (P3)

`getEffective(path)` (`repoSettings.ts:246-284`) is a plain function, not a memo.
Each call reads ~22 fields off `settings[path]`, up to 10 off
`localConfigs[path]`, ~15 off `repoDefaultsStore.state` and 3 off
`settingsStore.state` (`:279-281`), then allocates a fresh 24-field object.

Called from a reactive scope, the caller subscribes to **all** of those, and
because the return value is a fresh object it can never be compared by identity
downstream. 25 call sites; the reactive ones are the problem:

| Site | Instances | Reads |
|---|---|---|
| `RepoSection.tsx:238-240` | one memo **per branch row** — 56 measured | `branchLabels?.[name]` |
| `TerminalArea.tsx:150-154` | one memo **per terminal** — 9 | `terminalMetaHotkeys` |
| `PaneTree.tsx:445-449` | one memo per pane terminal | `terminalMetaHotkeys` |
| `PrSection.tsx:60,72`, `RemoteOnlyPrPopover.tsx:155,191`, `GitHubPanel.tsx:165`, `WorktreeManager.tsx:298` | per repo/PR row | one field each |

So a single write to any of ~50 fields re-runs ≥65 memos, each allocating a
24-field object, to recompute values that mostly did not change.

The *rate* is low and I am not claiming otherwise: every writer is user-driven
(settings panels), and the one automatic writer I traced —
`loadLocalConfig` on each `repo-changed` (`useAppInit.ts:381`) — is **free**,
because `setState("localConfigs", path, cfg)` lands on `mergeStoreNode` and, for
the repos here that have no `.tuic.json`, on `setProperty(…, null)` whose
equality guard fires. This is filed as structural (P3): fan-in width and
allocation, not a hot loop. Fix is per-field accessors
(`getEffectiveField(path, "terminalMetaHotkeys")`) or a memo keyed on `path`.

### F74 — pinch-zoom writes the *global* font size, so one gesture invalidates the glyph atlas of every mounted terminal (P3)

`CanvasTerminal.tsx:3019-3030` is one effect per mounted `CanvasTerminal`,
subscribing to five signals:

```ts
terminalsStore.state.terminals[props.terminalId]?.fontSize;
settingsStore.state.defaultFontSize;
settingsStore.state.font;
settingsStore.state.fontWeight;
settingsStore.state.theme;
… invalidateGlyphCache(); gridRenderer?.invalidateCaches();
   fullRepaintNeeded = true; remeasure();
```

Four of the five are **global**, so any write to them rebuilds the glyph atlas
and forces a full repaint on **all 9** mounted terminals, not just the visible
one. For a Settings change that is correct and necessary. For zoom it is not,
and the two zoom paths disagree:

- Keyboard zoom (`useTerminalLifecycle.ts:53-58`) writes
  `terminalsStore.setFontSize(activeId, …)` — per terminal, wakes one effect.
- Touch pinch (`CanvasTerminal.tsx:2863-2866`) writes
  `settingsStore.setDefaultFontSize(next)` — global, wakes all nine.

`canvasTerminalTouch.ts:118-126` fires `onFontSizeChange` from every
`touchmove` with a >2 % scale delta; `Math.round` + the `next !== cur` guard cap
it at one write per integer step, so a full 8→32 pinch is ≤24 writes — but they
land inside one gesture, each costing 9 atlas invalidations + 9 remeasures.
Upper bound ≈ 216 atlas rebuilds per pinch (derived from the code and the
measured terminal count; **not profiled**).

P3 because the trigger is touch-only (the handlers bind `touchstart`/`touchmove`
at `canvasTerminalTouch.ts:158-160`; a macOS trackpad pinch does not produce
`TouchEvent`s), so it affects the iPad/PWA path, not Boss's desktop. The fix is
to make pinch write the per-terminal `fontSize` like the keyboard path already
does, which also removes the pointless `save()` debounce restart per step.

### F75 — a leftover debug `warn` captures a stack trace on every markdown-panel open and feeds it into the user-facing log ring (P3)

`ui.ts:180-183`:

```ts
if (key === "markdownPanelVisible" && visible) {
    appLogger.warn("store", `MarkdownPanel OPEN triggered`, { stack: new Error().stack });
}
```

and `ui.ts:239-241`, which warns whenever `markdown_panel_visible` is `true` on
disk at hydrate. Neither is conditioned on `isPerfDebug()`; both are plain
instrumentation left behind.

Two costs, both small but both wrong by policy:

- `new Error().stack` forces a stack capture on a routine user action (Cmd+M /
  toolbar / native menu — `useAppShortcutHandlers.ts:105`,
  `useNativeMenuBridge.ts:123`, `App.tsx:955`, `PanelOrchestrator.tsx:41`).
- `warn` lands in `appLogger`'s **user** ring and bumps `revision`
  (`appLogger.ts:284-293`), which is precisely the F31 trigger: both
  `ErrorLogPanel` memos re-run, each allocating a 1500-slot merge, with the
  panel closed. So opening the markdown panel pays F31's ~3000 element writes
  as a side effect, and the user's error log shows a line that is not an error.

Recorded here rather than as a style note because the user/diagnostic pool split
is itself the efficiency mechanism (same reasoning as F35).

## Clean, worth recording

Read looking for the antipatterns in the brief and **did not** have them:

- **`settings.ts` is the model for a config store.** Every setter writes exactly
  one field and calls one shared debounced `save()` (`:527-541`, 500 ms).
  `persist()` (`:516-525`) does a fresh load-modify-save through
  `updateAppConfig` and touches only the fields this store owns
  (`applyOwnedFields`, `:462-509`) — the comment at `:453-461` documents why.
  A hydrate guard (`:451`, `:529-535`) blocks persistence until a successful
  load. Blast radius is tiny: the most-read field, `defaultFontSize`, has 13
  reader sites; 27 of the 41 fields have ≤2.
- **`ui.ts` reactive fan-out is negligible.** No field has more than 5 reader
  sites; the exclusive-panel writes are wrapped in `batch()` (`:184-191`), and
  `clearDetached` uses `reconcile` (`:408`).
- **Sidebar resize is already correct.** `Sidebar.tsx:198-214` drives a CSS
  variable during the drag and calls `setSidebarWidth` exactly once at
  mouse-up. `setSettingsNavWidth` (`ui.ts:499-501`) deliberately does **not**
  persist — a prior "IPC storm fix", per `__tests__/stores/ui.test.ts:332`.
- **`keybindings.ts` keeps the hot path off the reactive graph.** Two plain
  `Map`s plus one `version` signal; `getActionForCombo` (`:254-258`) is an O(1)
  lookup per keystroke. `rebuildMaps` is O(65) but only runs on hydrate, an
  override, or a plugin command registration — and **no plugin in `plugins/`
  calls `registerCommand`** today, so the dynamic path is dead weight, not cost.
- **`useTerminalLifecycle.ts` holds no burst.** It was chunk 4's prime suspect
  for the branch-switch teardown; the teardown is not there. Its writes are
  per-terminal, its `terminalIds` memo (`:347-349`) is a `Set` intersection over
  ≤50 ids, and `closedTabs` is capped at 10 (`:195-198`). `closeOtherTabs` /
  `closeTabsToRight` run N unbatched closes, but each targets a different
  terminal, so batching would save flush overhead, not work.
- **`useWorktreeConsolidation.ts` is safe by construction.** Its effect calls
  `syncScopeMembers`, which is idempotent and only calls `syncToPaneStore()`
  when membership actually changed (`globalWorkspace.ts:382-384`). And
  `consolidatedRepos()` is empty on this machine (0 of 15 repos), so the effect
  is currently a no-op.
- **The 61 unbatched hydrate writes are cheap *today*, and that is luck, not
  design.** `settings.hydrate` issues 45 sequential `setState` calls
  (`:564-615`) and `ui.hydrate` 16 (`:232-285`), each outside `batch()` — 61
  full `runUpdates`/`completeUpdates` cycles where 2 would do, and any effect
  reading two settings fields runs twice. Every other bootstrapped store uses a
  single write or `produce` (`agentConfigs.ts:67`, `repoSettings.ts:201`,
  `remoteConnections.ts:150`). It costs almost nothing right now only because
  `hydrateStores` runs before any terminal exists (`useAppInit.ts:274-275` vs
  the restore at `:788`), so F74's effect has zero instances to wake. Not filed
  as a finding — filed here so the next person who adds a settings consumer
  knows the flush count is 45, not 1.
- **`savedPaneLayouts`** (`savedPaneLayouts.ts:4`) is a module `Map` with no
  eviction, but it is session-scoped, keyed by repo+branch (≤56 keys), only
  written while split, and holds small structures. Not a leak worth filing.
- **`mdTabs`/`tabManager`** dedup on open, write per field, and use `produce`
  for the multi-field mutations. `getVisibleIds` (`tabManager.ts`) is O(tabs)
  over a single-digit tab count.

## Not covered

- **The `<For each={terminalsStore.getIds()}>` at `TerminalArea.tsx:145` mounts
  every terminal of every repo and branch simultaneously** and hides the
  inactive ones with a CSS class. That is the structural root of chunk 3's F21
  (hidden terminals running the full frame pipeline) and it is what multiplies
  F74 by 9. Deliberately **not** re-filed — the cost analysis is chunk 3's.
- **`repositories.ts` write paths** (`save()` / `saveReposImmediate`,
  `:96-153`). Debounced 500 ms and deep-copying all 38 repos per flush, but its
  call sites are dominated by the repo-watcher cascade, which is chunk 5's.
- **`panelSync.ts` / `panel_window.rs`** — chunk 4's F34 covers the serialise
  half; the Rust window plumbing is still unread by anyone.
- **`updatePluginPanel` / `openUiTab`** write a whole HTML string into the store
  (`mdTabs.ts:284,319`), which replaces an iframe's content. The store write
  itself is per-field and correct; the iframe reload cost belongs to chunk 6b.
- **`diffTabs.ts`, `editorTabs.ts`, `notes.ts`, `agentConfigs.ts`,
  `providerRegistry.ts`, `repoDefaults.ts`, `tabOrdering.ts`** — not opened.
  `tabManager.ts`, which all four tab stores share, was.
- **No profiling was run.** Every quantity above is measured on disk / by grep
  (the cardinality table, the write counts, the call-site counts) or an
  explicitly labelled estimate derived from reading the code. No `SLOW` /
  `UI freeze` line was consulted because no reproduction was driven — F70 and
  F74 both need a scenario Boss's current configuration does not produce.

## Open questions

- **F70 needs one runtime confirmation before a fix.** The remount claim is
  derived from `mapArray`'s reference keying and `mergeStoreNode`'s wholesale
  replace, both read from the Solid source — but it was never observed. The
  cheap check: split a pane, promote a second terminal to the global workspace,
  and count `CanvasTerminal` mounts (or watch for a visible repaint of the pane
  that was *not* touched). If terminals do not remount, F70 collapses to a
  cheap re-render and should be downgraded.
- **Does anything rely on `paneLayoutStore.reset()` being a no-op-safe reset
  rather than idempotent?** F71's fix is an early return when the layout is
  already empty. `consumeRestoredFromDisk()` is the only state `reset()` clears
  besides the layout itself (`:601`), and it is read once per branch select
  (`createBranchSelectionCoordinator.ts:205,261`) — so the guard must clear that
  flag even when it skips the rest. Worth confirming before touching it.
- **`dictation.ts` polls `get_dictation_status` every 75 ms while recording**
  (`:150-157`) — 13 IPC round-trips/s to read one float, in a store that already
  receives pushes on `dictation-partial` (`:141`). Chunk 2 already judged this
  file `clean (poll bounded to recording)` and I am not overturning that from a
  read alone: the bound is real and the window is short. Flagging only because
  the push channel demonstrably exists, which is methodology item A.12.
- **`tunnelsStore.startTunnel`'s status poll has no deadline**
  (`tunnels.ts:186-221`): it clears only on `connected`/`stopped`/`error`. An ssh
  process stuck in `starting` polls at 0.5 Hz forever, and each tick does
  `setState("activeTunnels", id, tunnel)` with a fresh object — a terminal-path
  wholesale replace (the F32 shape). Not filed: the stuck state was not
  observed, and the only consumer is `TunnelsPanel`.
- **Is `repoSettingsStore.getEffective`'s width intentional?** F73 assumes the
  call sites want one field. If some caller depends on the object being a
  consistent snapshot across all 24 fields, per-field accessors would change
  semantics. Every reactive call site I read takes exactly one field off it, but
  the non-reactive ones (`useAutoFetch.ts:50`,
  `createWorktreeCreationCoordinator.ts:120`) take several and would keep the
  object form.
