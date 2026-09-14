# Chunk 6b — Plugin runtime surface (panels, host tiers, watches, Activity)

Methodology, severity and verification ladder: see `performance_scan.md`.
Reserved finding range: **F100-F109**. Owner: opus agent. Date: 2026-08-16.

Mandate is the **steady-state runtime** of the plugin surface. Startup/load cost
is chunk 8's and is deliberately not analysed here (one memory-residency number
sits on that boundary and is flagged as such in F109).

## Files evaluated

| File | Date | Verdict |
|---|---|---|
| `src/components/PluginPanel/PluginPanel.tsx` | 2026-08-16 | F100, F102, F103 |
| `src/components/PluginPanel/tuicSdk.ts` | 2026-08-16 | contributes to F100/F103 |
| `src/components/PluginPanel/pluginBaseStyles.ts` (size only) | 2026-08-16 | contributes to F100 |
| `src/utils/iframeSearch.ts` (size only) | 2026-08-16 | contributes to F100 |
| `src/utils/iframeKeyForwarder.ts` | 2026-08-16 | clean (idempotent install, cleanup on both paths) |
| `src/stores/mdTabs.ts` (245-321) | 2026-08-16 | F100, F106 |
| `src/components/shared/MdTabContent.tsx` | 2026-08-16 | contributes to F102 |
| `src/components/TerminalArea.tsx` (207-221) | 2026-08-16 | F102 |
| `src/styles.css` (96-114) | 2026-08-16 | contributes to F102 |
| `src/plugins/pluginRegistry.ts` (tiers 2b/3b/3d, panel bridge) | 2026-08-16 | F100, F104, F105 |
| `src-tauri/src/plugin_fs.rs` (watch/tail/list, 266-516) | 2026-08-16 | F104; tail clean (clamped, blocking pool) |
| `src/plugins/pluginLoader.ts` | 2026-08-16 | clean — disabled plugins cost nothing at runtime |
| `src/plugins/fileIconRegistry.ts` | 2026-08-16 | contributes to F109 |
| `src/components/FileBrowserPanel/FileIcon.tsx` | 2026-08-16 | F109 |
| `src/stores/activityStore.ts` | 2026-08-16 | F107 |
| `src/components/Toolbar/Toolbar.tsx` (60-195, 596-690) | 2026-08-16 | F108; `<For>` clean (see F107) |
| `plugins/wiz-kanban/main.js` | 2026-08-16 | F101 |
| `plugins/mdkb-dashboard/main.js` | 2026-08-16 | F106 |
| `plugins/build-cleaner`, `rtk-dashboard` (panel update paths) | 2026-08-16 | contributes to F100 (user-triggered only) |
| `plugins/cache-keepalive/main.js` (tail/probe path) | 2026-08-16 | sub-threshold, see below |
| `plugins/at-capacity-retry`, `claude-wakeup` (Activity call sites) | 2026-08-16 | clean (event-driven, not per-tick) |
| `plugins/tuic-vscode-icons/icon-data.js` (size only) | 2026-08-16 | contributes to F109 |

## Findings

### F100 — every `panelHandle.update()` re-emits ~19.6 KB of fixed boilerplate and forces a full iframe document reload (P2)

The update path is: `pluginRegistry.ts:604` (`PanelHandle.update`) →
`mdTabs.ts:316-321` (`updatePluginPanel` writes `tab.html`) →
`PluginPanel.tsx:431-451` (effect tracking `props.tab.html`) →
`injectThemeVars` (`PluginPanel.tsx:118-127`) → `setSrcdoc` →
the `srcdoc` attribute is rewritten → **the iframe navigates**.

There is no incremental path. `injectThemeVars` re-prepends the same three
blobs verbatim on every update. Measured (character counts taken from the
source templates with node, not estimated):

| Blob | Site | chars |
|---|---|---|
| `PLUGIN_BASE_CSS` | `pluginBaseStyles.ts` | 9 144 |
| `TUIC_SDK_SCRIPT` | `tuicSdk.ts:9` | 4 522 |
| `IFRAME_SEARCH_SCRIPT` | `iframeSearch.ts` | 5 964 |
| **fixed injection per update** | | **≈ 19.6 KB** |

on top of the plugin's own HTML. The browser then re-parses the document,
re-executes both scripts, and discards scroll position, focus and every piece
of in-iframe JS state. `panelHandle.send()` (`pluginRegistry.ts:612`) is the
channel that would allow a diff-style update — it exists, is wired end to end
(`PluginPanel.tsx:400-407` ↔ `tuicSdk.ts:64`), and **no shipped plugin uses it
for content**, they all go through `update()`.

Consumers and cadence: `build-cleaner/main.js:534` + `:505` (2 reloads per
scan), `mdkb-dashboard/main.js:541` + `:504` (2 per open), `rtk-dashboard/main.js:306`
(per refresh click) — all user-triggered. `wiz-kanban/main.js:1134` is the
exception: filesystem-triggered, see F101.

### F101 — wiz-kanban rebuilds the whole board (1 list + 22 file reads over IPC) on every filesystem event, into a panel that may be hidden (P2)

`plugins/wiz-kanban/main.js:1261-1267` registers `watchPath` on the stories
directory (Rust debounce 300 ms) and adds its own 500 ms JS debounce
(`:1264-1265`) before calling `refreshBoard` (`:1131`) → `renderCurrentView`
(`:1072`) → `loadStories` (`:119`).

`loadStories` issues one `plugin_list_directory` plus **one `plugin_read_file`
per `*.md`**, in batches of 20 (`:129-136`). Measured on this repo:
`stories/*.md` = **22 files** → 23 IPC round trips per debounced burst, each one
paying a capability check (`plugin_fs.rs:132`), a `validate_within_home`
`canonicalize` (`:61-83`) and a `spawn_blocking` hop. Then the whole board HTML
is rebuilt and pushed through F100's full iframe reload.

During an active wiz session every worklog append and every status transition
writes a story file, so this fires repeatedly, and **nothing on the path checks
whether the panel is visible** — F102 means it usually is not.

Not measured at runtime: the actual event rate on Boss's machine. The per-burst
cost (23 IPC calls) is exact; the burst frequency is not.

### F102 — every plugin panel ever opened stays mounted and live; `display:none` is the only "hiding" (P2)

`TerminalArea.tsx:208-221` renders `<For each={mdTabsStore.getIds()}>` and
mounts `MdTabContent` for **every** md tab unconditionally; the only gate is
`classList={{ active: … }}` against `.terminal-pane { display: none }` /
`.terminal-pane.active { display: block }` (`styles.css:103-114`).
`PaneTree.tsx:470` does the same in split mode.

Nothing ever unmounts a plugin panel except a manual close: `addPluginPanel`
creates the tab with `pinned: true` (`mdTabs.ts:258`), and the one eviction
path, `evictNonPinnedPluginPanelsForOtherRepos` (`TabBar.tsx:461`), skips
pinned tabs by construction.

A `display:none` iframe keeps its document, its timers, its listeners and its
heap. It also keeps receiving host traffic: the two effects at
`PluginPanel.tsx:412-422` post `tuic:repo-changed` on every active-repo change
and `tuic:theme-changed` on every theme switch, to every mounted panel, and it
pays F100's reload in full when its plugin calls `update()`.

Each mounted panel also holds one `window` `"message"` listener
(`PluginPanel.tsx:392-393`); they self-filter correctly on
`event.source !== iframeRef.contentWindow` (`:370`), so this is fan-out, not a
correctness issue — every postMessage from any panel wakes all N handlers.

### F103 — theme extraction walks every CSS rule in the document, twice per panel update, per panel (P3)

`extractThemeVars` (`PluginPanel.tsx:30-61`) and `extractThemeObject`
(`:64-97`) are the same walk twice over: iterate `document.styleSheets`, then
`sheet.cssRules`, testing `rule instanceof CSSStyleRule && rule.selectorText === ":root"`,
then `getComputedStyle(document.documentElement).getPropertyValue(prop)` per
matching property.

Static measurements: `src/**/*.css` contains 3 279 `{` (an order-of-magnitude
proxy for rule count, not an exact count) and exactly **one** `:root` block
(`global.css:196`; `mobile/mobile.css:14` is the mobile bundle), from which the
prefix filter selects **16** of its 79 declarations.

Call sites per panel update:

1. `injectThemeVars` → `extractThemeVars` — once per srcdoc rebuild (F100).
2. `sendSdkInit` → `extractThemeObject` (`:226`) — once per iframe load,
   because the injected SDK posts `tuic:sdk-request` unconditionally at
   `tuicSdk.ts:112` and `handleTuicMessage` answers it with a full
   `sendSdkInit()` (`:251-255`). srcdoc panels take this path too, not just
   URL-mode ones.

So two full-document rule walks per update, plus one `extractThemeObject` per
mounted panel on every theme switch (`:418-422`) — F102 makes that N. The
result changes only when the theme changes; it is a pure cache candidate keyed
on `settingsStore.state.theme`. Cost per walk was **not measured**; it is a
fixed-size DOM traversal whose only input is the stylesheet set.

### F104 — `plugin-fs-change` events are addressed per PLUGIN, not per watch (P3)

`plugin_fs.rs:385` builds the Tauri event name as `plugin-fs-change-{plugin_id}`
and the batch payload (`:488-499`) carries only `{type, path}` — **no watch id
anywhere**. `pluginRegistry.ts:552-560` registers one `listen()` per
`watchPath()` call on that same name.

A plugin holding K watches therefore has K listeners on one event: every batch
from *any* of its watched paths is delivered K times, once per callback, and
each callback has to re-derive by string-prefixing the raw path which of its own
watches it belongs to. The cap is 20 watches per plugin (`plugin_fs.rs:347`), so
the worst case is a 20× fan-out.

Only wiz-kanban watches today (K=1, `main.js:1261`), which is why this is P3
and not higher — it is latent, not active.

Also on this path: each watch is one `RecommendedWatcher` **plus one dedicated
OS thread** (`plugin_fs.rs:396` and `:411`), never shared across paths or
plugins, unlike `dir_watcher`/`repo_watcher`. The debounce loop itself
(`:440-502`) is correct and well batched — chunk 2 already marked it clean.

### F105 — closing a panel from the tab bar orphans its message handler and retains the plugin's closure (P3)

`panelMessageHandlers` (`pluginRegistry.ts:72`) is written at `:600` and
deleted in exactly two places: `PanelHandle.close()` (`:608`) and `clear()`
(`:940`, tests only). The tab-bar close path goes through `mdTabsStore.remove`,
which never calls `PanelHandle.close()`, and `unregister()` (`:787-804`) does
not touch the map either.

Its sibling half of the same bridge, `panelSendChannels`, *is* cleaned up —
`PluginPanel`'s `onCleanup` at `:408`. The two halves of one bridge have
different lifetimes; that asymmetry is the bug.

The Map slot is trivial. The retention is not: the orphaned `onMessage` closure
holds the plugin module's whole scope alive, so an unloaded or hot-reloaded
plugin can never be collected. `pluginLoader.ts:237` cache-busts the dynamic
import with `?t=${Date.now()}` on every hot reload, so each save that reopens a
panel adds one more permanently-retained module graph for the session.

### F106 — `updatePluginPanel` no-ops silently on a dead tab, so a plugin can render forever into nothing (P3)

`mdTabs.ts:316-321` guards with `if (tab && tab.type === "plugin-panel")` and
returns silently otherwise; `PanelHandle.update` (`pluginRegistry.ts:604`)
forwards with no return value and no throw.

`plugins/mdkb-dashboard/main.js:502-508` and `:541` wrap `panelRef.update(html)`
in `try/catch` *specifically* to detect "panel was closed → reopen it". That
catch can never fire. Once the user closes the mdkb tab, `panelRef` stays
truthy and every later `renderPanel` builds the full dashboard HTML
(`renderDashboard` over the whole mdkb dataset) and drops it on the floor — and
the panel never reopens.

Recorded here rather than as a pure correctness note because the wasted work is
caused by the silent guard, and the same guard is what makes it invisible.

Related API-shape note: `OpenPanelOptions.id` (`types.ts:388-390`) is documented
as "Unique panel identifier" and is **never read** — `openPanel`
(`pluginRegistry.ts:595-601`) dedupes on `pluginId + title` only
(`mdTabs.ts:245-255`). Two panels with distinct ids and the same title silently
collapse into one tab.

### F107 — every activity mutation re-serializes and rewrites the entire item list (P3)

`activityStore.ts:117`, `:122`, `:132`, `:146`, `:159` all end with
`saveActivity(state.items)`. `saveActivity` (`:28-34`) debounces 300 ms, then
`toPersistedItems` maps the **whole** array (`:15-17`) and
`invoke("save_activity", …)` (`:20-24`) ships it, rewriting the file whole.

Measured on this machine: `~/Library/Application Support/com.tuic.commander/activity.json`
is **15 442 bytes for 9 items** — 1 715 B/item, dominated by the inline SVG
icons. The ring cap is 500 items (`:112`), which extrapolates to an ~850 KB
payload + full file rewrite per debounce window at the ceiling (extrapolation
from the measured per-item size, **not** observed).

Frequency is what keeps this at P3. The installed plugins mutate Activity on
events, never on a tick: `at-capacity-retry/main.js:141` (`updateDashboard`, on
a retry or a breaker trip), `cache-keepalive/main.js:281`, `claude-wakeup/main.js:135`,
`build-cleaner/main.js:596`/`:588`. The one periodic loop in that set,
`refreshTicker` (`at-capacity-retry/main.js:158-179`, every `tickerIntervalMs`),
writes only the status-bar ticker (F50) and never touches an activity item, and
it stops itself when no retry is pending (`:167-170`). **There is no per-second
Activity Center churn today.**

Also checked, and clean: the Activity `<For>` is *not* the F33 hazard.
`getForSection` (`activityStore.ts:171-180`) is `filter` + `sort`, both of which
preserve element identity, so the store item proxies stay referentially stable
across rebuilds and `<For each={sectionItems()}>` (`Toolbar.tsx:653`) reuses
every row. The single exception is `addItem` on an existing id
(`activityStore.ts:107`, `s.items[idx] = full`), which installs a fresh object
and recreates exactly that one row.

### F108 — the notification badge re-filters and re-sorts the whole item list once per section, on every mutation (P3)

`Toolbar.tsx:178-184` (`visibleActivityCount`) reduces over `activitySections()`
calling `activityStore.getForSection(section.id, repoPath)` and using only
`.length`. Each call is a full `filter` **plus a `sort`** over `state.items`
(`activityStore.ts:172-179`) — the sort is pure waste for a count.

Section count today is 8, none `panelOnly`: 4 core (`App.tsx:419-427`) and 4
plugin (`at-capacity-retry/main.js:420`, `build-cleaner/main.js:682`,
`claude-wakeup/main.js:375`, `cache-keepalive/main.js:711`). So 8 × O(N log N)
where one O(N) pass with per-section counters would do.

`lastItem` (`Toolbar.tsx:190-194` → `getLastItemAcrossStores`, `:70-88`) adds
three more full passes over the same array (`getActive` + two filters + a
`reduce`) plus `prNotificationsStore.getActive()`.

Both are memos on the **always-mounted** Toolbar, so they recompute on every
activity mutation and every `activeRepoPath` change, whether or not the popover
is open. N is 9 today — this is structural (P3), not an amplitude problem, until
the 500-item cap is approached.

### F109 — the file-icon plugin makes every FileBrowser row parse ~1.2 KB of SVG through `innerHTML` (P2)

`FileIcon.tsx:23-33` creates a `createMemo` per row, calls
`fileIconRegistry.resolve` (`fileIconRegistry.ts:39-48`, which invokes the
plugin's `resolveFileIcon` synchronously), and assigns the returned SVG string
to `innerHTML` — an HTML parse + SVG DOM build per row.

Measured on `plugins/tuic-vscode-icons/icon-data.js`: **869 icons, mean 1 185
chars**, against the ~300-byte monochrome fallbacks at `FileIcon.tsx:5-8`. So
the plugin makes each row roughly 4× more markup to parse than the built-in
path.

**No windowing was found** in `FileBrowserPanel.tsx` — the `<For>` at `:1448`
renders every entry, `TreeNode.tsx:91` renders one per expanded node. A
500-entry directory therefore parses ~600 KB of SVG markup on the main thread in
a single render pass (estimate: 500 × the measured 1 185-char mean; not
profiled). `CommandPalette.tsx:289` puts the same component on every search
result row — a path that re-renders per keystroke.

Boundary note (chunk 8 owns load cost): the 1.05 MB `icon-data.js` string table
is *resident* for the process lifetime, not just paid at load. Recorded here for
completeness, not claimed as a chunk-6b finding.

## Clean, or sub-threshold with a measurement

- **Disabled plugins cost nothing at runtime.** `pluginLoader.ts:389-398` skips
  the dynamic `import()` and `pluginRegistry.register()` entirely for a disabled
  id — only a `pluginStore` metadata entry is created. The hot-reload handler
  short-circuits them before any IPC (`:284-287`). *Paused* plugins are
  different and correctly cheap: they stay in the dispatch arrays and are
  filtered by a `Set` lookup (`pluginRegistry.ts:99-101`, checked at `:817`,
  `:868`, `:898`).
- **Tier 3i file tail is well-built.** `plugin_read_file_tail_inner`
  (`plugin_fs.rs:291-338`) clamps to 10 MB (`:295-296`), seeks instead of
  reading whole, and runs on the blocking pool. Its only caller,
  `cache-keepalive`, asks for 16 KB × up to 3 files (`main.js:359`, `:481`).
- **Tier 2b git read has no callers.** `getGitBranches`/`getRecentCommits`/
  `getGitDiff` (`pluginRegistry.ts:340-362`) are not used by any plugin in
  `plugins/`. Payload shape is a thin pass-through; `getGitDiff` returns the
  full diff as one string, which is worth remembering if a plugin ever adopts
  it, but there is nothing to measure today.
- **cache-keepalive's TTL re-probe, measured and below the bar.**
  `probeCacheTtl` (`main.js:456-503`) re-runs on *every* `shell-state → idle`
  transition while `detectedTtlMs === null` (`:864-866`); the `probingTtl` flag
  is released in `finally` (`:500-501`) and `detectTtlFromUsage` (`:91-100`)
  returns null whenever `usage.cache_creation` is absent, so a session that
  never reports a TTL marker re-probes forever: 1 `claude_project_dir` +
  1 mtime-sorted `plugin_list_directory` (stats every JSONL) + up to 3 × 16 KB
  `readFileTail`, then a `JSON.parse` per line. **Measured** on the live
  orchestrator instance (`GET :9876/logs?limit=5000`, full ring, 1 000 entries
  spanning 26.04 h): 108 `Shell state → idle` transitions = **4.1/h aggregate
  across 12 sessions**. Worst case ≈ 200 KB/h of IPC. Real, but an order of
  magnitude below anything else in this chunk — recorded, not filed.
- **`iframeKeyForwarder` is leak-free.** `installKeyForwarder`
  (`PluginPanel.tsx:213-219`) disposes the previous listener before attaching,
  and it is called from both `onLoad` and the `sdk-request` reply, so the
  double-install on srcdoc panels nets out to one live listener.
- **`injectSdkIntoUrlIframe` correctly skips srcdoc panels.** The
  `doc.getElementById("tuic-sdk")` guard (`PluginPanel.tsx:202`) matches the id
  already present in the injected `TUIC_SDK_SCRIPT` (`tuicSdk.ts:9`), so the
  10.5 KB `createContextualFragment` never runs twice.

## Not covered

- **Plugin load cost at startup** — explicitly chunk 8's, not touched. F109's
  residency note is the only place the boundary is approached, and it is labelled.
- **`sidebarPluginStore` / `markdownProviderRegistry` / `filePreviewRegistry` /
  `contextMenuActionsStore` render paths.** The registries were read only far
  enough to confirm `fileIconRegistry` is the one on a per-row path; the sidebar
  panel and markdown provider render loops were not opened.
- **`HtmlPreviewTab`** shares `injectThemeVars`/`srcdoc` mechanics with
  `PluginPanel` (`utils/captureIframe.ts`, `HtmlPreviewTab.tsx` both reference
  srcdoc) but was not read — F100/F103 may extend to it.
- **Rust-side `plugins.rs`** capability check cost per host call
  (`check_plugin_capability` is on every Tier 3 invoke) — not opened.
- **`plugin_http_fetch` / `plugin_exec_cli`** (Tiers 3f/3g) payload sizes and
  concurrency — not analysed.
- **No profiling was run.** Every quantity above is either measured on disk / in
  source (blob sizes, icon count and mean, `activity.json` bytes, story-file
  count, CSS brace count) or measured from the live log ring (the idle-transition
  rate), or an explicitly-labelled extrapolation. Nothing was timed.

## Open questions

- Does `srcdoc` reassignment in WKWebView tear down and rebuild the iframe's
  JS context, or reuse it? F100 assumes a full document navigation (which is the
  spec behaviour for a `srcdoc` attribute change). The difference decides whether
  the fix must be "send a diff over `panelHandle.send()`" or merely "skip the
  write when the HTML is unchanged". Verifiable by logging inside the SDK's IIFE
  and counting executions per `update()`.
- Is F101's wiz-kanban refresh rate actually a problem on Boss's machine? The
  per-burst cost is exact (23 IPC calls); the burst rate was not observed. A
  capture during an active wiz session with the kanban panel open would settle it.
- F102 implies a plugin panel opened in repo A stays mounted while the user works
  in repo B. `evictNonPinnedPluginPanelsForOtherRepos` (`TabBar.tsx:461`) exists
  and would do exactly the right thing — was `pinned: true` at `mdTabs.ts:258`
  chosen deliberately to opt panels *out* of that eviction, or is it incidental?
  The answer decides whether F102's fix is a policy change or a bug fix.
- F105's retention: does Solid/the WebView actually keep the plugin module alive
  through the orphaned closure, or does the module registry already pin it
  regardless? The `?t=` cache-buster means each hot reload creates a *new* module
  record, so the closure is the only thing that could differentiate — worth a
  heap snapshot across ten hot reloads before sizing the fix.
