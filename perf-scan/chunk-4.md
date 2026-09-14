# Chunk 4 — SolidJS store / effect fan-out

Methodology, severity and verification ladder: see `performance_scan.md`.
Reserved finding range: **F30-F39**. Owner: opus agent. Date: 2026-08-16.

Direction of the pass: **store → consumer**. Rust emits, the canvas draw loop,
AI streaming and the git-panel/repo-watcher refresh belong to chunks 2/2b/3/5 and
are not re-derived here.

## Cardinality baseline (measured on this machine, 2026-08-16)

Every "how bad is it" claim below is scaled against these, not invented:

| Quantity | Value | Source |
|---|---|---|
| Live PTY sessions | 9 | `curl :9876/sessions` |
| `list_active_sessions` payload | 6025 bytes | `curl :9876/sessions \| wc -c` |
| Configured repos | 38 (9 parked) | `repositories.json` |
| Repos inside groups | 20, across 3 groups | `repositories.json` `groups[].repoOrder` |
| Branch entries, all repos | 56 | `repositories.json` |
| appLogger ring capacity | 1000 user + 500 diagnostic | `appLogger.ts:97,100` |

## Framework facts established (so findings don't rest on folklore)

- **Solid memos are eager, not lazy.** `createMemo` builds a pure computation
  (`createComputation(fn, value, true, 0)`) and runs `updateComputation(c)`
  immediately (`node_modules/solid-js/dist/solid.cjs:246-256`). A memo whose
  sources change is recomputed even when nothing reads it. This is what makes
  F31 a finding.
- **Solid store writes are equality-guarded.** `setProperty` returns early on
  `state[property] === value` (`node_modules/solid-js/store/dist/store.cjs:134`),
  so re-writing an unchanged field costs a comparison and wakes nobody. This is
  what keeps F30 at P2 instead of P1, and it is why several "coarse-looking"
  `update()` call sites are *not* findings.
- **Store writes on a terminal path segment replace, they do not merge.**
  `setState("a", k1, k2, obj)` installs `obj` wholesale at `a[k1][k2]`; deep merge
  only happens when the object *is* the addressed node. This is F32.
- **`For` keys by item reference** (`mapArray`). A memo that returns freshly
  allocated wrapper objects rebuilds every row. This is F33.

## Files evaluated

| File | Date | Verdict |
|---|---|---|
| `src/stores/terminals.ts` (whole) | 2026-08-16 | clean — see "Clean, worth recording"; contributes to F30 |
| `src/stores/appLogger.ts` (whole) | 2026-08-16 | F35; contributes to F31 |
| `src/stores/repositories.ts` (12-200, 655-935) | 2026-08-16 | contributes to F33 |
| `src/stores/github.ts` (35-170, 296-345) | 2026-08-16 | F32 |
| `src/stores/activityStore.ts` | 2026-08-16 | clean (debounced persist, event-driven) |
| `src/stores/statusBarTicker.ts` | 2026-08-16 | already filed as **F50** (chunk 6) — not re-filed |
| `src/stores/prNotifications.ts` (30-110) | 2026-08-16 | clean (self-stopping timer, per-item writes) |
| `src/stores/pluginStore.ts` | 2026-08-16 | clean (registration-rate only) |
| `src/stores/registryStore.ts` | 2026-08-16 | clean (1 h TTL cache) |
| `src/stores/notifications.ts` (writes) | 2026-08-16 | clean (config-rate) |
| `src/stores/mcpPopup.ts` (`refreshStatus`) | 2026-08-16 | clean-enough (10 s, gated on popup open) |
| `src/stores/conversationStore.ts` (primitives only) | 2026-08-16 | deferred to chunk 2b — see "Not covered" |
| `src/hooks/useAgentPolling.ts` (whole) | 2026-08-16 | F30 |
| `src/hooks/useSystemLifecycle.ts` | 2026-08-16 | clean (short-circuit + edge guard) |
| `src/hooks/useDetachedPanelBridge.ts` | 2026-08-16 | clean (starts/stops with detach) |
| `src/hooks/useAppInit.ts` (122-158, 225-275, 300-420, 580-730) | 2026-08-16 | clean; repo-changed path is chunk 5 |
| `src/hooks/useAutoFetch.ts` (50-90) | 2026-08-16 | clean (master timer, per-repo backoff) |
| `src/utils/activitySnapshot.ts` | 2026-08-16 | F34 |
| `src/utils/panelSync.ts` | 2026-08-16 | F34 |
| `src/panelAdapters/activity.tsx` | 2026-08-16 | F34 |
| `src/components/ErrorLogPanel/ErrorLogPanel.tsx` (95-180) | 2026-08-16 | F31 |
| `src/components/Sidebar/Sidebar.tsx` (55-115, 355-385) | 2026-08-16 | F33 |
| `src/components/Sidebar/RepoSection.tsx` (175-280, 630-670) | 2026-08-16 | contributes to F33 |
| `src/components/ActivityDashboard/ActivityDashboard.tsx` (whole) | 2026-08-16 | clean (unmounted when closed) |
| `src/components/StatusBar/StatusBar.tsx` (55-190) | 2026-08-16 | clean (already praised in chunk 6) |
| `src/components/StatusBar/TickerArea.tsx` | 2026-08-16 | see F50 (chunk 6) |
| `src/components/TabBar/TabBar.tsx` / `TabViews.tsx` (reactivity scan) | 2026-08-16 | clean (per-field accessors) |
| `src/components/Terminal/Terminal.tsx` (250-280, 540-745) | 2026-08-16 | clean (edge-triggered); contributes to F30 |
| `src/components/McpPopup/McpPopup.tsx` (20-50) | 2026-08-16 | clean (gated on open) |
| listener-balance sweep, all of `src/` | 2026-08-16 | clean — no leak found, see note |

## Findings

### F30 — desktop has no push lane for session lifecycle, so it polls the full session list at 1 Hz (P2)

`src/hooks/useAgentPolling.ts:311-313` installs `setInterval(syncAgentLifecycleStates, 1_000)`
and never stops it while at least one terminal exists (`:287-289`). Each tick
calls `list_active_sessions` for **every** session (`:87` native, `:89` HTTP),
then walks the response and calls `terminalsStore.update()` once per session
(`:122-131`) with six fields.

The same data already arrives as a **push** in browser mode: the per-session
WebSocket delivers a `state` frame that `transport.ts:2254-2255` routes to
`opts.onStateChange`, which `Terminal.tsx:621-640` applies with the identical
field mapping. Grepping `onStateChange` shows `transport.ts:2254` is its only
producer, and that call site sits in the WS branch — **there is no Tauri
equivalent**. So the desktop app polls for exactly the state the web client gets
pushed. That is an IPC/HTTP-parity inversion as well as a cost: AGENTS.md
requires the two transports to stay consistent, and here the poorer one is the
native one.

Cost, measured where measurable:

- **6025 bytes** per tick for 9 sessions (`curl :9876/sessions | wc -c`) — built
  by `serde_json` in Rust, crossed into the WebView, and `JSON.parse`d, once per
  second, permanently. Scales linearly with session count.
- 9 `terminalsStore.update()` calls per second, each a `batch()` plus up to six
  `setState` writes.

The **reactive** fan-out is small, and deliberately so: `setProperty`'s equality
guard (`store.cjs:134`) drops every unchanged field, so a steady-state session
wakes no consumer. One field escapes the guard — `shellStateRevision` is bumped
*unconditionally* whenever `"shellState" in data` (`terminals.ts:541-546`), even
when `prev === next`. That is up to 9 store writes/s to a field with **no
reactive reader anywhere** (all four consumers — `useAgentPolling.ts:81,106,120`
and `useAppInit.ts:665,705` — read it from untracked timer/init callbacks). Cheap,
but it is pure ceremony on the 1 Hz path.

Not measured: the Rust-side cost of assembling `list_active_sessions`. Sizing
that is the prerequisite for deciding whether this is P2 or P1.

### F31 — the ErrorLogPanel's two memos run for the whole app lifetime, panel closed, on every warning (P3)

`src/App.tsx:1041` mounts `<ErrorLogPanel />` unconditionally. The
`<Show when={isOpen()}>` is *inside* the component's returned JSX
(`ErrorLogPanel.tsx:177`), i.e. **after** `filteredEntries` (`:145`) and
`diagnosticCount` (`:164`) have already been created. Solid memos are eager
(established above), so both recompute whenever their sources change — with the
panel closed and nothing rendering them.

Their shared source is `appLogger`'s `revision` signal, and `revision` bumps on
every `warn` and every `error` (`appLogger.ts:284-293`) — **including the dedup
path** (`:264-270`), which bumps without adding an entry. A repeating warning
therefore drives the memos at its full repeat rate while the ring stays the same
size. `appLogger.diag.warn` shares the counter, so the freeze detector and
`perfTrace`'s `SLOW …` lines feed it too.

Per bump, from the code (estimate, not profiled):

- `filteredEntries` → one `getEntries()`, which allocates
  `new Array(userRing.count + diagRing.count)` (up to **1500**) and merges both
  rings (`appLogger.ts:322-341`), then one full filter pass with four predicates.
- `diagnosticCount` → a **second** `getEntries()` — another 1500-slot allocation
  and merge — plus another full filter, all to produce a number the store already
  holds in O(1) as `diagRing.count`.

So roughly 3000 element writes plus 3000 predicate calls per logged warning,
discarded immediately. Amplitude is small when the app is healthy; it is largest
exactly when the app is misbehaving and logging, which is the wrong correlation.
Fix is two lines: gate both memos on `isOpen()`, and derive `diagnosticCount`
from the ring counter instead of a merge.

### F32 — a single changed PR re-installs every branch's PR object for that repo (P3)

`src/stores/github.ts:73-77`, `updateRepoData`:

```ts
setState("repos", repoPath, "lastPolled", Date.now());
for (const pr of prStatuses) {
    setState("repos", repoPath, "branches", pr.branch, pr);
}
```

`pr` is a freshly deserialised object from the event payload, and the path
addresses `branches[pr.branch]` as a *terminal* segment — so Solid **replaces**
the node rather than merging into it (no `mergeStoreNode` on this path). Every
reader of any field of any branch's PR wakes, even for branches whose PR is
byte-identical to the previous poll. Consumers that re-run: `getCheckSummary`
(`RepoSection.tsx:243`), `activePrStatus` (`:242`), `getAllOpenPrs`/
`getRemoteOnlyPrs`/`myPrsCount`/`otherCount`/`ghBadgeCount` (`:656-670`) — all
per repo section. `lastPolled` is stamped with `Date.now()` and so always
changes; no reactive reader for it was found (`grep lastPolled` → declaration,
writes, and one hydration read at `:416`), so it is dead weight rather than a
wake source.

Frequency is bounded by the Rust poller, which chunk 2 verified as
change-detected (`github_poller.rs` → "clean (change-detected)"), so this fires
on real change only — which is why it is P3. The waste is the *blast radius*:
one branch's CI flipping repaints every PR badge in the repo. Cardinality here:
56 branch entries across 38 repos, so per-repo blast radius is small today; it
grows with monorepo-style repos carrying many open PRs. Fix is a per-field diff
(or `reconcile`) instead of a wholesale node install.

### F33 — `getGroupedLayout()` allocates new wrapper objects, so `For` tears down and rebuilds all 3 group sections and their 20 repo rows (P3)

`repositories.ts:903-921` returns
`{ groups: [{ group, repos }], ungrouped }` — the `{ group, repos }` wrappers are
**allocated fresh on every call**. `Sidebar.tsx:360` renders
`<For each={filteredLayout().groups}>`, and `For`/`mapArray` keys by item
reference, so every wrapper is seen as a new item: each `GroupSection` is
disposed and re-created, taking its nested `<For each={entry.repos}>`
(`Sidebar.tsx:376`) and every `RepoSection` inside it with it. Each `RepoSection`
rebuilds ~10 memos (`RepoSection.tsx:634,636,643,653,655,656,657,658,660,665,670`).
Measured cardinality: **3 groups holding 20 repos** → ~20 component teardowns and
~200 memo re-creations per re-run. (`ungrouped` is unaffected — its items are the
stable `state.repositories[path]` proxies, so `For` matches them.)

How often it re-runs depends on a setting:

- **Filter off** — sources are `state.groupOrder`, `state.groups[gid]`,
  `group.repoOrder`, `state.repositories[path]`, `r.parked`, `state.repoOrder`.
  All change only on repo add/remove/park/reorder or group edits. Rare — but
  drag-reordering the sidebar is precisely a re-run-per-frame interaction.
- **Filter on** (`uiStore.state.repoFilterActiveOnly`, the toolbar filter icon) —
  `filteredLayout` additionally calls `repoIsActive` (`Sidebar.tsx:75`), which
  reads `b.terminals.length` for **every branch of every repo**, subscribing to
  all 56 branch terminal arrays. Opening or closing a terminal in *any* repo then
  rebuilds the whole grouped sidebar.

Filed P3 because the expensive mode is opt-in and I could not confirm it is on in
normal use — see Open questions. Fix is to memoise the wrappers per group id, or
key the `For` on `entry.group.id`.

### F34 — the detached Activity panel serialises a full snapshot every second with no change detection (P3)

`src/panelAdapters/activity.tsx:77-78` declares `syncIntervalMs: 1000` and
`serialize: buildActivitySnapshot`; `panelSync.ts:90` runs `push()` on that
interval, and `push()` (`:66-79`) calls `serialize()` and `emitTo`s the result
**unconditionally** — no comparison against the previously pushed snapshot, no
dirty flag.

`buildActivitySnapshot` (`activitySnapshot.ts:128-167`) walks every attached
terminal (9 today) and allocates a fresh 18-field row object each, calls
`rateLimitStore.isRateLimited` and `globalWorkspaceStore.isPromoted` per row,
reconciles the module-level spine (`:85-95`, an O(n²) `spine.includes` scan —
irrelevant at n=9), and returns a new array. That whole structure is then
JSON-serialised by Tauri and crossed into another webview once per second while
the panel is detached, whether or not a single field moved.

Correctly scoped: `useDetachedPanelBridge.ts:38-46` starts the provider only when
`uiStore.isDetached(id)` and stops it on cleanup, so an attached panel costs
nothing. P3 for that reason. Fix is a cheap snapshot hash/compare before
`emitTo`, which also removes the pointless cross-webview traffic when the user
leaves the panel open on a quiet machine.

Boundary note: chunk 2 listed `panel_window.rs` / `utils/panelSync.ts` as "not
covered". This finding covers only the **store-consumer half** — the serialise +
interval. The Rust window plumbing is still unread by anyone.

### F35 — `appLogger.debug` writes into the *user* pool, defeating the two-pool split it was built to protect (P3)

`push()` defaults `audience = "user"` (`appLogger.ts:257`), and the convenience
`debug()` (`:433-435`) does not override it. So every `appLogger.debug` line lands
in `userRing` (capacity **1000**) and evicts user-facing errors from it. The
file's own header states the opposite intent — "A flood of diagnostic telemetry
… can never crowd out the user-facing signal the ErrorLogPanel shows by default"
(`:12-16`) — and the correct sink exists as `appLogger.diag.debug` (`:449-451`),
but the warm callers do not use it:

- `terminals.ts:251-254` — one per OSC 133 flush, and it eagerly builds a
  template string containing a store read (`state.terminals[id]?.commandBlocks.length`)
  before `push` can decide anything.
- `terminals.ts:277` and `:325` — one per busy→idle cooldown cancel/expire, i.e.
  per agent activity transition. Note `:318-320` guards a *sibling* debug line
  behind `isPerfDebug()` while `:325` is ungated — the same code path, two
  different policies.
- `useAgentPolling.ts:92,180,196,268,275` — on the 1 Hz path from F30 whenever it
  errors.

No reactive fan-out: debug does **not** bump `revision` (`:284-295` covers only
error and warn), so nothing wakes. The cost is ring churn, an unconditional
`console.debug` (`:309-311`), eagerly-built message strings, and — the part that
actually matters — a user-facing log pool that a debug burst can empty. Recorded
here rather than as a pure correctness note because the pool split *is* the
efficiency mechanism and this silently disables it (scope rule, `performance_scan.md:8-11`).

## Clean, worth recording

These were read looking for the antipatterns in the brief and did **not** have
them. Recorded so nobody re-scans them:

- **`terminals.ts` is the model.** `lastDataAt` was deliberately moved out of the
  reactive graph into a plain `Map` with a 5 s batched flush (`:332-357`), and the
  flush interval **stops itself** when the map empties (`:344-350`). OSC 133 block
  completion is buffered and flushed once per animation frame (`:225-257`). The
  `sessionToTerminal` reverse index (`:203`) keeps session→terminal lookup off the
  store. `update()` writes a partial object, so Solid's per-field granularity is
  preserved. Consumers read single fields off `get(id)` (`TabViews.tsx:99-104`),
  which subscribes per field, not per terminal.
- **`ActivityDashboard` is correctly unmounted, not just hidden.** `App.tsx:1021`
  wraps it in `<Show when={… && activityDashboardStore.state.isOpen}>` with the
  comment "unmount when closed to release memos/subscriptions". Its `orderedIds` /
  `storeTerminals` memos read every field of every terminal and would be a real
  fan-out problem if the component stayed mounted — the exact mistake F31 records
  for `ErrorLogPanel`. Same pattern, opposite outcome.
- **Timer discipline is generally good.** `prNotifications.ts:58-77` stops its own
  1 Hz tick when no active notification remains and only writes per-item
  (`setState("notifications", predicate, "focusedTimeMs", …)`).
  `useSystemLifecycle.ts:17` short-circuits so `isAnyBusy()` is never subscribed
  when the setting is off, plus an edge guard. `McpPopup.tsx:23-39` and
  `useDetachedPanelBridge.ts:38-46` gate on open/detached with `onCleanup`.
  `useAutoFetch.ts` uses one master timer with per-repo backoff.
- **`getRevision` compliance is good.** Every repo-dependent panel found uses
  `repositoriesStore.getRevision(repoPath)` inside its effect: all six GitPanel
  tabs, `CodeEditorTab`, `DiffTab`, `BranchDiffScrollView`, `MarkdownPanel`,
  `MarkdownTab`, `HtmlPreviewTab`, `FileBrowserPanel`, `AiTriagePanel`,
  `GithubOpsDashboard`, `WorktreeManager`, `StatusBar`. No panel was found using
  its own watcher or poll in place of the revision.
- **No listener leak.** Every file where `addEventListener` outnumbers
  `removeEventListener` was opened: they are either dynamically-created DOM nodes
  that die with their parent (`AIChatPanel.tsx:403,426`), injected iframe scripts
  (`iframeSearch.ts`), or process-lifetime singletons (`index.tsx`, `invoke.ts`,
  `transport.ts`). No per-instance accumulation across remounts was found.
- **`pluginStore` / `registryStore` / `activityStore`** mutate at
  registration/user rate with debounced persistence. Nothing hot.

## Not covered

- **`conversationStore.ts`** — inventoried only (23 `createSignal`s per
  conversation, `:208-223`). `streamingText` / `textChunks` / `reasoningChunks`
  are string signals appended per token, i.e. an O(n) concat plus a notify per
  token. That is **chunk 2b's** territory (AI streaming) and was left to it
  deliberately; flagging here only so it is not assumed covered by either side.
- **`settings.ts` (30 KB) and `ui.ts` / `paneLayout.ts` (18-20 KB)** — read by
  almost every component; write granularity not audited. Highest-value remaining
  target in this area.
- **`mdTabs.ts`, `promptLibrary.ts`, `repoSettings.ts`, `globalWorkspace.ts`,
  `keybindings.ts`, `remoteConnections.ts`, `tunnels.ts`, `dictation.ts`** — not
  opened.
- **`useTerminalLifecycle.ts` (36 `terminalsStore` references)** — only its
  `getIds()` call sites were checked; the branch-switch teardown/rebuild path
  was not analysed and is a plausible burst source.
- **The repo-changed → `bumpRevision` fan-out** (`useAppInit.ts:374-409`) was read
  but deliberately not judged — chunk 5 owns it. It looked well engineered
  (per-repo debounce, per-frame revision coalescer, in-flight tracking).
- **No profiling was run.** Every quantity above is either measured on this
  machine (the cardinality table, the 6025-byte payload) or an explicitly labelled
  estimate derived from reading the code. `GET :9876/logs` was not consulted for
  `SLOW`/`UI freeze` lines because no reproduction scenario was driven.

## Open questions

- **Answers chunk 6's open question on F50.** The claude-usage ticker message *is*
  a permanent resident, independent of the active tab: `plugins/index.ts:34-37`
  calls `initClaudeUsage()` whenever `claude-usage` is not in the disabled list
  (i.e. by default), and `poll()` re-adds the message on every `API_POLL_MS`
  interval with `ttlMs = API_POLL_MS + 30_000` (`claudeUsage.ts:108-120`), so the
  message set never empties and `stopTimers()` never fires. The
  `agentType() === "claude"` filter at `StatusBar.tsx:272` is display-only.
  **F50's 1 Hz churn should be treated as always-on in the default configuration.**
- ~~Is `uiStore.state.repoFilterActiveOnly` something Boss actually leaves on?~~
  **Answered (main session, 2026-08-16):** it defaults to `false`
  (`src/stores/ui.ts:106`) and is **not persisted** — no save/localStorage path
  writes it, and it is absent from `config.json` on this machine. So the
  expensive mode is off at every launch and only reachable by toggling the
  toolbar filter within a session. F33 stays P3.
- What does `list_active_sessions` cost on the Rust side per call? F30's 1 Hz
  cadence is only clearly P2 if assembling the response is cheap; if it takes
  locks across the whole session map it may be worse than the payload suggests.
  Chunk 2 read `state.rs`'s DashMap inventory but not this command.
- Does any consumer actually need `shellStateRevision` to advance on a *no-op*
  shell-state event (`terminals.ts:545`)? All five readers found compare it for
  staleness across an `await`, which a change-only bump would still satisfy — but
  the guard semantics ("did anything at all happen since I asked") may be
  intentional. Worth confirming before touching it.
