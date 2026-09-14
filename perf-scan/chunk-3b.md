# Chunk 3b — Terminal input half: keyboard, mouse, selection/search/links, resize/reflow

Findings F90-F99. Format mirrors `performance_scan.md` / `perf-scan/chunk-3.md`.
Read-only pass; no code was modified, no session was created or closed on Boss's
live instance.

**Context inherited from chunk 3 and used here without re-deriving it:** desktop
grid frames cross the IPC as JSON `number[]` (F20); every terminal stays mounted
and a hidden one runs the whole frame pipeline and acks first (F21); the vt mutex
is held across frame serialization and contends with PTY byte intake (F26).

Two multipliers recur below and are stated once: **12 live sessions** (measured,
`GET :9876/sessions`, 2026-08-16) and **`GRID_SCROLLBACK = 10_000`**
(`src-tauri/src/state.rs:3608`). Every size figure is derived from code and is
labelled an estimate unless marked measured.

---

## Files evaluated

| File | Area read | Verdict |
|---|---|---|
| `src/components/Terminal/CanvasTerminal.tsx` (keydown 2189-2463, keyup 2466-2473, paste 2475-2495) | per-keystroke handler | F99 |
| `src/components/Terminal/CanvasTerminal.tsx` (`writePty`/`writePtyNoScroll` 241-257) | keydown → IPC | F91, F95 |
| `src/components/Terminal/CanvasTerminal.tsx` (hidden `<input>` wiring 2096-2185) | IME/composition/mobile input | clean (composition state is O(1), no per-key alloc) |
| `src/components/Terminal/CanvasTerminal.tsx` (mouse 2501-2727, scrollbar 2776-2830) | selection + document listeners | **F90** |
| `src/components/Terminal/CanvasTerminal.tsx` (`canvasToGrid` 326-338) | pointer → cell | F90 |
| `src/components/Terminal/CanvasTerminal.tsx` (`runSearchQuery` 529-576, frame hook 1453-1461) | search refresh loop | F93 |
| `src/components/Terminal/CanvasTerminal.tsx` (`verifyVisibleFileLinks` 1595-1743, `checkLinksAtRow` 1747-1900) | link IPC cost | F94 |
| `src/components/Terminal/CanvasTerminal.tsx` (`updateSuggestOverlay` 877-946) | overlay rebuild | F96 |
| `src/components/Terminal/CanvasTerminal.tsx` (`remeasure` 354-444, ResizeObserver 2029-2033) | resize trigger | F98 (trigger is clean) |
| `src/components/Terminal/CanvasTerminal.tsx` (`copySelection` 3033-3067) | clipboard IPC | clean (1 IPC per copy, bounded by selection) |
| `src/components/Terminal/terminalInput.ts` | key → escape sequence | F99 |
| `src/components/Terminal/kittyKeyboard.ts` | CSI-u encoding | clean (pure, 4-arm switch, no alloc beyond the result) |
| `src/components/Terminal/canvasTerminalBindings.ts` | listener registry | clean (thin, disposes in reverse) |
| `src/components/Terminal/canvasTerminalTouch.ts` | touch/momentum | clean (rAF momentum, bounded `moveHistory`); registered unconditionally — see Open questions |
| `src/components/Terminal/canvasTerminalSelection.ts` | selection/search controllers | clean (no IPC, no per-frame work) |
| `src/components/Terminal/canvasTerminalLinks.ts` | verification throttle + caches | bounded (`rowCache` 200 FIFO at `CanvasTerminal.tsx:1836`), feeds F94 |
| `src/components/Terminal/suggestOverlay.ts` | `isSuggestBlock`, `continuationRowsAfterSuggest` | F96 |
| `src/components/Terminal/canvasTerminalTransport.ts` (`TauriTransport.invoke` 75-81) | desktop invoke path | clean — bypasses `rpc()`, so no `mapCommandToHttp` per call |
| `src/transport.ts` (`queuedWrite` 1998-2014, `rpc` 2022-2041) | browser-mode write path | F99 |
| `src/platform.ts` (`detectPlatform` 11-27) | per-keystroke platform checks | F99 |
| `src-tauri/src/pty.rs` (`write_pty` 7709-7846) | keystroke → PTY | **F91**, F92 |
| `src-tauri/src/pty.rs` (`stamp_input_ms` 6791-6801, `raise_thread_for_interactive_io` 455-463) | QoS + stamping | F91, F92 |
| `src-tauri/src/pty.rs` (grid read commands 9529-9776) | sync command surface | **F95**, F93 |
| `src-tauri/src/pty.rs` (`resize_session_core` 7919-8010, `resize_pty` 8016-8029) | resize path | F98 |
| `src-tauri/src/input_line_buffer.rs` (`feed` 57-65, `content` 67-70) | input reconstruction | F91 |
| `src-tauri/src/state.rs` (`resolve_choice_prompt_input` 386-411) | per-keystroke hook | clean (early-returns before any work) |
| `src-tauri/src/state.rs` (`VtLogBuffer::process` 3640-3680, `resize_with_shell_state` 3693-3717, grid delegates 3858-3969) | per-chunk + resize | F97, F98 |
| `src-tauri/src/terminal_grid.rs` (`process` 484-541) | damage fast path | **F97** |
| `src-tauri/src/terminal_grid.rs` (`search` 1292-1343) | scrollback search | F93 |
| `src-tauri/src/terminal_grid.rs` (`read_screen_text` 1753-1773, `row_to_text` 1775-1793, `read_rows_in_range` 1274-1287, `get_logical_line` 1405, `get_selection_text` 1471) | scrollback readers | F97 (readers themselves are proportional, clean) |
| `src-tauri/src/terminal_grid.rs` (`resize_with_mode` 824-832) | reflow entry | F98 |
| `src-tauri/src/fs.rs` (`resolve_terminal_path` 1578-1612) | link resolution | F94 |
| `src-tauri/patches/alacritty_terminal/.../term/mod.rs` (`resize_reflow` 818-872) | reflow | F98 |
| `src-tauri/patches/alacritty_terminal/.../grid/resize.rs` (`grow_columns` 114-305, `shrink_columns` 307-…) | reflow inner loop | F98 |
| `src-tauri/patches/alacritty_terminal/.../term/search.rs` (`RegexSearch::new` 34-60, `regex_search_right` 264-275, `regex_search_internal` 294-) | search engine | F93 |
| `tauri-macros-2.6.3/src/command/wrapper.rs` (50, 158-160, 248-253, 264) | command execution context | **F95** |

---

## Findings

### F90 — every mounted terminal puts two `mousemove` listeners on `document`; a hidden one writes to its PTY and probes the backend on mouse moves that never touched it (P1)

`CanvasTerminal` registers four **document-level** listeners per instance:

```ts
// CanvasTerminal.tsx:2703-2704
bindings.listen(document, "mousemove", onMouseMove);
bindings.listen(document, "mouseup", onMouseUp);
// CanvasTerminal.tsx:2829-2830
bindings.listen(document, "mousemove", onScrollDragMove);
bindings.listen(document, "mouseup", onScrollDragUp);
```

Nothing unmounts a background terminal (chunk 3 F21, `TerminalArea.tsx:145-178`
+ `styles.css:103-114`), so with the 12 sessions measured on Boss's instance a
single mouse move anywhere in the window — sidebar, settings, a git panel — runs
**24 handlers**. Neither handler tests `hidden`, and neither tests whether the
pointer is over its own canvas.

That is the cheap part. Two consequences are not:

**1. SGR mouse reports are written to hidden PTYs.** `onMouseMove`'s first branch
(`CanvasTerminal.tsx:2644-2652`) reads `currentFrame.mouseMode`, which the
`hidden` path never clears (`:2070-2080` shrinks the canvases and clears
`rowMap`/`fileLinkCache` — `currentFrame` survives, and chunk 3 F21 established
that frames keep arriving and updating it). So for **any** background session
whose app enabled motion tracking (`mouseMode >= 3`, i.e. DECSET 1003 — lazygit,
htop, btop, vim with `mouse=a` variants; bits 3-4 of the frame flags,
`terminal_grid.rs:1550`, `canvasTerminalUtils.ts:227`):

```ts
const pos = canvasToGrid(e);
writePtyNoScroll(sgrMouseSequence(35, pos.col, pos.row, true, e));
```

one `write_pty` IPC per mouse-move event, per such session. `mouseMode >= 2`
(1002, drag) fires the same way whenever any button is down — dragging a split
divider or selecting text elsewhere in the app feeds drag reports to every
background mode-2 terminal.

The coordinates are garbage: the canvas is inside a `display:none` pane, so
`getBoundingClientRect()` returns zeros, and `canvasToGrid`
(`CanvasTerminal.tsx:326-338`) clamps `maxCol`/`maxRow` to 0 → every report is
`\x1b[<35;1;1M`. So the hidden app receives a continuous stream of "pointer at
cell 1,1", which is also PTY traffic that wakes it, makes it repaint, and feeds
straight back into the F20/F21 frame amplification.

Amplitude (estimate, derived from the handler shape — WebKit coalesces
`mousemove` to the display refresh): ~60-120 events/s × (number of background
sessions with mouse tracking on) `write_pty` calls, each paying the full
per-keystroke Rust path of F91.

**2. Link probing fans out to every terminal.** The last branch
(`:2665-2671`) arms a 100 ms trailing `setTimeout` → `checkLinksAtRow(pos.row,
pos.col)`. Because the listener is on `document`, a mouse pause **anywhere**
fires it on all mounted terminals at once. `checkLinksAtRow`
(`CanvasTerminal.tsx:1747-1800`) issues `terminal_hyperlink_span` and
`terminal_get_row_text` **before** consulting `linkCache` — two unconditional
IPCs, each taking the session's vt mutex (F95), per terminal, per mouse pause.
On hidden terminals `pos` is always `(0,0)`, so they all probe row 0 forever.

The fix is small and local: an early `if (hidden) return;` in both document
handlers, plus a bounds test against the own canvas rect before the mouse-mode
branch. Note the mouse-mode branch is also the only one that runs *before* any
`selection.selecting` test, so a guard must be placed at the top of the function,
not inside the selection block.

### F91 — the per-keystroke Rust path rebuilds the whole typed line as a fresh `String`, plus three key clones (P2)

`write_pty` (`src-tauri/src/pty.rs:7709-7846`) runs on every keystroke,
every mouse report from F90, and every dictation/palette write. Per call, before
and after the actual PTY write:

| Site | Work per call |
|---|---|
| `pty.rs:7737` | four `data.contains(&str)` scans for DEC private-mode sequences |
| `pty.rs:7774` | `input_buffers.entry(session_id.clone())` — a `String` clone for a key that already exists |
| `pty.rs:7778` | `buf.content()` → `self.chars.iter().collect::<String>()` (`input_line_buffer.rs:68-70`) |
| `pty.rs:7763` → `:6798` | `last_input_ms.entry(session_id.to_string())` — second key clone, to store a `u64` |
| `pty.rs:7831` | `slash_mode.entry(session_id.clone())` — third key clone, to store a `bool` |

`content()` is the one that matters. It allocates a `String` holding the **entire
current input line** on every keystroke, and the only two consumers are
`buffer_content.starts_with('/')` and `buffer_content.is_empty()`
(`pty.rs:7827`, `:7835`). Typing an *n*-character prompt therefore allocates and
copies 1+2+…+*n* characters — quadratic in the line length. For a 400-character
prompt pasted or typed into an agent that is ~80,000 characters copied for two
predicates that need only `chars.first()` and `chars.is_empty()` (estimate,
derived from the loop; not profiled).

The three `entry(id.clone())` calls are three 36-byte UUID allocations per
keystroke where `get()`-then-`entry()`-on-miss would allocate only on first use.
Individually trivial; the reason to record them is that F90 turns this path into
a ~100 Hz loop driven by mouse motion rather than by human typing.

`resolve_choice_prompt_input` (`state.rs:386-411`) is on this path too and is
clean — it early-returns on `session_states` miss and again on
`choice_prompt.is_none()` before touching anything.

### F92 — each keystroke permanently promotes one shared tokio blocking-pool thread to `USER_INTERACTIVE` (P3)

`write_pty` is `async` and immediately does `tokio::task::spawn_blocking`
(`pty.rs:7716`), whose first statement is `raise_thread_for_interactive_io()`
(`:7720`) → `pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0)`
(`:435-440`). The comment calls it "idempotent per call; bumps whichever
blocking-pool thread serves this keystroke".

The bump is not scoped to the task — it is a property of the OS thread, and the
thread goes straight back into the **shared** blocking pool. The codebase has
**210 `spawn_blocking` call sites** (measured, `grep -rn spawn_blocking
src-tauri/src | wc -l`) across `git.rs`, `content_index.rs`, `github.rs`,
`fs.rs`, `git_graph.rs`, `improvement_scan.rs`, `knowledge.rs` and more. Those
tasks land on the same pool, so after a typing session an arbitrary and growing
share of the pool runs a BM25 index build or a `git status` at the same QoS band
as the terminal cursor.

The codebase already knows the bump is sticky: the QoS unit test wraps it in a
dedicated thread precisely "so we don't leave the test runner's worker
permanently bumped" (`pty.rs:9811-9812`).

P3 rather than higher because the effect is priority inversion under contention,
not wasted work, and it was not measured. The dedicated reader and ticker threads
(`pty.rs:6879`, `:7056`) are the intended users of this call — they own their
threads for the session lifetime, which is exactly the property the
`spawn_blocking` site lacks.

### F93 — while the search box has a query, a redrawing terminal re-compiles four DFAs and rescans the whole scrollback every 150 ms, on the IPC thread, under the vt lock (P2)

`onFrame` schedules a re-search whenever the frame rewrote rows that could hold
matches (`CanvasTerminal.tsx:1453-1461`), debounced 150 ms
(`SEARCH_REFRESH_DEBOUNCE_MS`, `:83`). Each fire is one `terminal_search` invoke
(`:535`).

`terminal_search` (`pty.rs:9630-9656`) takes `vt.lock()` and calls
`TerminalGrid::search` (`terminal_grid.rs:1292-1343`), which:

1. builds a fresh `RegexSearch` **per call** — four lazy DFAs plus their NFAs
   (`patches/…/term/search.rs:34-60`); no cache keyed on the query exists;
2. walks `topmost_line()..bottommost_line()` — the full history **plus** screen —
   character by character through the DFA (`regex_search_right` → `regex_search_internal`,
   `search.rs:264-275`, `:294-`). A query with **no** match walks the entire
   range: 10,000 scrollback lines × the column count ≈ **2M cells per fire**
   (estimate, derived from `GRID_SCROLLBACK` and the iterator; not profiled).

All of it under the vt mutex that chunk 3 F26 showed the PTY reader and the frame
ticker also contend for, and on the IPC callback thread (F95). It also emits a
`tracing::info!` per call (`pty.rs:9640-9648`), i.e. up to ~6.7 app-log lines/s
per searching terminal.

The debounce is a *resettable trailing* timer, which produces the inverse of the
intended behaviour at the two ends: under continuous output (>6.7 frames/s) it
never fires and the highlights stay dropped by `search.dropRows` until output
stops; at 3-5 frames/s it fires on almost every frame. Two cheap fixes are
independent: cache the compiled `RegexSearch` on the session keyed by query
string, and make the refresh a leading-edge throttle so it fires at a bounded
rate instead of only at quiescence.

### F94 — file-link verification issues one filesystem-resolving IPC per path candidate per row, awaited row-serially, up to ~6.7×/s (P2)

`verifyVisibleFileLinks` (`CanvasTerminal.tsx:1595-1743`) is armed from `onFrame`
(`:1546`, correctly behind the `hidden` return at `:1542`) through a 150 ms
one-shot throttle (`canvasTerminalLinks.ts:51-57`). Each pass:

- `rowToText` for every visible row, twice (single-row scan `:1607`, wrap scan
  `:1687`) — chunk 3 F25 owns that cost;
- for every regex candidate on every row, one `resolve_terminal_path` invoke,
  and the outer loop **awaits each row's batch before starting the next**
  (`:1635-1650`): `for (const item of toCheck) { await Promise.all(...) }`;
- for every full-width row containing `http`/`file://`, one
  `terminal_get_logical_line` invoke (`:1694`), also awaited in sequence, each
  one taking the vt lock.

`resolve_terminal_path` (`src-tauri/src/fs.rs:1578-1612`) is not a lookup — it is
`PathBuf::canonicalize()` (a `realpath` syscall chain) plus `is_dir()` (a second
`stat`), and it is a **sync** command, so it runs inline on the IPC thread (F95).

The cache does not save the common case. `fileLinkCache` is keyed by the **full
row text** (`:1609`), and a negative result is re-checked after
`FILE_LINK_RECHECK_MS = 3_000` (`:1612`). Agent output rewrites row text
continuously, so on an active terminal nearly every pass is a cache miss. The
worst realistic shape is an agent printing a file list or a diff: ~30 path-like
tokens on screen that mostly do **not** resolve → ~30 `canonicalize` round trips
per pass, up to 6.7 passes/s, per visible terminal (estimate, derived from the
loop structure and the throttle constant; not measured).

Verified the consumer before calling it waste: the result feeds only
`fileLinkCache` → `scanRowForLinks` → a dashed underline. Rust already owns the
row text and the cwd; the whole pass is one `resolve_terminal_paths(cwd,
Vec<String>) -> Vec<Option<…>>` batch command away from a single round trip, and
belongs in Rust under the AGENTS.md "all business logic in Rust" rule for the
same reason chunk 3 F25 flags the URL scan.

### F95 — every terminal grid read is a *sync* `#[tauri::command]`, so it runs inline on the IPC callback thread while holding the vt mutex (P2)

`tauri-macros` defaults a command to `ExecutionContext::Blocking`
(`tauri-macros-2.6.3/src/command/wrapper.rs:50`) and only switches to `Async`
when the function is declared `async` (`:158-160`) or annotated
`#[tauri::command(async)]`. `Blocking` selects `body_blocking`
(`:248-253`); the macro's own `kind` label for a sync fn under `Async` would be
`"sync_threadpool"` (`:264`) — which is exactly what these commands do **not**
get.

Every grid command in `pty.rs:9529-9776` is sync and takes the vt lock inline:

| Command | Line | Work under the lock |
|---|---|---|
| `terminal_scroll` | 9531 | `grid_scroll` + `serialize_dirty_rows` + `send_grid_frame` |
| `terminal_scroll_to` | 9580 | same |
| `terminal_styled_rows` | 9565 | `serialize_styled_range` (64 rows ≈ 141 KB, chunk 3 F20) |
| `terminal_search` | 9630 | full scrollback DFA walk (F93) |
| `terminal_get_logical_line` | 9690 | wrap walk + string build (F94) |
| `terminal_get_row_text` / `terminal_hyperlink_span` | 9676 / 9766 | per hover, ×N terminals (F90) |
| `terminal_get_selection_text` | 9704 | bounded by the selection — fine |
| `resize_pty` | 8016 | full history reflow (F98) |

`write_pty` is the counter-example and is right: it is `async` **and** wraps its
body in `spawn_blocking` (`pty.rs:7716`), and its cursor-restore takes the vt
lock with `try_lock` specifically so a contended lock can never delay a keystroke
(`:7728-7733`, with the rationale in the comment). Nothing else on this surface
follows that pattern.

This is the structural finding the three above hang on: F93's 2M-cell scan, F94's
`canonicalize` syscalls and F98's reflow are all *serialized against the IPC
message pump* rather than dispatched, and all of them are also serialized against
the PTY reader through the vt mutex (chunk 3 F26). Marked P2 and not P1 because I
did not measure the actual duration of any of these calls, only their shape.

### F96 — once a `suggest:`/`intent:` row is on screen, the overlay re-stringifies the whole screen and builds throwaway DOM every frame (P2)

`updateSuggestOverlay` (`CanvasTerminal.tsx:877-946`) runs from `paintFrame`
(`:454`), i.e. every frame. Its dirty-row fast path (`:887-902`) exits early
**only when `lastSuggestOverlayKey === ""`**. As soon as one suggest or intent
block is visible the key is non-empty, so every subsequent frame falls through to
the full path:

- a `numRows` loop calling `getRowSnapshot` → `rowToText` (`:907-913`);
- per anchor row, `isSuggestBlock` (`suggestOverlay.ts:61-83`) calls
  `getRow(anchorIndex)` again and then walks continuation rows, each call
  re-running `rowToText` on the same `DecodedRow` — **no memoisation anywhere**;
- `continuationRowsAfterSuggest` (`suggestOverlay.ts:31-50`) walks the same rows
  a third time;
- `makeOverlayDiv` (`:868-872`) `document.createElement`s a `<div>` and builds a
  template-literal `cssText` for **every** matched row, and only afterwards does
  `if (newKey === lastSuggestOverlayKey) return` (`:939`) discard them all.

So the steady state for a terminal showing a suggest block is: ~3× `numRows`
`rowToText` calls per frame (each 200 `String.fromCodePoint` + 200 rope appends,
chunk 3 F25) plus N discarded DOM elements per frame. This is not an edge case —
the TUIC MCP protocol requires an agent to emit `suggest: [ … ]` after every task,
so it is the resting screen of an idle agent tab.

Two independent fixes: memoise the row text on `DecodedRow` (also collapses F25's
2-3 calls to 1), and compute `parts`/`newKey` first, comparing before any
`createElement`.

### F97 — while the user is scrolled back, every PTY chunk rebuilds and diffs the entire screen (P2)

`TerminalGrid::process` (`terminal_grid.rs:484-541`) prefers alacritty's
parse-damage set, but falls back to the full read+diff when:

```rust
// terminal_grid.rs:498-500
let must_full = self.prev_rows.is_empty()
    || self.term.grid().display_offset() != 0
    || matches!(parse_damage, TermParseDamage::Full);
```

`display_offset != 0` is precisely "the user scrolled up", and the in-code
rationale is correctness (sidestepping a viewport-vs-grid index mismatch), not
cost. The consequence is that reading scrollback while an agent is producing
output flips the hot per-chunk path to `read_screen_text()`
(`terminal_grid.rs:1753-1773`) — one fresh `String` per screen row with a
`String::with_capacity(num_cols)` and a per-cell push, then a full-screen string
comparison, **per PTY chunk**, and `self.prev_rows = curr_rows` replaces the
whole vector.

That is `screen_lines` allocations per chunk instead of one per genuinely damaged
row, held under the vt mutex the ticker also wants (chunk 3 F26), in the exact
scenario where the user is already asking the terminal to do more work (the
scroll path in chunk 3 F20/F22). Scrolled-back reading is a normal thing to do
while an agent works; it should not switch the intake path to its slowest mode.

Not filed against the readers themselves: `row_to_text` (`:1775-1793`),
`read_rows_in_range` (`:1274-1287`), `get_logical_line` (`:1405`) and
`get_selection_text` (`:1471`) are all proportional to what they return and
allocate one `String` per row, which is the minimum for their signatures.

### F98 — a resize reflows the entire 10,000-row ring synchronously on the IPC thread, and a tab switch after a window resize pays it (P2)

`resize_pty` (`pty.rs:8016-8029`) is sync (F95). Inside `resize_session_core`
(`:7967-7978`) it takes the vt lock and calls `resize_with_shell_state`, which
selects `ReflowMode::All` for any non-alt primary grid
(`state.rs:3706-3711`) and calls `TerminalGrid::resize_with_mode`
(`terminal_grid.rs:824-832`) → `Term::resize_reflow`
(`patches/…/term/mod.rs:818-872`).

`ReflowMode::All` makes `reflow_for(i)` return true for **every** buffer index
(`grid/resize.rs:123-124`, `:315-316`), so `grow_columns`/`shrink_columns`
process the whole ring: `raw.take_all()` moves every row out, two `Vec<Row<T>>`
of `raw.len()` capacity are built (`resize.rs:144-147`, `:328`), rows are split
or merged cell-by-cell, and `replace_inner` installs the result. Then
`prev_rows.clear()` + `mark_fully_damaged()` (`terminal_grid.rs:830-831`) force
the next frame to be a full screen — chunk 3's F20 cost — and `serialize_dirty_rows`
runs immediately, still under the same lock (`pty.rs:7974`).

Per-row cost is a `Vec<Cell>` move or copy. `Cell` is `char` + two `Color` enums +
`Flags` + `Osc133CellType` + `Option<Arc<CellExtra>>` (`patches/…/term/cell.rs:154-162`)
— on the order of 32 B on a 64-bit target (derived from the field types; **not**
measured with `size_of`). At 10,050 rows × 200 columns that is roughly **60 MB of
cell data touched per reflow**, single-threaded, with the IPC pump and the PTY
reader both blocked behind it.

**The split-divider drag is not the trigger.** The `ResizeObserver` callback is a
*resettable trailing* debounce (`CanvasTerminal.tsx:2029-2032`, 100 ms), so a
continuous drag never reaches `remeasure()`; and `remeasure` only invokes
`resize_pty` when the derived cell grid actually changed
(`:422-438`). A smooth 60 fps drag therefore costs **one** reflow, on release.
What does bite:

- a **slow** drag with pauses >100 ms crossing many cell-width boundaries — one
  full reflow per pause that changes `cols`;
- **tab switching after a window resize**: hidden panes are `display:none`, so
  their `remeasure()` returns at `rect.width <= 0` (`:357`) and they never
  resize while hidden. The IntersectionObserver's hidden→visible path calls
  `remeasure()` (`:2051`), so the reflow is paid at switch time, on the click,
  once per background tab — a per-tab-switch stall proportional to that tab's
  scrollback.

### F99 — keystroke-path micro-costs, and the browser write queue caps typing at one character per round trip (P3)

Three small things on the same path, grouped because each is a one-line fix.

**`detectPlatform()` is not memoised.** `src/platform.ts:11-27` reads
`navigator.platform`, calls `.toLowerCase()` (a fresh string) and runs up to
three substring searches — on **every** call. A single printable keystroke in a
terminal calls it four times: `isMacOS()` at `CanvasTerminal.tsx:2345`,
`isWindows()` at `:2359`, `isMacOS()` at `:2410` and `:2434`. The value cannot
change for the lifetime of the page.

**`keyToSequence` allocates its lookup table inside the hot path.** The
`ctrlPunct` object literal is constructed inside the function body on every
Ctrl+key press (`terminalInput.ts:95-102`), unlike `ARROW_SUFFIX`, `F_KEYS` and
`NAV_KEYS`, which are correctly module-level. `String.fromCharCode` on the
`a`-`z` fast path (`:93`) returns before it, so plain Emacs bindings are
unaffected; Ctrl+`[`/`]`/`\` etc. pay it.

**Browser/PWA typing is serialised on the round trip.** `rpc()` routes
`write_pty` through `queuedWrite` whenever `!isTauri()` or a `connectionId` is
set (`src/transport.ts:2024-2029`), and `queuedWrite` (`:2000-2014`) chains each
call onto the previous promise. The rationale in the doc comment is correct —
parallel POSTs can reorder and scramble typed text — but the mechanism makes the
achievable typing rate exactly `1 / RTT`. On loopback that is invisible; over a
relay or tunnel at 100 ms RTT it is **10 characters per second**, with the
keystrokes queueing in the browser rather than in the PTY. Ordering could be
preserved with a per-session sequence number the server orders on, or by
coalescing everything queued behind the in-flight write into one body, without
paying a serial round trip per character.

---

## Not covered by chunk 3b

- **`useKeyboardShortcuts` and the always-on document keydown listeners**
  (`modalStack.ts:39` capture-phase, `userActivity.ts:30`, `dragDrop.ts:108-109`,
  `TickerArea.tsx:23`). They run on terminal keystrokes that the terminal handler
  does not `stopPropagation` (the kitty, Shift+Enter, Shift+Tab and Alt paths
  call only `preventDefault`); capture-phase listeners run regardless. Counted,
  not opened — closer to chunk 4's area.
- **The durable-log capture path** (`VtLogBuffer::process` →
  `read_scrollback_log_lines` → `extract_log_line`, `terminal_grid.rs:965`,
  `:850`). It runs per chunk under the vt lock and allocates spans per scrolled
  line; it is proportional to output rather than to history, and it is chunk 1/2
  territory (`pty-output` / log ring), so it was read only far enough to confirm
  that.
- **`terminal_search_buffer`, `enumerate_visible_hyperlinks`,
  `extract_semantic_zones`, `get_block_rows`, `grid_get_lines`** — grid readers
  reached only from HTTP/MCP routes, not from the desktop terminal loop. Signature
  and lock shape checked (they are all sync commands, so F95 covers them); their
  callers were not traced.
- **Mobile input** (`src/mobile/components/CommandInput.tsx`, `TerminalKeybar`,
  `SlashMenuOverlay`) — a separate write path with its own `retryWrite` wrapper.
  Only noted as further `write_pty` callers.
- **The touch handler's momentum loop against the backend** — `onScrollPixels` →
  `handleScrollDelta` → the coalesced `terminal_scroll_to_offset` path, which
  chunk 3 already traced from the wheel side.
- **No profiler was run.** The only measured values in this chunk are the live
  session count (12), the `spawn_blocking` site count (210), and the constants
  read out of source. Every byte count, syscall count and event rate is an
  estimate derived from the code and labelled as such at its use site.

---

## Open questions

- **How common is `mouseMode >= 2` on a *background* tab in Boss's real usage?**
  F90's write amplification is proportional to it and to nothing else. It needs
  one `mouseMode` sample across the 12 live sessions to size; that requires
  reading each session's frame flags, which I could not do without subscribing to
  their grid channels — out of bounds for a read-only pass on the live instance.
- **Does `linkThrottle`'s trailing debounce ever coalesce in practice?**
  `CanvasTerminal.tsx:2666-2670` resets on every `mousemove`, so a continuously
  moving mouse fires zero probes and a *stopping* mouse fires exactly one per
  terminal. Deliberate movement with sub-100 ms pauses is the bad case, and I did
  not establish how often that shape occurs.
- **Is `terminal_search`'s `RegexSearch` actually expensive to rebuild, relative
  to the scan?** F93 asserts both costs; the scan is clearly O(history × cols),
  but four lazy-DFA/NFA builds for a short literal may be microseconds. Worth
  measuring before deciding whether the cache or the throttle is the fix — they
  are independent.
- **F98's reflow figure assumes a full 10,000-row history.** A session that never
  filled the scrollback pays proportionally less, and an alt-screen agent gets
  `ReflowMode::None` (`term/mod.rs:840-843`) so it pays nothing. What fraction of
  real sessions carry a deep primary-screen history at resize time was not
  established — the same open question chunk 3 F24 left.
- **Does `write_pty`'s `spawn_blocking` add measurable latency versus running the
  write on the async runtime?** The task hop exists to keep the blocking PTY write
  off a runtime worker, which is correct, but it also means a keystroke waits for
  a pool thread to be scheduled. Under the pool saturation that 210 `spawn_blocking`
  sites can produce (a content-index build, a batch of `git` calls), that wait is
  unbounded and would be invisible in the existing `write_pty SLOW` warning
  (`pty.rs:7753-7756`) — which starts its clock *after* the hop, at `:7742`.
  Filed as a question, not a finding: I did not observe it.
