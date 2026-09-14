# Chunk 2b — AI streaming, per-session WS, keystroke emits, panel sync

Scope: the areas chunk 2 explicitly declared "not covered". Same methodology,
severity scale and verification ladder as `performance_scan.md`. Finding ids
F10-F19. Read-only pass; no code was modified.

---

## Files evaluated

| File | Chunk | Date | Verdict |
|---|---|---|---|
| `src-tauri/src/mcp_http/ai_stream.rs` | 2b | 2026-08-16 | clean (both bridges reuse the shared 50 ms batcher / bounded sink) |
| `src-tauri/src/ai_agent/conversation_engine.rs` (`batched_conversation_stream` 394-482, `start_conversation` 266-350) | 2b | 2026-08-16 | clean (coalesced, flush-before-non-text, Lagged does not wedge) |
| `src/utils/aiStream.ts` | 2b | 2026-08-16 | clean (thin WS wrapper, single dispatch) |
| `src/stores/conversationStore.ts` (`applyConversationEvent` 527-668) | 2b | 2026-08-16 | contributes to F10 |
| `src/stores/conversationStore.ts` (registry subscription 1012-1122) | 2b | 2026-08-16 | F11 |
| `src/components/AIChatPanel/AIChatPanel.tsx` (31-35, 294-301, 752-782) | 2b | 2026-08-16 | F10 |
| `src/components/ui/ContentRenderer.tsx` (`processedContent` 173-230, effect 274-288) | 2b | 2026-08-16 | F10 |
| `src-tauri/src/ai_chat_registry.rs` | 2b | 2026-08-16 | F11 |
| `src-tauri/src/mcp_http/ai_terminal.rs` | 2b | 2026-08-16 | clean (per-tool-call dispatcher, not a stream) |
| `src-tauri/src/native_keys.rs` | 2b | 2026-08-16 | clean (edge-triggered; no per-keystroke emit) |
| `src-tauri/src/dictation/fn_key_monitor.rs` | 2b | 2026-08-16 | clean (edge-triggered on the Fn flag only) |
| `src-tauri/src/panel_window.rs` | 2b | 2026-08-16 | clean (window lifecycle only, no sync path) |
| `src/utils/panelSync.ts` | 2b | 2026-08-16 | F12 |
| `src/hooks/useDetachedPanelBridge.ts`, `src/panelAdapters/activity.tsx`, `src/utils/activitySnapshot.ts` | 2b | 2026-08-16 | contribute to F12 |
| `src-tauri/src/diff_triage.rs` (`ProgressSink::emit` 1280-1330, `emit_progress` 1488-1526, `classify_multi_turn` 1336-1472) | 2b | 2026-08-16 | F16 (frequency itself is clean — LLM-turn-gated) |
| `src-tauri/src/improvement_scan.rs` (`emit_proposals_ready` 69-93, `run_improvement_scan_impl` 205-232) | 2b | 2026-08-16 | F17 |
| `src-tauri/src/conflict_assist.rs` (`emit_conflict_assist_status` 33-63) | 2b | 2026-08-16 | clean (one emit per completed operation) |
| `src/stores/githubOps.ts` (`handleEvent` 114-168, listener loop 171-176) | 2b | 2026-08-16 | F16 |
| `src-tauri/src/mcp_http/session.rs` (`handle_ws_session` 1025-1174) | 2b | 2026-08-16 | F15; contributes to F13 |
| `src-tauri/src/mcp_http/session.rs` (`handle_ws_log_session` 1181-1383) | 2b | 2026-08-16 | F14, F19 |
| `src-tauri/src/mcp_http/session.rs` (`handle_ws_grid_session` 1394-1500) | 2b | 2026-08-16 | F18 |
| `src-tauri/src/mcp_http/session.rs` (`trim_screen_chrome` 1519-1523, `get_output` 351-440) | 2b | 2026-08-16 | F19 |
| `src-tauri/src/pty.rs` (ring write + WS broadcast 4605-4613) | 2b | 2026-08-16 | F13 |
| `src-tauri/src/state.rs` (`purge_dead_ws_clients` 2850-2857, `emit_pty_event` 1629-1639) | 2b | 2026-08-16 | F13 |
| `src-tauri/src/state.rs` / `src-tauri/src/terminal_grid.rs` (`screen_log_lines`, `screen_text_rows(_ref)`) | 2b | 2026-08-16 | contribute to F14/F19 |

---

## Findings

### F10 — the AI answer is re-parsed, re-sanitized and re-inserted in full, 20 times a second (P1)

The Rust side is correct: `batched_conversation_stream`
(`conversation_engine.rs:394-482`) coalesces `TextChunk`/`ReasoningChunk` on a
50 ms interval, so at most **20 events/sec** reach any transport. Both the
desktop Channel bridge (`ai_agent/commands.rs:47`) and the browser WS bridge
(`ai_stream.rs:122`) use the same batcher. That is where the coalescing stops.

Each batched chunk lands in `applyConversationEvent`
(`conversationStore.ts:536-543`) as `setStreamingText(prev => prev + text)` —
i.e. the signal holds the **whole answer so far** and changes 20×/s. It is
rendered by `<MarkdownContent content={text()} />` (`AIChatPanel.tsx:767`),
which is `ContentRenderer`. Its `processedContent` memo
(`ContentRenderer.tsx:173-225`) re-runs on every change and does, over the
**entire accumulated string**:

1. `stripAnsiOutsideCodeBlocks` (`:77-90`) — `split("\n")`, a fence regex plus
   `stripAnsi` per line, `join("\n")`
2. `preprocessTildeCheckboxes` (`:99-109`) — another `split`/regex-per-line/`join`
3. `buildCheckboxLineMap` (`:116-131`) — a third `split`, two regexes per line
4. `injectTweakSentinels`, then `marked.parse` of the whole document
5. two global `.replace()` passes over the produced HTML
6. `DOMPurify.sanitize` — parses the whole HTML into a DOM and walks it
7. `<div innerHTML={processedContent()} />` (`:302`) — Solid writes `innerHTML`,
   which **destroys and rebuilds the entire rendered subtree**

Plus a second memo, `tweakComments` (`:230`), running a global-regex scan over
the same raw text, and an effect (`:274-288`) that schedules a `rAF` doing
`querySelectorAll` over the container and `renderMermaidBlocks` (another
`querySelectorAll`) on every change.

On top of that, `AIChatPanel.tsx:294-301` is an effect subscribed to
`streamingText()` that reads `messageListRef.scrollHeight` and writes
`scrollTop` — a forced synchronous layout immediately after the `innerHTML`
replacement, on the same 20 Hz.

The cost is quadratic in answer length: for an answer that ends at *n*
characters streamed over *k* ticks, the total text processed is ~*n·k/2*.
**Estimate, derived from the code and the 50 ms tick — not profiled:** a 20 KB
answer streaming for 20 s = 400 ticks × ~10 KB mean = ~4 MB of markdown parsed
and ~400 full DOMPurify passes and DOM rebuilds, all on the WebView main thread
that also paints the terminal.

Two second-order consequences follow from the `innerHTML` rebuild specifically:
a text selection inside the streaming answer cannot survive a tick, and any
mermaid block re-renders from scratch every tick (`mermaidIdCounter` increments
each time, `:155`). Both are inferred from the mechanism, not observed.

The fix is not "make the parse faster" — it is to stop re-rendering finished
prose. Candidates: re-render on a slower cadence than the token batcher
(the batcher's 50 ms is right for *data*, wrong for *layout*), or split the
rendered document into a stable committed prefix plus a live tail. This is
frontend work, but note the AGENTS.md rule cuts the other way here: the parsing
itself is business logic the frontend is doing per tick.

### F11 — the chat registry has no producer: every subscribe is a dead round-trip that also wipes loaded history (P2)

`ChatRegistry` (`ai_chat_registry.rs:152-264`) is the Rust-side "source of truth
for AI chat conversation state". Nothing writes to it. Grepping
`src-tauri/src` for `chat_registry()`, `fan_out`, `push_message`,
`set_streaming_text` returns exactly one hit outside the file itself:
`ai_stream.rs:148`, the WS bridge — a *reader*. `fan_out` is annotated
`#[allow(dead_code)]` with a `DEFERRED (2026-07-07)` note stating it has no
production caller, and every `ConversationState` setter (`:306-325`) is
`#[allow(dead_code)]` too.

**Measured** on the live instance (`:9876`, 2026-08-16) — connect to the chat
stream and wait 5 s:

```
{"kind":"snapshot","messages":[],"isStreaming":false,"streamingText":"",
 "error":null,"attachedSessionId":null,"pinned":false}
```

…then silence. The snapshot is `ConversationStateSnapshot::default()` and no
further frame ever arrives, exactly as the code predicts.

What still runs on top of that dead backend:

- `AIChatPanel.tsx:285-288` re-subscribes on every `chatId()` change, and
  `subscribeToRegistry` (`conversationStore.ts:1072-1109`) does a full
  `chat_subscribe` IPC round-trip (registered at `lib.rs:1753`) plus a
  `chat_unsubscribe` on teardown.
- `ChatRegistry::get_or_create` (`:166-171`) inserts a slot per chat id;
  `unsubscribe` (`:211-216`) removes only the *subscriber*, never the slot, and
  no `chats.remove`/`retain` exists. One permanently-retained
  `Arc<Mutex<ChatSlot>>` per chat id ever opened, for the process lifetime.
  Small (empty state ≈ a few hundred bytes) but unbounded — same class as F8.

**The part that is not merely wasteful:** `subscribeToRegistry` applies the
returned snapshot unconditionally (`:1092`), and `applyRegistryEvent`'s
`snapshot` arm (`:1014-1026`) does `setMessages([])`, `setIsStreaming(false)`,
`setStreamingText("")`. `loadConversation` (`:1145-1160`) sets `chatId` and
`messages` in one `batch`; the `chatId` change re-fires the effect, and one IPC
round-trip later the empty registry snapshot overwrites the messages that were
just loaded. Same chain from `initFromDisk` (`:488-503`). **Inspection only —
not reproduced at runtime**, see Open questions.

Deleting the subscription path (or giving the registry a real producer) removes
an IPC round-trip pair per chat switch, the slot leak, and the wipe hazard at
once. Note this is *not* the token stream: assisted/autonomous streaming runs
over `start_conversation` (Channel/WS) and does not touch the registry.

### F12 — the detached Activity panel pushes an unconditional full snapshot every second and rebuilds its whole DOM on each one (P2)

`createPanelSyncProvider` (`panelSync.ts:60-101`) is a `setInterval` that calls
`serialize()` and `emitTo(label, "panel-sync", …)` — **no change detection, no
diffing, no dirty flag**. The only projection using it is Activity
(`panelAdapters/activity.tsx:77-78`, `syncIntervalMs: 1000`,
`serialize: buildActivitySnapshot`), wired in `useDetachedPanelBridge.ts:38-46`
while the panel is detached.

Per tick, in the main window: `buildActivitySnapshot`
(`activitySnapshot.ts:128-167`) walks every attached terminal and allocates a
20-field row object each, calls `reconcileActivityOrder` (`:85-95`, which does
`spine.includes(id)` inside a loop over ids — O(N²) in terminal count), then the
whole array is JSON-serialized through `emitTo` → Tauri IPC → the panel webview.

In the panel window, `createPanelSyncReceiver` (`:29-34`) accepts any frame with
a newer `ts` — which at 1 Hz is always — and calls `setState(() => snapshot)`.
`activity.tsx:56-59` then maps it through `snapshotToRows` into a **brand-new
array of brand-new row objects** and `setRows`. `ActivityDashboard.tsx:203`
renders `<For each={terminals()}>`, and Solid's `For` reconciles by *referential*
identity — no item matches, so every row's DOM subtree is disposed and recreated.

Net: with the Activity panel detached, its entire row list is torn down and
rebuilt once per second **whether or not anything changed**, forever. Terminal
count is the multiplier; on an idle machine every one of those snapshots is
byte-identical to the last. Cost is an estimate derived from the code, not
profiled; the DOM-recreation step follows from `For`'s documented semantics.

The receiver already has a `visibilitychange` → `panel-resync-request` handler
(`:38-44`), so a push-on-change design is half-built: the provider could push on
a store-driven effect and keep the timer only as a slow safety net (or drop it,
since resync-on-show already covers the miss case).

### F13 — a browser client that connects once makes the PTY reader copy every chunk forever (P2)

`pty.rs:4605-4613`, inside the per-chunk reader loop:

```rust
if let Some(mut clients) = state.ws_clients.get_mut(session_id) {
    let owned = data.to_owned();
    clients.retain(|tx| tx.send(owned.clone()).is_ok());
}
```

`ws_clients` has **no entry** until an HTTP WS client subscribes
(`mcp_http/session.rs:1063-1067`), so a pure-desktop session pays nothing. But
`purge_dead_ws_clients` (`state.rs:2850-2857`) only does
`clients.retain(|tx| !tx.is_closed())` — it never removes the map entry when the
vector becomes empty. So once any browser/PWA/mobile client has attached to a
session and disconnected, `get_mut` keeps returning `Some(empty_vec)` and the
reader allocates a full `String` copy of every chunk (up to the 64 KB read size)
and takes a `DashMap` shard lock, per chunk, for zero recipients, for the rest of
the session's life.

With one live client the same code pays two copies per chunk (`to_owned` then
`owned.clone()`); the `to_owned` exists only to satisfy the `clone()` inside
`retain`, and an `Arc<str>` would make it one. Upper bound **estimated** from the
same numbers as F2 (64 KB reads, ~10 reads/s on a busy session): ~640 KB/s of
pure copy per affected session. The fix is two lines — hoist the emptiness check,
and have `purge_dead_ws_clients` remove the entry when the vector empties.

### F14 — the log-mode WS materializes the whole styled screen 5×/s under the VtLogBuffer lock, before checking whether it changed (P2)

`handle_ws_log_session` (`mcp_http/session.rs:1181-1383`) serves the mobile
client (`src/mobile/components/OutputView.tsx:154-170` is the only caller of
`format: "log"`). Its poll arm runs every 200 ms and does, **all while holding
`vt_log.lock()`** (`:1310-1318`):

- `buf.lines_since_owned(offset, usize::MAX)` — owned `LogLine`s
- `trim_screen_chrome(buf.screen_rows())` — clones the cached `Vec<String>` (see F19)
- `buf.screen_log_lines()` — walks every screen row × every cell and builds a
  fresh `Vec<LogLine>` of `Span { text: String, … }`
  (`terminal_grid.rs:954-961` → `state.rs:3784-3798`)
- `buf.prompt_input_text()`

Only *after* the lock is released does it hash the spans and compare
`screen_hash` to decide whether to send (`:1319-1331`). So on an idle session the
full styled screen is rebuilt and hashed five times a second and then thrown
away — the change check is downstream of the work it should be gating. The same
lock is what the PTY reader takes to append, so this is also lock contention on
the hottest path, not just allocation churn.

Cost scales with (connected mobile clients × screen area), 5 Hz each. Not
measured — derived from the code. A cheap fix exists without redesign: the grid
already tracks damage, so a "screen unchanged since last poll" flag (or hashing
the borrowed `screen_rows_ref()` before building the styled version) would skip
the whole block.

Structural note, not filed as a finding: the `select!` at `:1252-1271` builds a
fresh `sleep(200ms)` each iteration, so a per-session PTY event resets the poll
timer. If those events ever arrived faster than 5 Hz the log/screen arm would
starve. They do not today — `emit_pty_event` (`state.rs:1629-1639`) carries only
`PtyParsed`/`PtyExit`/`SessionClosed`/`PtyDescriptionChanged`, all edge-triggered
or deduped (chunk 2, F9). Worth an interval-based timer if that ever changes.

### F15 — the raw-output WS uses an unbounded channel with no backpressure, alone among the three stream types (P2)

`mcp_http/session.rs:1055` creates the per-client delivery channel as
`tokio::sync::mpsc::unbounded_channel::<String>()`. The producer is the PTY
reader (F13), which pushes every chunk. If the client stops draining — a
backgrounded browser tab whose JS thread is blocked, a stalled TCP window — the
queue grows with no ceiling and no eviction.

The other two stream types in the same codebase both chose a bound:

| Stream | Sink | Behaviour when the consumer stalls |
|---|---|---|
| chat registry (`ai_chat_registry.rs:77-101`) | `mpsc::channel(256)` + `try_send` | full ⇒ subscriber declared dead and GC'd |
| grid (`session.rs:1398-1441`) | `tokio::sync::watch` | latest-frame-wins, intermediate frames dropped |
| **raw output** (`session.rs:1055`) | `unbounded_channel` | **grows without limit** |

Order-of-magnitude, **estimated** from F2's 640 KB/s upper bound: a 30 s stall on
one busy session ≈ 19 MB queued for one client. The comment at
`ai_chat_registry.rs:74-77` already articulates the right policy for exactly this
situation; the raw path just predates it. Note the trade-off is real — raw PTY
bytes are a stateful stream, so dropping the middle corrupts the client's VT
state (the F1 lesson). The correct bound is therefore "bounded + disconnect the
client", as the chat sink does, not "bounded + drop".

### F16 — `review-progress` ships the full classification vector so the frontend can read `.length`, and that length is always 1 or 0 (P3)

`ProgressSink::PrReview::emit` (`diff_triage.rs:1298-1327`) dual-emits a payload
containing `"files": files` — `Vec<FileClassification>`, each with path, category,
summary, rationale, relevance, additions, deletions, source.

There is exactly one frontend consumer (`githubOps.ts:122-135`; grepping `src/`
for `review-progress` finds no other listener), and it keeps:

```ts
const findingsCount = Array.isArray(files) ? files.length : …;
```

Nothing else from `files` is stored. That is methodology A.1 — a payload crossing
the boundary so the frontend can derive a scalar Rust already has.

It is also wrong. Every PR-review call site passes either one file
(`classify_multi_turn:1399`, `:1456` — `&[fc.clone()]`) or none
(`:1376` overview, `:1902` done — `&[]`); the multi-file batch emit at `:1574`
belongs to the *triage* variant, not PR review. So `findingsCount` is 1 during
the run and **0 after the terminal "done" frame** — and
`GithubOpsDashboard.tsx:159` renders `Findings: {r.findingsCount}`, i.e. a
completed review always displays `Findings: 0`. Inspection-verified; not observed
in the UI.

Sending a `findings_count: usize` (or accumulating in the store) fixes both the
payload waste and the number. Minor related note in the same file: `OPS_EVENTS`
includes `autofix-status`, whose handler (`githubOps.ts:161-165`) documents that
there is no producer and nothing to do — a listener registered for a dead event.

### F17 — improvement-scan proposals are delivered twice for a single user action (P3)

`run_improvement_scan_impl` (`improvement_scan.rs:205-232`) calls
`emit_proposals_ready(state, &repo_path, &result)` and *then* returns `result`.
The frontend consumes both: `githubOps.ts:191` writes `result.proposals` from the
invoke return, and the `proposals-ready` listener (`:148-156`) writes the same
proposals into the same store slot.

`emit_proposals_ready` (`:69-85`) serializes the result to a
`serde_json::Value`, emits it to the window, and clones it onto the event bus —
three serializations for a payload capped at 5 proposals
(`parse_improvement_output:107`), once per user-triggered scan. Trivial in
absolute terms; filed because it is a duplicate-delivery pattern (A.3) and
because the event exists for browser/SSE parity, where the invoke already
carries the answer. One of the two paths is redundant on *both* transports.

### F18 — the grid WS clones each frame per client and retains the last frame per session forever (P3)

`state.grid_watch` is `DashMap<String, watch::Sender<Vec<u8>>>` (`state.rs:1305`).
`handle_ws_grid_session:1431` does `frame_rx.borrow_and_update().clone()`, so
each connected browser client copies the entire serialized frame; the producer
already paid one copy to `send` it. `watch::Sender<Arc<[u8]>>` would make the
per-client cost a refcount bump.

Also: a `watch` retains its last value indefinitely, so every session that has
ever produced a grid frame holds one serialized frame resident even with zero
subscribers. Bounded at one frame per session, so it is a footnote, not a leak —
recorded because it is invisible from the call sites.

The frame *producer* (`serialize_dirty_rows`, damage tracking, the desktop
`Channel::send`/ack protocol) is chunk 3's area and was deliberately not read
beyond confirming what the watch carries.

### F19 — `trim_screen_chrome` takes the screen by value, forcing a clone that the codebase elsewhere explicitly avoids (P3)

```rust
fn trim_screen_chrome(rows: Vec<String>) -> TrimResult {   // session.rs:1519
    let refs: Vec<&str> = rows.iter().map(|s| s.as_str()).collect();
    let cutoff = find_chrome_cutoff(&refs).unwrap_or(rows.len());
    TrimResult { cutoff }
}
```

It consumes an owned `Vec<String>` only to immediately borrow every element. All
three production callers therefore call `buf.screen_rows()`
(`session.rs:377` — the HTTP `/output` handler; `session.rs:1313` — the 5 Hz log
poll of F14), which is `screen_text_rows()` → `self.prev_rows.clone()`
(`terminal_grid.rs:628-634`): a full clone of the cached screen.

The borrowed accessor exists for exactly this, and its doc comment says so
("avoids cloning when the caller only needs `&[String]` and holds the lock",
`terminal_grid.rs:636-645`). `pty.rs:4336-4340` uses it with the comment *"Use
`screen_rows_ref()` to avoid cloning `prev_rows` for the chrome cutoff"* — so the
optimisation was made deliberately on the desktop path and never applied to the
HTTP one. Changing the signature to `&[String]` is mechanical and makes all three
call sites allocation-free (the callers already hold the lock).

---

## Not covered

- **Grid-frame producer path** (`serialize_dirty_rows`, damage tracking, desktop
  `Channel::send`/`ack_terminal_frame`) — chunk 3's area, read only far enough to
  characterise what `grid_watch` carries (F18).
- **Solid re-render fan-out downstream of F10/F12.** F10 stops at the
  `innerHTML` write and F12 at `<For>`'s reconciliation; neither follows the
  effect/memo graph further. That is chunk 4.
- **`ai_agent/tools::dispatch`** and the tool implementations behind
  `ai_terminal_*` — only the MCP wrapper (`ai_terminal.rs`) was read.
- **`run_conversation` itself** (`conversation_engine.rs:~520-1330`): the LLM
  turn loop, history compaction, and `assemble_context`/`summarize_for_repo`
  callers. Only the event-emission and batching surface was read. F6 already
  flags `summarize_for_repo`'s O(sessions) lock scan on this path.
- **`diff_triage.rs` beyond the emit protocol** (3255 lines: heuristics, `do_turn`,
  session caching). The 6 emit sites and their fan-out were read; the
  classification engine was not.
- **The mobile client's consumption of log frames** (`OutputView.tsx`) — read only
  to establish that it is the sole `format=log` caller.
- **No profiling was run.** F11's empty snapshot is measured on the live
  instance over the wire. Everything else is code inspection, with every quantity
  explicitly labelled as an estimate and its derivation stated.

---

## Open questions

- **F11's history wipe is inspection-only.** The chain
  (`loadConversation` sets `chatId` → `AIChatPanel.tsx:285` effect →
  `chat_subscribe` → empty snapshot → `setMessages([])`) is complete in the code,
  but "open a conversation from history and watch it clear" was not reproduced —
  doing so means driving Boss's live AI panel. Worth 60 seconds with a throwaway
  conversation before anyone deletes the subscription path, because if the wipe
  *doesn't* happen there is a mechanism here I have not found.
- **How many chat ids does a long session accumulate?** The slot leak in F11 is
  one entry per `chatId` ever subscribed. `generateChatId`/`new_conversation_id`
  are called on new-chat, clear-history and per-terminal state creation, so the
  rate is user-driven and I did not bound it.
- **Is the detached Activity panel actually used?** F12's cost is zero unless the
  panel is detached. If it is a rarely-used feature the finding drops to P3; if
  Boss keeps it open on a second monitor it is a permanent 1 Hz DOM rebuild. I
  did not check `uiStore.state.detachedPanels` on the live instance.
- **F15's stall scenario is unquantified.** Whether a backgrounded browser tab
  actually stops draining a WebSocket (rather than the OS buffering it
  transparently) depends on the browser's throttling policy; I asserted the
  unbounded queue, not the frequency of the stall that fills it.
- ~~`ai_terminal.rs::tool_definitions()` rebuilds 13 `serde_json::Value`s on every
  call — is that per `tools/list` or per dispatch?~~ **Answered:** per
  `tools/list` only. `filtered_native_tools` (`mcp_transport.rs:1226`) has two
  callers — `merged_tool_definitions_for_mode` (`:1267`, one `tools/list`
  request) and `searchable_tool_definitions` (`:1425`), which feeds
  `rebuild_tool_search_index` (`:1435`), and that runs on a change signal into a
  cached `tool_search_index`, not per dispatch. Not a finding.
