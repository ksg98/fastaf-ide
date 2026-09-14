# Performance & Efficiency Scan

Rolling audit of CPU, memory and IPC efficiency across the app. Work proceeds in
**chunks**: each chunk covers a bounded area, records which files were read, and
appends findings here. Never re-scan a file already marked `done` for the same
chunk dimension unless the code changed.

**Scope of this document:** efficiency only — wasted work, redundant IPC,
main-thread contention, allocation churn, unbounded growth. Correctness bugs are
recorded only when they are a *consequence* of an efficiency mechanism (e.g. a
throttle that silently drops data a consumer needs).

---

## Methodology

For every file/area, answer these questions. A "yes" to any is a finding.

### A. IPC / transport

1. Does data cross the Rust→WebView boundary that the frontend **does not use**,
   or uses only to derive a value Rust already knows?
2. Is an event emitted **per chunk / per frame / per tick** without coalescing?
3. Does the same event have **more than one listener** in the frontend, or is it
   serialized more than once per emit?
4. Is a payload serialized eagerly even when no subscriber is registered?
5. Does a throttle/sampling mechanism drop data that a downstream consumer
   assumes is complete? (throttle + stateful reassembly = corruption, not just loss)

### B. Main-thread work in the WebView

6. Is there per-byte / per-line / per-frame work on the main thread that Rust
   could do once (regex, string scanning, ANSI stripping, parsing, sorting)?
7. Does a handler allocate a new string/array per chunk in a hot loop?
8. Are Solid effects/memos re-running on a signal that changes far more often
   than the rendered output?
9. Is a listener registered per component instance where one shared listener
   would do (N terminals x N events)?

### C. Rust side

10. Is a lock held across an `await` or across an expensive computation?
11. Per-chunk allocations that could be reused buffers?
12. Polling loops where an event/watcher exists?
13. Work done per session that could be done once globally?
14. Unbounded growth: rings, maps, caches without eviction.

### D. Architecture rule check (AGENTS.md)

15. "All business logic in Rust; frontend only renders" — is the frontend
    reshaping, computing or orchestrating? That is both a rule violation and,
    usually, a main-thread cost.

### Severity

| Level | Meaning |
|---|---|
| P1 | Observable stall/freeze, data corruption, or unbounded growth |
| P2 | Measurable waste on a hot path (per-chunk/per-frame), no user-visible symptom yet |
| P3 | Structural waste, cheap today, will bite at scale |

### Verification ladder

Code inspection → targeted test → `GET :9876/logs` (`SLOW …`, `UI freeze …`) →
`POST :9876/diagnostics {"enabled":true}` snapshots → PTY capture
(`POST :9876/diagnostics/capture`). Do not claim a number that was not measured;
mark estimates as estimates and state the derivation.

---

## Chunk index

| # | Area | Status | Owner | Findings | Raw output |
|---|---|---|---|---|---|
| 1 | PTY output path: Rust reader → IPC → WebView → plugins | done | main session | F1-F3 | inline |
| 2 | Rust `emit` sites vs frontend listeners (sampling sweep) | done | opus agent | F4-F9 | inline |
| 2b | Chunk 2 remainder: AI streaming, per-session WS, keystroke emits, panel sync | done | opus agent | F10-F19 | `perf-scan/chunk-2b.md` |
| 3 | Terminal grid frame path (grid channel, ack, repaint) | done | opus agent | F20-F29 | `perf-scan/chunk-3.md` |
| 4 | Solid store/effect fan-out (stores, memos, per-frame reactivity) | done | opus agent | F30-F39 | `perf-scan/chunk-4.md` |
| 5 | Git panel + repo watcher refresh batching | done | opus agent | F40-F49 | `perf-scan/chunk-5.md` |
| 6 | Plugin host API surface (invoke fan-out, dashboards, tickers) | partial | main session | F50 | `perf-scan/chunk-6.md` |
| 6b | Plugin runtime: panel/dashboard iframe, host tiers 3b/3d/3i, watches, item churn | done | opus agent | F100-F109 | `perf-scan/chunk-6b.md` |
| 7 | MCP HTTP / SSE server, MCP proxy, relay, tunnel audit DB | done | opus agent | F60-F69 | `perf-scan/chunk-7.md` |
| 2c | AI engine: `run_conversation`, tools dispatch, knowledge write path, diff_triage internals | done | opus agent | F110-F119 | `perf-scan/chunk-2c.md` |
| 3b | Terminal input half, selection/search/link IPC, resize/reflow, suggest overlay | done | opus agent | F90-F99 | `perf-scan/chunk-3b.md` |
| 4b | Hot stores: `settings`/`ui`/`paneLayout`, terminal lifecycle, remaining stores | done | opus agent | F70-F79 | `perf-scan/chunk-4b.md` |
| 8 | Cold start: Rust setup, frontend init, session restore, plugin load, persistence | done | opus agent | F80-F89 | `perf-scan/chunk-8.md` |
| 9 | Filesystem walks, content search query path, file browser | done | opus agent | F120-F129 | `perf-scan/chunk-9.md` |
| 10 | Mobile client, dictation/audio pipeline | done | opus agent | F130-F139 | `perf-scan/chunk-10.md` |

**Parallel protocol.** Concurrent chunks write their own `perf-scan/chunk-<n>.md`
(same section format), each using its reserved finding-id range so ids never
collide. The main session merges them into this file and marks the chunk `done`.
Only the main session edits the sections above "Findings".

---

## Audit result (independent verification pass, 2026-08-17)

122 unique finding headings across this file and `perf-scan/*.md`; no duplicate
ids; unused ranges are F36-F39, F51-F59, F76-F79. Verified read-only; no tests,
builds or runtime probes were run, and the working tree was unchanged by the
audit (pre/post `git status` snapshots identical).

| Verdict | Count |
|---|---|
| CONFIRMED | 104 |
| PARTIAL | 16 |
| DUPLICATE-DEPENDENT | 1 (F34 → merged into F12) |
| INCORRECT | 1 (F69 → dropped) |
| NOT PROVEN / RESOLVED-OBSOLETE | 0 |

Severity as originally filed: P1=9, P2=62, P3=51. **After merges, drops and
corrections: P1=8, P2=65, P3=47 — 120 independent active findings.**

Corrections applied:

- **F16 P3 → P2** — wrong completed-review count.
- **F82 P3 → conditional P2** — P2 only when the copy branch is exercised; it
  can overwrite the installed CLI.
- **F90 P1 → P2** — pending a runtime reproduction; raise again only if hidden
  mouse-reporting shows material impact.
- **F69 dropped** — the keychain-storm claim is contradicted by the current
  process-wide vault cache. Only a possible in-process map/mutex cost remains.
- **F34 merged into F12** (duplicate-dependent).

Not duplicates, despite adjacency: F1-F3, F20-F29 and F40-F45 are dependency
*chains*. F21 (hidden grid-frame work) and F90 (document-level mouse handling)
are distinct mechanisms.

---

## Priority queue (corrected, 2026-08-17)

Ordered by the audit. Correctness ahead of throughput; a fix lower in the list
often depends on one above it.

| # | Findings | Theme |
|---|---|---|
| 1 | **F1**, then **F3/F2** | lossless watcher correctness; redundant raw parsing |
| 2 | **F5** | search-result correlation / cross-talk correctness |
| 3 | **F4** | duplicate OSC 133 → phantom state |
| 4 | **F20** | binary grid transport |
| 5 | **F21**, **F22** | hidden-terminal ACK/frame suppression; row-cache bound |
| 6 | **F120** | synchronous filesystem / editor IPC risk |
| 7 | **F10**, **F130** | full AI-markdown and mobile-terminal DOM rebuilds |
| 8 | **F27**, then **F13/F15** | frame ACK/delta recovery; browser raw-stream backpressure |
| 9 | **F40-F45** | watcher storm → ignore coverage → config lock → index rebuild/leak |
| 10 | **F30**, **F80**, **F83-F86** | lifecycle/startup polling and concurrency |
| 11 | **F6**, **F110**, **F119** | resident knowledge; persistence/outcome noise |
| 12 | **F61-F64** | MCP health, resolver, stdio timeout, unfiltered event traffic |
| 13 | **F90** | hold at P2; re-rank after reproduction |
| 14 | P3 cleanup | F7-F9, F17-F19, F31-F35, F46, F48-F50, F65-F75, F81, F87-F88, F92, F99, F103-F108, F112, F114, F116-F118, F136-F139 |

---

## Evidence limits — read before fixing anything

**Mechanism is established from code** for: F1-F3, F5-F9, F12-F19, F23-F26, F29,
F31-F35, F41, F43-F50, F61-F62 (shape), F66-F68, F70-F75, F82 (code path), F88,
F91-F93, F96-F99, F104-F108, F110-F118, F121-F128, F134-F139. These can be acted
on directly.

**Impact, occurrence or magnitude still needs a runtime check** for: F4, F10,
F20-F22, F27-F28, F30, F40/F42, F60, F63-F65, F80-F81, F83-F87, F89, F90,
F94-F95, F98, F100-F101, F109, F119, F120, F129, F130-F133. **None of those
checks was performed.**

Specifically **not** measurements — code-derived estimates, labelled as such at
their use sites: F2 640 KB/s, F4 ~50 %, F8 byte counts, F10 4 MB / 400 ticks,
F20 7-9 MB/s, F22 260 KB/s, F28 wakeups.

**Stale on re-read:** every live count in this document was taken once and not
re-run — session counts, log rates, startup timings, repo/file counts, watcher
rate, bridge traffic, mobile polling rate, the 94 % outcome rate, and the
164 512-file / 5.5 s artifact scan. Some line references drifted (notably F3,
F10, F66, F129).

**Reproductions still owed:** F11 (live snapshot / history-wipe), F4 and F90
(focused UI/PTY repro), F120 (macOS/WebView thread evidence), F129 (re-scan
after the pending Build Cleaner changes).

**Constraints any fix must preserve:** IPC/HTTP parity, stateful PTY byte
ordering, the plugin sandbox/CSP decisions, whole-object config concurrency,
Build Cleaner's executable preservation.

**Cheap wins (small diff, no design decision needed)** — take these whenever a
branch is open, independently of the queue above:

| Finding | Sev | Fix size |
|---|---|---|
| F62 MCP `tools/call` reads+parses 10.6 KB `repo-settings.json` per call, discards it for native tools | P2 | ~3 lines (hoist into the `__` branch) |
| F111 `redact_secrets` makes 20 full copies before truncation | P2 | reorder truncate→redact |
| F119 94% of stored outcomes are `inferred` with empty `command` and 500-char screen tails | P2 | filter at write or at context assembly |
| F109 file-icon plugin parses ~1.2 KB of SVG per FileBrowser row via `innerHTML` | P2 | cache resolved SVG per extension |
| F105 panel message handler orphaned on tab-bar close (retains plugin module) | P3 | delete in the tab-close path |
| F66 `messaging_channels` never evicted on client disconnect | P3 | move cleanup out of the generator tail |
| F103 theme extraction walks all CSS rules twice per panel update | P3 | memo keyed on theme |
| F122 bm25 retains a 2nd full copy of the repo text (33.1 MB measured) and clones ~1 MB per query; nothing reads it | P2 | drop `with_corpus`' document store |
| F121 `search_files_impl` runs a full-repo `git status` for fields the Command Palette never renders | P2 | skip the extra fields for the palette caller |
| F99 `detectPlatform()` not memoised (4 calls per keystroke); `ctrlPunct` table built inside the hot path | P3 | 2 one-liners |
| F85 `detect_orphan_worktrees` sync, forks git for all 29 active repos at boot (208 ms measured) | P2 | `(async)` + drop it from the boot path |
| F82 `auto_update_cli()` forks two `--version` inside `setup` before the window; the copy branch can overwrite the installed CLI | P2 (conditional) | `thread::spawn` the call |
| F87 `load_app_config()` read twice in `setup`, second one only for `index_strategy` | P3 | reuse the loaded value |
| F88 `syncDisabledList()` runs twice per boot | P3 | hoist to `initPlugins` |
| F75 leftover debug `warn` captures a stack trace on every markdown-panel open | P3 | delete 2 log lines |
| F72 4 of the 16 persisted UI-pref fields have no readers; `saveUIPrefs` undebounced | P3 | reuse the 500 ms debounce, drop 4 fields |

| File | Chunk | Date | Verdict |
|---|---|---|---|
| `src-tauri/src/pty.rs` (reader loop 7060-7205) | 1 | 2026-08-16 | 2 findings (F1, F2) |
| `src/plugins/pluginRegistry.ts` (dispatch 800-850) | 1 | 2026-08-16 | 1 finding (F3) |
| `src/utils/lineBuffer.ts` | 1 | 2026-08-16 | contributes to F1 |
| `src/components/Terminal/CanvasTerminal.tsx` (subscribe 2830-2920) | 1 | 2026-08-16 | contributes to F1/F2 |
| `src/components/Terminal/Terminal.tsx` (255-275, 550-565) | 1 | 2026-08-16 | contributes to F2 |
| `src/components/Terminal/canvasTerminalTransport.ts` | 1 | 2026-08-16 | clean (thin wrapper) |
| all 78 Rust `emit`/`emit_to` sites (inventory pass) | 2 | 2026-08-16 | 25 files, see per-file rows |
| `src-tauri/src/pty.rs` (OSC/term-event emits 4406-4530) | 2 | 2026-08-16 | F7; contributes to F4 |
| `src-tauri/src/pty.rs` (pty-parsed emit sites, 9) | 2 | 2026-08-16 | clean (all deduped/edge-triggered) |
| `src-tauri/src/pty.rs` (`cleanup_session`/`tombstone_transient_cleanup` 5246-5347) | 2 | 2026-08-16 | F8 |
| `src-tauri/src/state.rs` (`emit_pty_event`, accumulator 1629-1639, 2962-3175) | 2 | 2026-08-16 | F9 |
| `src-tauri/src/state.rs` (session-keyed `DashMap` inventory 1226-1583) | 2 | 2026-08-16 | F8 |
| `src-tauri/src/mcp_http/sse_routes.rs` | 2 | 2026-08-16 | F9 |
| `src-tauri/src/ai_agent/knowledge.rs` (`load_all`, `summarize_for_repo`) | 2 | 2026-08-16 | F6 |
| `src-tauri/src/ai_agent/watcher.rs` (bus consumer 646-719) | 2 | 2026-08-16 | clean |
| `src-tauri/src/content_index.rs` (bus consumer 431-459) | 2 | 2026-08-16 | contributes to F9 |
| `src-tauri/src/fs.rs` (`emit_content_batches` 482-525) | 2 | 2026-08-16 | F5 |
| `src-tauri/src/github_poller.rs` (`poll_batch`, `process_repo_update`) | 2 | 2026-08-16 | clean (change-detected) |
| `src-tauri/src/repo_watcher.rs` (emit triggers 698-812) | 2 | 2026-08-16 | clean here; see Open questions |
| `src-tauri/src/dir_watcher.rs` | 2 | 2026-08-16 | clean (debounced, path-filtered) |
| `src-tauri/src/plugin_fs.rs` (`debounce_loop` 440-500) | 2 | 2026-08-16 | clean (debounced + batched) |
| `src-tauri/src/mcp_http/session.rs` (emits 460, 594, 909) | 2 | 2026-08-16 | clean (lifecycle only) |
| `src-tauri/src/mcp_http/mcp_transport.rs` (emits 2489, 2522, 3402, 5565) | 2 | 2026-08-16 | clean (lifecycle only) |
| `src-tauri/src/dictation/commands.rs` (partial forwarder 306-323) | 2 | 2026-08-16 | clean |
| `src/components/Terminal/Terminal.tsx` (listeners 644-724) | 2 | 2026-08-16 | F4 |
| `src/components/Terminal/CanvasTerminal.tsx` (`onEvent` 2903-2918) | 2 | 2026-08-16 | F4 |
| `src/stores/terminals.ts` (`handleOsc133` 634-690, flush 219-257) | 2 | 2026-08-16 | F4 |
| `src/stores/commandPalette.ts` (139-165) | 2 | 2026-08-16 | F5 |
| `src/hooks/useFileBrowser.ts` (72-81) | 2 | 2026-08-16 | F5 |
| `src/components/FileBrowserPanel/FileBrowserPanel.tsx` (471-495) | 2 | 2026-08-16 | F5 |
| `src/components/MarkdownPanel/MarkdownPanel.tsx` (149-170) | 2 | 2026-08-16 | F5 |
| `src/components/AIChatPanel/SessionKnowledgeBar.tsx` (89-111) | 2 | 2026-08-16 | clean (debounced refetch) |
| `src/hooks/useAppInit.ts` (listener registry 305-660) | 2 | 2026-08-16 | clean (singleton, coalesced) |
| `src/stores/dictation.ts` (135-160, 328-375) | 2 | 2026-08-16 | clean (poll bounded to recording) |
| `src/plugins/planPlugin.ts` / `storiesTickerPlugin.ts` (`dir-changed`) | 2 | 2026-08-16 | clean (path-filtered) |
| `src/components/Terminal/canvasTerminalTransport.ts` (`onEvent` naming) | 2 | 2026-08-16 | contributes to F4/F7 |

---

## Findings

### F1 — `pty-output` throttle corrupts plugin OutputWatcher input (P1)

`src-tauri/src/pty.rs:7136-7160` emits `pty-output-{id}` at most every 100 ms and
**discards the intermediate chunks**. The in-code rationale is that the canvas
renders from grid frames and "handlePtyData ignores `data`" — true for
`Terminal.tsx:265`, but **false** since `CanvasTerminal.tsx:2914` routes the same
payload into `pluginRegistry.processRawOutput`.

Consequence is worse than loss: `LineBuffer` (`src/utils/lineBuffer.ts:17`) keeps
the partial trailing line across chunks, so a dropped chunk **concatenates the
tail of chunk A with the head of chunk C** and emits it as one line. Watchers can
therefore both miss real lines and match on lines that never existed.

Contract broken: `docs/plugins.md:174` — "Watches every PTY output line".
Affected today: `plugins/claude-wakeup` (`/done/i`), `plugins/at-capacity-retry`
(`/model is at capacity|.../i`) — both are rare-line detectors, the exact shape
that a lossy stream breaks silently.

### F2 — `pty-output` exists only to recompute state Rust already owns (P2)

Two listeners per terminal on the same event: `Terminal.tsx:558`
(`subscribePty`, ignores the payload, only stamps `lastDataAt` + activity flag)
and `CanvasTerminal.tsx:2914` (watchers). The activity signal is derivable in
Rust with zero payload; the watcher need is addressed by F3. With both fixed the
event disappears from the desktop path entirely — the `DEFERRED (2026-06-16)`
note at `pty.rs:7073` already proposes exactly this.

Upper bound of the waste (estimate, derived from code not measured): 64 KB reads
at 10 emits/s = up to ~640 KB/s per active session of JSON payload built in Rust,
crossed into the WebView and dispatched on the thread that paints the terminal.

### F3 — Watcher regex matching runs on the WebView main thread (P2)

`src/plugins/pluginRegistry.ts:809-828` runs, per line and per registered
watcher: `stripAnsi`, a backtick strip that allocates via `split().join()`, then
`RegExp.exec`. `onMatch` is already deferred to a microtask, so the callback is
not the cost — the **matching** is, and it is pure text work with no DOM
dependency. Candidate for the Rust `regex` crate with a match-only event back to
the frontend, mirroring the existing `registerStructuredEventHandler` path.

Caveat for the design: JS `RegExp` is not a subset of the Rust `regex` crate.
`at-capacity-retry` uses a non-capturing group + `i` (portable); anything with
lookaround/backreferences is not, and would need `fancy-regex` or a
frontend fallback path. Any implementation must reject-and-fallback, never
silently mis-compile a pattern.

### F4 — `pty-osc133` has two desktop listeners; the second fabricates a command block (P1)

The same Tauri event `pty-osc133-{sessionId}` is listened to twice on desktop:

- `src/components/Terminal/Terminal.tsx:667` → `terminalsStore.handleOsc133(props.id, marker, line, exit_code)`
- `src/components/Terminal/CanvasTerminal.tsx:2910` → `terminalsStore.handleOsc133(props.terminalId, marker, line, exit_code)`

They carry the same ids: `Terminal.tsx:1205-1206` passes `sessionId={sid}` and
`terminalId={props.id}` to `CanvasTerminal`, and `TauriTransport.onEvent`
(`canvasTerminalTransport.ts:85`) resolves `"osc133"` to the same
`pty-osc133-{sessionId}` name. Terminal's listener is behind `isTauri()`
(`Terminal.tsx:645`), CanvasTerminal's transport is `TauriTransport` on desktop —
so on desktop **both** fire, on browser only CanvasTerminal's. The
CanvasTerminal block was added for browser parity (commit `311ffbcc`,
"Listen for session events via transport") without removing the desktop one.

`handleOsc133` is **not idempotent** for the `A` marker
(`src/stores/terminals.ts:640-658`): it finalizes any existing `activeBlock` into
`_osc133Pending` and then installs a new one. `setState` is synchronous, so the
second delivery reads the block the first one just wrote, finalizes *that*, and
pushes it. Normal shell flow is A→B→C→D, with D clearing `activeBlock`, so at
every `A` the first call finds `null` (no finalize) and the second call finds the
fresh block (finalize). Result: **one phantom block per prompt**, with
`commandLine`/`executionLine`/`endLine`/`exitCode` all null.

No dedup downstream: `_scheduleOsc133Flush` (`terminals.ts:225-257`) appends
`pending` verbatim to `commandBlocks`. So the block list that drives block
folding and the scrollbar markers is ~50% phantoms, and the `MAX_BLOCKS = 500`
ring evicts real history twice as fast. `C` double-fires only
`lastCommandExecAt` (harmless); `D` is idempotent (second call sees `null`).

Verified by inspection only — the running orchestrator instance emits no
`[OSC133] … flushed` debug lines (its agent sessions are alt-screen and have no
shell integration), so this was not reproduced live. Any fix should be
confirmed with a shell session that does emit OSC 133.

Note the same file also feeds `handleOsc133` from parsed `agent-block` events
(`Terminal.tsx:544-546`). That is a *different* source for agents without shell
integration, not a third duplicate — but it shares the same non-idempotent sink,
so it constrains any fix.

### F5 — `content-search-batch` is a global broadcast with no correlation id and three consumers (P2)

`src-tauri/src/fs.rs:495` and `:510` emit `content-search-batch` with a payload
(`fs.rs:63-73`) that carries **no search id, no repo path and no query** — only
matches and counters. Three independent frontend consumers register a listener
for it, each appending every batch it receives to its own result list, none of
them filtering:

- `src/stores/commandPalette.ts:140` → `contentResults`
- `src/components/FileBrowserPanel/FileBrowserPanel.tsx:476` → `contentMatches`
- `src/components/MarkdownPanel/MarkdownPanel.tsx:152` → `contentPaths`

`src/utils/contentSearch.ts:20` is the shared entry point for all three and adds
no correlation either. Cancellation is a single global token on the Rust side
(`fs.rs:76`, `ContentSearchCancel(Mutex<Option<Arc<AtomicBool>>>)`), so the
backend can only ever have one search in flight — but the **listeners are not
mutually exclusive**, they are torn down per search, not per panel.

Failure scenario: the FileBrowser panel is streaming results for query A; the
user opens the command palette and types query B. The palette's search cancels
A backend-side, but the FileBrowser's listener is still attached and receives
B's batches — appending unrelated matches to its list and flipping its spinner
off on B's `is_final`. Same for the Markdown panel's path filter.

This is the A.3 pattern (one event, N listeners) with a correctness consequence,
which is why it is recorded here rather than left as a style note. The fix is a
`search_id` in `ContentSearchBatch` echoed from the invoke, not more listener
bookkeeping.

### F6 — every AI session's knowledge stays resident forever; 30 days are loaded at startup (P2)

`state.session_knowledge` (`src-tauri/src/state.rs:1530`) is the only
session-keyed `DashMap` holding a large value — `SessionKnowledge` with a
`VecDeque<CommandOutcome>` capped at `MAX_COMMANDS = 2000`
(`ai_agent/knowledge.rs:54`), each outcome carrying an output snippet up to
`SNIPPET_MAX_LEN = 2000` chars (`knowledge.rs:16`).

It is **never removed**: neither `cleanup_session` (`pty.rs:5246-5277`) nor
`tombstone_transient_cleanup` (`pty.rs:5282-5347`) touches it, and no `.remove`
call for it exists anywhere in `src-tauri/src`. It is populated for any session
that completes an OSC 133 command (`pty.rs:4103-4110` → `record_outcome`), i.e.
every shell-integrated terminal, not just AI ones.

On top of that, `knowledge::load_all` (`knowledge.rs:490-518`) loads **every**
persisted session file from the last 30 days into the map at startup, on a
blocking task (`spawn_persist_task`, `knowledge.rs:549-552`). Retention pruning
happens only inside that same startup pass.

Measured on this machine (`~/Library/Application Support/com.tuic.commander/ai-sessions`,
2026-08-16): **1915 files, 1904 of them inside the 30-day window, 6.93 MB of
JSON** (11 MB by `du`, inflated by 4 KB block granularity on small files).
All 1904 are deserialized into owned Rust `String`/`VecDeque`/`HashMap` at every
launch and held for the process lifetime. In-memory footprint is an **estimate**,
not measured: JSON→owned-struct expansion is typically 1.5–3×, so roughly
10–20 MB resident, plus 1904 `DashMap` entries and 1904 file reads at startup.

Second-order cost: `summarize_for_repo` (`knowledge.rs:263-300`) iterates the
whole map and takes a `parking_lot::Mutex` on each entry to test cwd relevance.
That is O(1904) locks per call today. It is called once per L2 conversation
(`conversation_engine.rs:706`, outside the turn loop), not per turn, so it is a
scaling concern rather than a hot path.

### F7 — `pty-vt-log-total-{id}` is emitted to nobody, and its comment claims otherwise (P3)

`src-tauri/src/pty.rs:4417-4432` maintains a 100 ms throttle and emits
`pty-vt-log-total-{session_id}` whenever the scrollback grows. The comment at
`pty.rs:4414-4416` states "Frontend listens to `pty-vt-log-total-{session_id}`
and updates cache.total and cache.oldest for the scrollback overlay."

No such listener exists. Grepping `src/` and `plugins/` for `vt-log-total`,
`vt_log`, `pty-vt-log` returns only `src/transport.ts:1895` — and that is the
`read_vt_log` **command** sitting in `INTENTIONALLY_UNMAPPED`, with no caller in
`src/` either. `TauriTransport.onEvent` (`canvasTerminalTransport.ts:85`) is
never called with `"vt-log-total"`, and `WsTransport`'s handler map
(`canvasTerminalTransport.ts:202`) never registers it.

Cost is small but non-zero and, per the Tauri source, unavoidable-by-listener-count:
`Manager::emit` (`tauri-2.11.5/src/manager/mod.rs:534-549`) builds `EmitArgs`
— i.e. runs `serde_json::to_string` (`event/mod.rs:125-132`) — **before**
consulting the listener registry, so a dead event still pays serialization plus
the `format!` for the event name plus the `js_event_listeners` mutex acquisition
in `emit_js_filter` (`event/listener.rs:281`). Up to 10 emits/s per active
session (throttle-derived upper bound, estimate).

The stale comment is the more expensive part: it will make a future reader
"fix" the frontend rather than delete the emit.

### F8 — six session-keyed `DashMap`s are never reaped (P3)

Cross-referencing every `DashMap<String, …>` field in `AppState`
(`state.rs:1226-1583`) against all `.remove(`/`.retain(` calls in
`src-tauri/src` shows these have **zero** removal sites anywhere:

| Field | Line | Value |
|---|---|---|
| `slash_mode` | `state.rs:1394` | `AtomicBool` |
| `last_input_ms` | `state.rs:1404` | `AtomicU64` |
| `marker_stats` | `state.rs:1455` | `MarkerStats` |
| `has_osc133_integration` | `state.rs:1538` | `()` |
| `session_visibility` | `state.rs:1553` | `bool` |
| `ai_suggestions_enabled` | `state.rs:1560` | `bool` |

(`term_alias_counters`, `state.rs:1549`, is also never removed but is keyed by
alias *prefix*, so it is bounded by the number of prefixes — not a leak.)

All six are keyed by session id and all six values are small PODs, so the
growth is roughly six entries × (36-byte UUID `String` + `DashMap` slot) ≈
**a few hundred bytes per closed session** — estimate, derived from the type
sizes, not measured. That is why this is P3 and not P1 despite matching the
"unbounded growth" row: it is a slow leak, not a pressure source. It matters
because `cleanup_session`/`tombstone_transient_cleanup` are *explicit
enumerations* — every new session-keyed map has to be added by hand, and six
have already been missed. F6's `session_knowledge` is the same omission with a
five-orders-of-magnitude larger value.

### F9 — the global `AppEvent` bus deep-clones `PtyParsed` for subscribers that discard it (P3)

`AppState::emit_pty_event` (`state.rs:1629-1639`) fans one event out three ways
and clones it twice on the way (`session_state_events`, per-session channel,
global bus). The global bus is a `tokio::sync::broadcast` (`state.rs:1347`,
capacity 256), which clones the value **again per receiver on `recv`**.

`AppEvent::PtyParsed` carries a `serde_json::Value`, so each of those is a deep
clone of a heap JSON tree. The permanent runtime subscribers are:

| Subscriber | Site | Wants |
|---|---|---|
| session-state accumulator | `state.rs:2964` | non-PTY events only (PTY arrives on the lossless lane, `state.rs:2979-2981`) |
| content index updater | `content_index.rs:433` | `RepoChanged` only — everything else hits the `Ok(other) => trace!` arm |
| watcher engine | `ai_agent/watcher.rs:647` | `PtyParsed` + `SessionClosed` + `GitHubTransition` |
| relay client | `relay_client.rs:263` | (only when relay is enabled) |
| `/events` SSE | `sse_routes.rs:30` | one receiver **per connected client** |

So `content_index` deep-clones every `PtyParsed` in the app purely to fall into
a trace arm, and the accumulator clones every one to discard it at
`pty_session_id().is_none()`. Note the accumulator's global-bus arm exists only
for non-PTY events — the PTY ones already reached it losslessly — which makes
this clone pure waste by construction, not an oversight in the consumer.

Also on this path: `sse_events` applies its `?types=` filter *before*
serializing (good), but `event_payload` + `serde_json::to_string`
(`sse_routes.rs:51`) run **once per connected SSE client**, so N browser/PWA
clients re-serialize the same event N times. Correct but worth knowing before
the mobile/PWA client count grows.

Frequency is the reason this is P3, not higher: `pty-parsed` is *not* per-chunk.
Every emitter is edge-triggered or deduped — `StatusLine` is deduped per
`(turn_epoch, task_name)` (`pty.rs:4870-4876`), `Question` by prompt text
(`:4881`), `ChoicePrompt` by title+keys (`:4892`), `Suggest` is parked until
idle (`:4863`), `ShellState` only on transition (`:2904`). The pty-parsed emit
path is, on inspection, the healthiest high-level event path in the codebase.

---

## Not covered by chunk 2

Declared explicitly so chunk 2b does not re-derive the boundary:

- **`Channel::send` / grid-frame path.** Deliberately skipped — chunk 3 owns it.
  Chunk 2 read `subscribe_terminal_grid`/`ack_terminal_frame` only far enough to
  confirm they are not `emit` sites.
- **Per-session WS handlers** (`/sessions/{id}/stream`, log-mode and grid-mode
  framing in `mcp_http/session.rs`). Only the `emit` sites in that file were
  read; the streaming loops, ring catch-up and frame framing were not.
- **AI streaming paths**: `mcp_http/ai_stream.rs`, `ai_terminal.rs`,
  `conversationStore.ts` SSE/WS bridges, `utils/aiStream.ts`. These are
  high-frequency token streams and deserve their own chunk.
- **`diff_triage.rs` (6 emits) and its `sink.emit` progress protocol**,
  `improvement_scan.rs`, `conflict_assist.rs`, `githubOps.ts` multi-event
  registration (`src/stores/githubOps.ts:173`). Inventoried, not read.
- **`panel_window.rs` / `utils/panelSync.ts`** detached-panel snapshot sync —
  a full-state snapshot per change is exactly the shape this scan hunts, but it
  was not opened.
- **`native_keys.rs`, `dictation/fn_key_monitor.rs`** — per-keystroke `emit_to`
  sites. Frequency looks high; not analysed.
- **Solid effect fan-out** downstream of the listeners (chunk 4's area). F4/F5
  stop at the store mutation and do not follow the re-render cost.
- **No profiling was run.** Every quantity in F4-F9 is either measured on disk
  (F6's file count/bytes) or an explicitly-labelled estimate derived from code.

---

## Open questions

- ~~Does Tauri v2 serialize the payload once per `emit` or once per registered
  listener?~~ **Answered (chunk 2, tauri 2.11.5, `Cargo.lock:7755`):** once per
  `emit`. `Manager::emit` (`manager/mod.rs:534-549`) builds `EmitArgs` — a single
  `serde_json::to_string` (`event/mod.rs:125-132`) — and passes it by reference to
  `emit_js_filter`, which collects **all** matching handler ids for a webview and
  issues **one** `webview.emit_js(emit_args, &ids)` (`event/listener.rs:282-290`).
  So F2's double subscription costs one extra JS-side dispatch, not a second
  serialization or a second IPC crossing. Two further consequences: (a)
  serialization happens *before* the listener lookup, so an event with zero
  listeners still pays it in full (see F7); (b) `emit_js` is skipped entirely
  when the event name has no registered handler for that webview, so a dead
  event costs serialization but not a webview `eval`.
- `repo_watcher.rs:787-812` — the working-tree `repo-changed` trigger has **no**
  fingerprint dedupe, unlike the git-state trigger at `:757-784`. Live logs on
  this machine show `Emit repo-changed (working-tree)` with `repeat_count: 12`
  for a single repo. Each one costs a `clear_repo_caches` IPC + a `.tuic.json`
  reload + a revision bump (`useAppInit.ts:374-409`). Whether those repeats are
  genuine distinct edits or FSEvents chatter was not determined — chunk 5's call.
- `dir_watcher.rs:64-81` implements its debounce by `rt.spawn`-ing a sleeping
  task per filesystem event and aborting the previous one. Under a burst that is
  N task spawns + N-1 aborts where a stored deadline would do. Tasks are cheap
  and the rate is bounded by the fs; not filed as a finding without a measured
  burst rate.
- `SessionStateEventQueue` (`state.rs:371-384`) is an **unbounded** mpsc by
  design (losing a SET or CLEAR strands the badge). Its only consumer is the
  single accumulator task (`state.rs:2962-2996`). If
  `apply_event_to_session_state` ever blocks — it takes `DashMap` entry locks and
  calls `push_store`/`send_mobile_push` — the queue has no backpressure. No
  blocking call was found on the current path; flagged as a structural property
  to keep in mind, not a defect.
- F4's phantom-block claim is code-verified but not reproduced at runtime.
  Reproducing it needs a shell session with OSC 133 integration and a read of
  `terminalsStore.state.terminals[id].commandBlocks` — worth doing before the fix
  lands, to confirm the phantom count matches the prompt count 1:1.

---

## Post-fix re-verification pass (2026-08-19)

Re-run of the verification pass demanded by story 616-71e1, against the code as
it stands after Perf 1-17 landed. Read-only; no file was modified by the pass
and the working tree was unchanged by it. Every one of the 122 headed findings
(F1-F9 in this file, F10-F139 across `perf-scan/*.md`; unused ranges F36-F39,
F51-F59, F76-F79) now carries a definite verdict, so the previous pass's
unattributed "PARTIAL x16" bucket no longer exists — whatever those 16 were,
each finding below is now closed, re-filed or dropped.

**This pass answers only what code can answer.** No measurement was taken: the
running app is still the pre-fix binary, so every magnitude in this document
(F2 640 KB/s, F4 ~50%, F8 byte counts, F10 4 MB/400 ticks, F20 7-9 MB/s,
F22 260 KB/s, F28 wakeups) remains an unverified estimate. Structural claims
were verdicted; their magnitudes were not.

| Verdict | Count |
|---|---|
| FIXED | 100 |
| STILL-OPEN | 20 |
| WRONG (dropped) | 2 |
| **Total** | **122** |

### Still open after the fix wave

| id | where it still bites |
|---|---|
| F7 | `pty-vt-log-total-{id}` still emitted with no frontend listener — `src-tauri/src/pty.rs:4653` |
| F16 | diff_triage "done" still emits an empty slice, so findingsCount is 0 — `src-tauri/src/diff_triage.rs:1938` |
| F23 | `encode_col_count` always returns `num_cols`; `TermDamage::Partial` left/right bounds discarded — `src-tauri/src/terminal_grid.rs:344` |
| F24 | `viewport_changed` still calls `mark_fully_damaged()` on every scroll — `src-tauri/src/terminal_grid.rs:1713` |
| F26 | vt mutex still held across `serialize_dirty_rows()` — `src-tauri/src/pty.rs:7355` |
| F28 | no subscriber check before serialization; 16 ms per-session ticker unchanged — `src-tauri/src/pty.rs:7355` |
| F29 | per-glyph `fillText`, per-cell `fillRect`, 7 `DataView` reads per cell — `src/components/Terminal/gridRenderer.ts:1256` |
| F30 | 1 Hz `syncAgentLifecycleStates` interval, ungated — `src/hooks/useAgentPolling.ts:311` |
| F60 | bridge still POSTs every 3 s on a fresh connection (server-side lock fast-path landed) — `src-tauri/crates/tuic-bridge/src/main.rs:743` |
| F67 | embedded assets recompressed per request, no cached body — `src-tauri/src/mcp_http/static_files.rs:134` |
| F68 | `rotate()` still has no non-test caller — `src-tauri/src/tunnels/audit.rs:159` |
| F87 | boot hydrate/themes/paneLayout still sequential; repo-config loop covers all repos — `src/hooks/useAppInit.ts:277` |
| F100 | plugin `srcdoc` still renavigates on every update with full base CSS + SDK — `src/components/PluginPanel/PluginPanel.tsx:129` |
| F102 | all md tabs stay mounted behind `display:none` — `src/components/TerminalArea.tsx:208` |
| F107 | `saveActivity` rewrites the whole items array per mutation — `src/stores/activityStore.ts:15` |
| F110 | knowledge `persist()` pretty-prints the whole session and `sync_all()`s per write — `src-tauri/src/ai_agent/knowledge.rs:484` |
| F112 | full `ChatRequest` (31 tool schemas) cloned per stream iteration — `src-tauri/src/ai_agent/conversation_engine.rs:809` |
| F113 | chat request rebuilt from every stored message each turn — `src-tauri/src/diff_triage.rs:1245` |
| F114 | context/knowledge reassembled before the `!=` comparison; no revision counter — `src-tauri/src/ai_agent/conversation_engine.rs:749` |
| F119 | inferred-outcome recording still stores 500-char screen tails per idle transition — `src-tauri/src/pty.rs:3374` |

F23, F24, F26, F28 and F29 are exactly the five findings parked under story
602-11ce: each needs either a grid-frame wire-format change or an architectural
one (double-buffering, ticker condvar wakeup). They are open by decision, not by
oversight.

### Dropped as incorrect

- **F25** — claims rows are stringified 2-3x per frame by `+=` concatenation.
  No `+=` string concatenation exists in `terminal_grid.rs`; every `+=` in the
  file is integer arithmetic. `read_screen_text` (:1870) and `row_to_text`
  (:1892) both build with `String::with_capacity(num_cols)` + `push(cell.c)`,
  once per damaged row per frame. The finding describes code that does not exist.
- **F69** — already retracted by the 2026-08-17 pass; the credential vault is
  process-wide cached (`src-tauri/src/credentials.rs:242`).

### Coverage limits of this pass

- Magnitudes were not measured — see the note above. Criteria 2-4 of story
  616-71e1 stay open until the app is rebuilt and restarted.
- The owed reproductions (F11 live snapshot and history-wipe, F4 and F90 focused
  UI/PTY repro, F120 macOS/WebView thread evidence) were not performed; they need
  a running post-fix build.
- F129 is verdicted FIXED against the build-cleaner poll gate from story
  617-fa7d, which currently lives **uncommitted** in the `plugins` submodule.
  Re-check it once that submodule is committed.

## Owed reproductions, performed (2026-08-19)

Run against a **post-fix debug build** (binary 2026-08-19 01:48, later than every
Perf 1-17 commit) started as a second instance on `:9877`, so Boss's live app was
never touched. This discharges the "reproductions still owed" list above.

**Line numbers in the 2026-08-19 sections cite the working tree as it stood when
each measurement was taken, not clean `HEAD`.** The tree carried unrelated
in-flight work at the time, so several citations sit a few lines off a clean
checkout — `pty.rs`, `state.rs`, `mcp_transport.rs`, `tuic-bridge/src/main.rs`
and `src/mobile/useSessions.ts` are each shifted. Trust the symbol names over the
numbers; re-resolve before quoting a line elsewhere.

| Finding | Verdict | Evidence |
|---|---|---|
| **F11** | no longer holds | The dead registry still returns an empty snapshot, but the frontend consumer that applied it after `loadConversation` is gone — `AIChatPanel.tsx:302-314` awaits `loadConversation` only and carries an explicit "No registry subscription here". Driven end to end on a self-created throwaway conversation: 9 conversations / 24 messages before, registry snapshot `messages:0`, 8 / 22 after wipe, `leftover_controls:0`. The empty snapshot can no longer wipe loaded history. |
| **F4** | retired by the fix | The second desktop listener is gone; `Terminal.tsx:678-684` documents why none may be added back. Guarded by `src/__tests__/components/Terminal/osc133SingleConsumer.test.ts`, a source scan that fails if any second `pty-osc133` subscription appears anywhere in `src/`. The "~50% phantom blocks" estimate is retired rather than measured — with one consumer the phantom block cannot be produced. |
| **F90** | P1 claim no longer holds | `onMouseMove` now early-returns on `hidden` (`CanvasTerminal.tsx:2740`) and then tests `isPointerInsideRect` before any `writePtyNoScroll`, so no SGR report reaches a PTY the pointer never touched. Residual, unfixed: the four `document`-level listeners per instance (`:2812-2813`, `:2938-2939`) still bind, so N terminals still run 2N early-returning handlers per `mousemove`. Cheap, bounded, no IPC. |
| **F120** | narrowed, one real residual | Blanket claim false: `fs_read_file`/write/create/delete/copy/move and both editor reads are `async fn` + `spawn_blocking_fs` (the shared `spawn_blocking_fs` helper is `fs.rs:20-27`; the commands themselves are `fs.rs:1334` onward, `lib.rs:744-748`, `:783-785`). **Still true for `fs_transfer_paths`** (`fs.rs:1624`) — a sync command running `copy_dir_recursive` on the macOS main thread; already carrying a `DEFERRED (2026-08-18)` note because it is the drag-drop backend and D&D needs Boss's approval. Thread evidence on the live pid: `ps -M` = 86 threads, diagnostics `threads=85` at the adjacent instant; `sample` recorded 99 thread blocks and ties WebKit IPC to the app main thread (`com.apple.main-thread` → `WebProcessProxy::didReceiveMessage` → `wry::wkwebview::…url_scheme_handler::start_task` → `tauri::webview::Webview::on_message`), plus `JavaScriptCore libpas scavenger`, `WebCore: Scrolling`, two `CVDisplayLink` threads. |
| **F129** | narrowed in the loaded build; **unfixed at committed HEAD** | The *recurring closed-panel* walk is gone from the build that is running: `plugins/build-cleaner/main.js:662-665` stops any prior timer, returns when `!panelVisible`, and only then installs the interval; `setPanelVisible` (`:669-671`) is the sole demand signal. Verified the loaded plugin is that source, not a stale copy: the installed path is a symlink into this working tree and both `main.js` files hash to `6530af6b137c9cc4e1b194f4b52ba168fbdb68ecc0f80f9628cbd88aceff920e`. **Three things the verdict must not be read to cover.** (1) `onload` still runs one `poll()` at startup (`:740`) and `openDashboard` still runs a full `scan` on every open (`:541`), so the 44.65 s walk is merely demand-driven, not eliminated. (2) The no-ignore traversal is untouched. (3) The fix exists **only in the dirty submodule working tree**: HEAD records gitlink `d09540f7`, where `startPollTimer` is an unconditional `setInterval(poll, config.pollIntervalMs)` with no visibility check. Anyone building from a clean checkout still gets the original finding. The submodule is Boss's to commit. |

Honest limits of this pass: F120's drag-drop path was not exercised, because HTTP
cannot drive the trusted Tauri drag-drop surface, so the residual is established
from source plus thread evidence rather than from a freeze reproduction. F129 has
no scan counter to read and the instance had been up under an hour, so the
absence of an hourly firing is proved from the loaded timer gate, not from
runtime observation.

## Live counts, re-measured (2026-08-19)

Same post-fix build and second instance as above. Live counts come from Boss's
running app on `:9876` (read-only `GET`), idle/cost figures from the `:9877`
instance so nothing was perturbed.

| Quantity | Original scan | Now | How |
|---|---|---|---|
| Sessions | 9 (F30/F28), 12 (F131) | **25** | `GET :9876/sessions`; it read 20 twenty minutes earlier and 26 later, so this number moves during a working day |
| Registered repos | 29 (F85/F86), 38 (F129) | **39** registered, 38 on disk, **30 watchers actually started** | `repos` and `repoOrder` in `repositories.json`, both 39; the missing path matches a `Failed to watch working tree` warning |
| Tracked files across those repos | — | **21 145** | `git ls-files` per repo, summed; largest are `itview` 5 448, `wiz-agents` 3 826, `agent2` 2 036, `tuicommander` 1 832 |
| App-log rate | — | **10.36 lines/s during boot, 0.082 lines/s at steady idle** | `GET :9877/logs?limit=5000`, split at `content index pre-warm complete`; rate = (n-1)/span from `timestamp_ms` |
| Cold start → HTTP listening | — | **593.6 ms** | `/tmp/tuic9877.log`: credential store 0 → agent-MCP scan 105.4 → knowledge load 393.9 → Tailscale 410.9 → first repo watcher 559.1 → TLS 590.7 → **TCP bind 593.6** → upstream dispatch 626.2 |
| Cold start → fully warm | — | **7 436 ms** | same log: last repo watcher 1 566 ms, last upstream ready 1 852 ms, **content-index pre-warm 7 436 ms**. The content-index tail alone is 5 584 ms — 75 % of warm time; everything else finishes inside 1.9 s |
| Watcher emit suppression | — | **0/min, under quiescence only** | `head_emits_suppressed` delta 0 over 240.6 s (9 `HEALTH` snapshots). Read this as a floor, not an all-clear — see the caveat below |
| Idle process cost | — | **cpu 0.4-0.5 %, 83-84 threads, 37-40 fds**; `git_cache_ttl_fallbacks` 23.9/min **over the first nine snapshots only** | `HEALTH` snapshots. The fallback rate is not steady: 0→96 across 240.6 s gives 23.9/min, but the same counter over the whole capture gives 17.4/min, and over a second capture 7.2/min. Quote it with its window or not at all. The 97.4 % seen once was the startup content-index build, gone within a minute |
| Bridge traffic | 19 bridges, 6.3 connects/s | **27 bridges, 9.0 connects/s** (+42 %) | `pgrep -af tuic-bridge` = 27 live, 24 distinct parents; the 3 s reconnect loop is unchanged at `tuic-bridge/src/main.rs:773`, still a fresh `connect_ipc()` per tick, so 27 ÷ 3 = 9.0/s. F60's mechanism is intact |
| Mobile polling | — | **20 polls/min per client, 14 619 B/poll at 25 sessions ≈ 4.9 KB/s** | `POLL_INTERVAL_MS = 3_000` (`src/mobile/useSessions.ts:64`, used `:132`); `curl :9876/sessions \| wc -c` = 14 619 at 25 sessions, 587 at 2. Per-session cost is **not** flat: 584.8 B at 25 sessions against 293.5 B at 2, so the payload grows faster than the session count |
| Stored-outcome composition | 94.0 % inferred of 8 093 across 1 918 files | **92.94 % inferred** — 6 278 inferred / 310 success / 167 error = 6 755 across 1 847 files (9.6 MB) | parsed on `classification.kind` in `ai-sessions`. Magnitude holds |
| Build-artifact scan | 164 512 files (F129) | **44.65 s wall, 228.86 GiB, 39 entries**; **406 567 files across 38 repos (+147 %)** | the timing is a real `POST /api/plugins/build-cleaner/build-artifacts/scan` with `forceRefresh:true`. The file count is **not** a replication of the Rust walk — it is a broader name-only census (see the caveat below). Top: `tuicommander` 195 372 (was 61 764), `LS/agent2` 84 671 (absent from the old list), `SpeechMaster` 42 000 |
| Knowledge corpus | 1 904-file load (F6) | **1 802 sessions skipped at a cap of 40**; newest 500 hold 1 469 commands / 45 errors | `/tmp/tuic9877.log` startup line; `POST /ai/knowledge/sessions {"limit":500}`. F6's unbounded startup load is gone |

The artifact-scan number worth keeping is the timing: **44.65 s of filesystem
walk** is what the Build Cleaner poll used to spend every hour whether or not
anyone was looking, which is what story 617-fa7d gated on panel visibility. Do
not compare it to chunk-9's "5.5 s warm", which never records what tool produced
it.

**Do not read "44.65 s over 406 567 candidate files" as one measurement.** The
two figures come from different walks and are not composable:

- 44.65 s is the real Rust scan driven through HTTP.
- 406 567 is a *separate* Python census that matches on **directory name alone**.
  `walk_artifacts` (`plugin_fs.rs:1393-1420`) additionally requires a sibling
  marker before it accepts `target`/`bin`/`obj`/`build`/`cmake-build`/`.build`/
  `Pods`/`vendor`, and descends through unmarked candidates; it counts through
  `measure_sizes`, which caps at depth 64 and takes regular files only
  (`:1306-1350`). The Python has no such cap, uses the opposite depth convention
  (so it admits one level more), and picks roots differently. It is therefore an
  **upper bound on a looser rule**, not the Rust walk's file count. Its own 16 s
  runtime is Python cost, unrelated to `walk_artifacts`.

The rule table cited elsewhere as `plugin_fs.rs:881-945` is `ARTIFACT_RULES`, not
the walker.

Three caveats that limit these numbers, stated because each one could be misread
as stronger than it is:

- **The watcher figure is a floor, not an all-clear.** Zero suppressed emits was
  measured on an idle instance with no repo mutation in the window. It proves the
  suppressor is quiet under quiescence; it does **not** re-measure the
  `repeat_count: 12` storm behind issue #82, which needs real repo churn.
- **39 repos registered but only 30 watchers started** is a 9-repo gap this pass
  surfaced and did not chase. One repo is explained (its path is gone); the other
  eight are not.
- **F119's wording is wrong in a way that would break a fix.** It ties the empty
  `command` field to *inferred* outcomes. On disk **6 755 of 6 755 (100 %)** have
  an empty command — including all 310 success and all 167 error records. A fix
  that filters on `kind == inferred` would leave 477 equally-empty records behind.
  Whether that is a schema-v2 property or a wider defect was not chased.

### Estimates: retired or measured

Criterion 3 asked for each code-derived estimate to be replaced by a measurement
or explicitly retired. Six are retired because the code that produced them is
gone — a retired estimate is a *zero*, not an unknown.

| Estimate | Outcome | Basis |
|---|---|---|
| **F2** 640 KB/s of `pty-output` JSON | **retired → 0** | The Rust emit is deleted and no listener remains; `transport.ts:2341` documents it and `__tests__/transport.test.ts:2056` asserts no `pty-output` handler exists. No payload, no cost |
| **F4** ~50 % phantom blocks | **retired** | One consumer only; `osc133SingleConsumer.test.ts` fails if a second subscription reappears. The duplicate that produced the 50 % cannot occur |
| **F8** few hundred bytes per closed session | **unbounded leak retired → eventually 0** | All six `DashMap`s now have a removal site. Not literally zero at close, though: `slash_mode`/`last_input_ms`/`has_osc133` go immediately (`pty.rs:5557-5559`), but `marker_stats`/`session_visibility`/`ai_suggestions_enabled` are post-mortem state (`:5615-5617`) that a *normal* exit tombstones (`:6815`) for `TOMBSTONE_TTL_MS` = 5 min before the 30 s sweeper reaps it (`:6857-6877`). An explicit close full-cleans (`:5637-5646`). Bounded by a TTL, not retained |
| **F10** 4 MB / 400 ticks re-parsed | **narrowed, not retired — still unmeasured** | The incremental path exists, but it disables itself: `splitStream` returns `committed: []` and `tail = whole source` for any document containing a reference definition (`incrementalMarkdown.ts:228-234`), so `ContentRenderer` re-renders the full document every tick (`ContentRenderer.tsx:287-289`). `hasReferenceDefinition` (`:136-148`) is a cheap regex first, so the fast path holds for the common document — but the finding's worst case is exactly the document that has one. `parseTweakComments` also runs over the full source on every content change (`ContentRenderer.tsx:296`). No tick cost was measured either way |
| **F20** 7-9 MB/s of decimal-array JSON | **retired** | The channel is `Channel<tauri::ipc::Response>` (`pty.rs:10030`), the raw-bytes path. The `Vec<u8>` → `serde_json::to_string` blanket impl is no longer reached |
| **F22** 260 KB/s into an unbounded `rowCache` | **retired → bounded** | `ROW_CACHE_MAX = 6000` with eviction (`canvasTerminalScroll.ts:9`, `:109-113`). Growth is capped, not merely slower |
| **F28** ticker wakeups | **split verdict, still open** | The thread is unchanged: an unconditional `sleep(TICK)` with `TICK = 16 ms` per session (`pty.rs:7220`, sleep at `:7246`), no condvar and no subscriber check. The scan's "~560 wakeups/s" was never a measurement — it is 9 × 62.5, arithmetic from the constant. The same arithmetic today gives ≈1 560/s at 25 sessions. What *was* measured is process-wide context switches, the closest observable proxy: 282.3 csw/s on an idle 2-session instance, 3 632 csw/s on the 25-session live one, a slope of ≈146 csw/s per session — above the 62.5 ticker floor, consistent with the finding's own note that reader and silence-timer threads add on top. A discrete ticker-attributed wakeup count is **not** obtainable: macOS exposes no unprivileged per-thread wakeup counter (`powermetrics --show-process-wakeups` needs root) and `top`'s IDLEW is the wrong counter — it moved 0.2/s, because a thread in a tight 16 ms sleep never re-enters deep idle. One of the five parked under 602-11ce |

**Correction — mobile polling was NOT retired.** An earlier pass of this document
claimed there was no `setInterval` left in `src/mobile/`. That was wrong: the grep
behind it did not recurse, and missed `src/mobile/utils/visibilityInterval.ts:18`.
The poll is alive at `POLL_INTERVAL_MS = 3_000` (`useSessions.ts:64`, used `:132`).
What the visibility gate does is **pause it while the page is hidden**, not
eliminate it — a visible client still costs 20 polls/min. The measured figures are
in the table above.
